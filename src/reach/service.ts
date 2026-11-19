/**
 * Mercury rings and notifies the owner's phone (ADR-046), over the phone's
 * LIVE connection only: a `ring` or `notify` event on the event stream the
 * Mercury app already has open. No push relay, no background service.
 *
 * Calls: the phone shows a real incoming call (CallKit on iOS, Telecom on
 * Android). Answer → the app starts the live voice call with the reason as
 * Mercury's opener; decline or a missed ring is reported back.
 *
 * Order when calling:
 *   1. the owner's settings: calls off, below the urgency threshold, quiet
 *      hours or over the hourly limit → a notification instead;
 *   2. every paired phone that is live and set to ring, at once (45 s);
 *   3. nobody live, or no answer → WhatsApp's call_owner when that plugin
 *      runs (and the owner allows it);
 *   4. still nobody → one retry after 5 minutes (the phone call scheduler,
 *      call-schedule.ts semantics);
 *   5. then a missed-call note: kept for the app to show when it next
 *      connects, plus a message on the owner's messaging channel.
 * A declined call is the owner's answer: no retry, just the missed note.
 */
import { randomBytes } from 'node:crypto';
import { logger } from '../utils/logger.js';
import { listPhones, type DeviceSummary } from '../web/devices.js';
import { isLive, sendToDevice } from './presence.js';
import { addMissed } from './missed.js';
import { inQuietHours, readReachSettings, urgencyRank, type ReachSettings, type Urgency } from './settings.js';

export type CallOutcome =
  | 'answered' | 'declined' | 'no_answer' | 'no_phone'
  | 'disabled' | 'below_threshold' | 'quiet' | 'rate_limited';

export interface CallResult {
  outcome: CallOutcome;
  via: 'app' | 'whatsapp' | 'notification' | 'none';
  deviceId?: string;
  inviteId?: string;
  /** A sentence for the agent (or the scheduler), starting with the outcome. */
  text: string;
}

export type ReachSource = 'agent' | 'scheduled' | 'trigger' | 'test';

export interface CallRequest {
  reason: string;
  /** What Mercury says first when the owner answers (defaults to the reason). */
  opener?: string;
  urgency?: Urgency;
  source?: ReachSource;
  /** Only these devices (Settings → test ring rings just the phone that asked). */
  deviceIds?: string[];
  /** Retry in 5 minutes and leave a missed-call note when nobody answers (default true). */
  followUp?: boolean;
}

export interface NotifyRequest {
  title: string;
  body: string;
  kind?: 'info' | 'alert' | 'reminder' | 'result' | 'missed-call';
  urgency?: Urgency;
  threadId?: string;
  source?: ReachSource;
}

export interface NotifyResult {
  outcome: 'delivered' | 'queued' | 'disabled' | 'rate_limited';
  devices: string[];
  text: string;
}

export interface CallInvite {
  id: string;
  reason: string;
  opener: string;
  urgency: Urgency;
  createdAt: number;
  expiresAt: number;
  deviceIds: string[];
  /** Devices that haven't reported yet. */
  pending: Set<string>;
  state: 'ringing' | 'answered' | 'declined' | 'missed';
  answeredBy?: string;
  resolve?: (r: { outcome: 'answered' | 'declined' | 'no_answer'; deviceId?: string }) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export interface ReachDeps {
  now?: () => number;
  /** How long a phone rings (45 s). */
  ringTimeoutMs?: number;
  settings?: () => ReachSettings;
  phones?: () => DeviceSummary[];
  /** WhatsApp's call_owner, when that plugin runs; null otherwise. */
  whatsappCall?: () => ((reason: string) => Promise<string>) | null;
  /** A message on the owner's messaging channel (Telegram, WhatsApp, Signal…). */
  messageOwner?: (text: string) => Promise<void>;
  /** Ring again in 5 minutes (the phone call scheduler). */
  scheduleRetry?: (reason: string) => void;
}

export const RING_TIMEOUT_MS = 45_000;
/** Answered invites are kept this long so the voice session can read the reason. */
const ANSWERED_KEEP_MS = 10 * 60_000;
const HOUR_MS = 3600_000;

export class ReachService {
  private invites = new Map<string, CallInvite>();
  private callTimes: number[] = [];
  private notifyTimes: number[] = [];

  constructor(private deps: ReachDeps = {}) {}

  setDeps(more: Partial<ReachDeps>): void {
    this.deps = { ...this.deps, ...more };
  }

  private now(): number { return this.deps.now?.() ?? Date.now(); }
  private settings(): ReachSettings { return this.deps.settings?.() ?? readReachSettings(); }

  /** Paired phones that want this kind of contact and are connected right now. */
  livePhones(kind: 'ring' | 'notify', only?: string[]): DeviceSummary[] {
    const phones = (this.deps.phones ?? listPhones)();
    return phones.filter((d) => (kind === 'ring' ? d.reach?.ring !== false : d.reach?.notify !== false)
      && (!only || only.includes(d.id)) && isLive(d.id));
  }

  private within(times: number[], max: number): boolean {
    const cutoff = this.now() - HOUR_MS;
    while (times.length && times[0] <= cutoff) times.shift();
    return times.length < max;
  }

  /** Ring the owner. Resolves once someone answers, declines, or the ring times out (and any fallback ran). */
  async callOwner(req: CallRequest): Promise<CallResult> {
    const reason = req.reason.trim().slice(0, 300) || 'checking in';
    const urgency = req.urgency ?? 'normal';
    const source = req.source ?? 'agent';
    const followUp = req.followUp !== false && source !== 'test';
    const s = this.settings();

    if (source !== 'test') {
      const downgrade = (outcome: CallOutcome, why: string): Promise<CallResult> =>
        this.notifyOwner({ title: 'Mercury wanted to call you', body: reason, kind: 'missed-call', urgency, source }).then((n) => ({
          outcome, via: n.outcome === 'delivered' || n.outcome === 'queued' ? 'notification' as const : 'none' as const,
          text: `${outcome}: not ringing (${why}); ${n.outcome === 'delivered' || n.outcome === 'queued' ? 'sent a notification instead' : 'and the notification could not be sent either'}.`,
        }));
      if (!s.calls) return downgrade('disabled', 'the owner turned calls from Mercury off');
      if (urgencyRank(urgency) < urgencyRank(s.minCallUrgency)) return downgrade('below_threshold', `urgency ${urgency} is below the owner's threshold (${s.minCallUrgency})`);
      if (inQuietHours(s, new Date(this.now())) && urgencyRank(urgency) < urgencyRank(s.quietHoursCallUrgency)) return downgrade('quiet', 'it is the owner\'s quiet hours');
      if (!this.within(this.callTimes, s.maxCallsPerHour)) return downgrade('rate_limited', `already called ${this.callTimes.length} times in the last hour, the limit is ${s.maxCallsPerHour}`);
      this.callTimes.push(this.now());
    }

    const live = this.livePhones('ring', req.deviceIds);
    let result: CallResult | null = null;
    if (live.length) {
      const rung = await this.ring(live.map((d) => d.id), reason, req.opener, urgency);
      if (rung.outcome === 'answered') {
        const name = live.find((d) => d.id === rung.deviceId)?.name ?? 'their phone';
        return { outcome: 'answered', via: 'app', deviceId: rung.deviceId, inviteId: rung.inviteId, text: `answered: the owner picked up on ${name} and the live call is starting. They'll hear why you called.` };
      }
      if (rung.outcome === 'declined') {
        if (followUp) addMissed({ kind: 'call', title: 'You declined a call from Mercury', body: reason, urgency });
        return { outcome: 'declined', via: 'app', inviteId: rung.inviteId, text: 'declined: the owner declined the call. Don\'t call again about this; send a message if it still matters.' };
      }
      result = { outcome: 'no_answer', via: 'app', inviteId: rung.inviteId, text: 'no_answer: the phone rang but nobody picked up.' };
    }
    if (source === 'test') return result ?? { outcome: 'no_phone', via: 'none', text: 'no_phone: this phone isn\'t connected to Mercury right now.' };

    // The owner's other way to be rung.
    const wa = s.fallback.whatsapp ? this.deps.whatsappCall?.() ?? null : null;
    if (wa) {
      try {
        const out = String(await wa(reason));
        if (out.startsWith('answered')) return { outcome: 'answered', via: 'whatsapp', text: out };
        result = { outcome: out.startsWith('declined') ? 'declined' : 'no_answer', via: 'whatsapp', text: `${out.startsWith('declined') ? 'declined' : 'no_answer'}: ${result ? 'the Mercury app and ' : ''}WhatsApp rang but the owner didn't pick up.` };
        if (result.outcome === 'declined') {
          if (followUp) addMissed({ kind: 'call', title: 'You declined a call from Mercury', body: reason, urgency });
          return result;
        }
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'WhatsApp call fallback failed');
      }
    }
    result ??= { outcome: 'no_phone', via: 'none', text: 'no_phone: no phone with the Mercury app is connected right now.' };

    if (followUp && this.deps.scheduleRetry) {
      this.deps.scheduleRetry(reason);
      return { ...result, text: `${result.text} Mercury will try once more in 5 minutes, then leave a missed-call note. Don't call again yourself.` };
    }
    if (followUp) await this.missedCall(reason, urgency);
    return { ...result, text: `${result.text} A missed-call note was left for the owner.` };
  }

  /** Nobody answered, retries done: a note for the app's next visit, and a message on their channel. */
  async missedCall(reason: string, urgency: Urgency = 'normal'): Promise<void> {
    addMissed({ kind: 'call', title: 'Missed call from Mercury', body: reason, urgency });
    const s = this.settings();
    if (s.fallback.message) {
      await this.deps.messageOwner?.(`📞 I tried to call you${reason !== 'checking in' ? ` about ${reason}` : ''}, but you didn't pick up. Reply here, or open Mercury, when you're free.`).catch(() => {});
    }
  }

  async notifyOwner(req: NotifyRequest): Promise<NotifyResult> {
    const urgency = req.urgency ?? 'normal';
    const s = this.settings();
    if (!s.notifications && urgency !== 'critical') return { outcome: 'disabled', devices: [], text: 'disabled: the owner turned notifications from Mercury off.' };
    if (!this.within(this.notifyTimes, s.maxNotificationsPerHour)) {
      return { outcome: 'rate_limited', devices: [], text: `rate_limited: already sent ${this.notifyTimes.length} notifications in the last hour (limit ${s.maxNotificationsPerHour}).` };
    }
    this.notifyTimes.push(this.now());
    const title = req.title.trim().slice(0, 120) || 'Mercury';
    const body = req.body.trim().slice(0, 1000);
    const live = this.livePhones('notify');
    const event = {
      id: `n${randomBytes(6).toString('hex')}`,
      title, body, kind: req.kind ?? 'info', urgency,
      ...(req.threadId ? { threadId: req.threadId } : {}),
      silent: inQuietHours(s, new Date(this.now())) && urgency !== 'critical',
      at: new Date(this.now()).toISOString(),
    };
    const got = live.filter((d) => sendToDevice(d.id, 'notify', event) > 0).map((d) => d.id);
    if (got.length) return { outcome: 'delivered', devices: got, text: `delivered: shown on ${got.length} phone${got.length === 1 ? '' : 's'}.` };
    addMissed({ kind: req.kind === 'missed-call' ? 'call' : 'notification', title, body, urgency, ...(req.threadId ? { threadId: req.threadId } : {}) });
    if (urgencyRank(urgency) >= urgencyRank('high') && s.fallback.message) {
      await this.deps.messageOwner?.(`🔔 ${title}${body ? `\n${body}` : ''}`).catch(() => {});
    }
    return { outcome: 'queued', devices: [], text: 'queued: no phone is connected now; the app shows it when it next opens.' };
  }

  // ── ringing ─────────────────────────────────────────────────────────────

  private ring(deviceIds: string[], reason: string, opener: string | undefined, urgency: Urgency): Promise<{ outcome: 'answered' | 'declined' | 'no_answer'; deviceId?: string; inviteId: string }> {
    const now = this.now();
    const timeout = this.deps.ringTimeoutMs ?? RING_TIMEOUT_MS;
    const invite: CallInvite = {
      id: `r${randomBytes(8).toString('hex')}`,
      reason,
      opener: (opener ?? '').trim().slice(0, 500) || reason,
      urgency,
      createdAt: now,
      expiresAt: now + timeout,
      deviceIds,
      pending: new Set(deviceIds),
      state: 'ringing',
    };
    this.invites.set(invite.id, invite);
    this.prune();
    return new Promise((resolve) => {
      invite.resolve = (r) => resolve({ ...r, inviteId: invite.id });
      const payload = { id: invite.id, caller: 'Mercury', reason, urgency, at: new Date(now).toISOString(), expiresAt: new Date(invite.expiresAt).toISOString() };
      for (const id of deviceIds) sendToDevice(id, 'ring', payload);
      invite.timer = setTimeout(() => this.finish(invite, 'missed'), timeout);
      invite.timer.unref?.();
    });
  }

  private finish(invite: CallInvite, state: 'answered' | 'declined' | 'missed', deviceId?: string): void {
    if (invite.state !== 'ringing') return;
    invite.state = state;
    if (invite.timer) clearTimeout(invite.timer);
    if (state === 'answered') invite.answeredBy = deviceId;
    // Stop the other phones ringing.
    for (const id of invite.deviceIds) {
      if (id !== deviceId || state === 'missed') sendToDevice(id, 'ring_end', { id: invite.id, outcome: state === 'answered' ? 'answered_elsewhere' : state });
    }
    invite.resolve?.({ outcome: state === 'missed' ? 'no_answer' : state, ...(deviceId ? { deviceId } : {}) });
    invite.resolve = undefined;
  }

  /** A phone reports what happened to a ring. Only a device the ring went to can answer it. */
  report(deviceId: string, inviteId: string, outcome: 'answered' | 'declined' | 'missed'): { ok: true; state: CallInvite['state'] } | { ok: false; status: 404 | 409; error: string } {
    const invite = this.invites.get(inviteId);
    if (!invite || !invite.deviceIds.includes(deviceId)) return { ok: false, status: 404, error: 'No such call.' };
    if (invite.state !== 'ringing') {
      // Answering twice (the app retrying) is fine; anything else is too late.
      if (invite.state === 'answered' && invite.answeredBy === deviceId && outcome === 'answered') return { ok: true, state: invite.state };
      return { ok: false, status: 409, error: `That call already ended (${invite.state === 'answered' ? 'answered elsewhere' : invite.state}).` };
    }
    if (outcome === 'missed') {
      invite.pending.delete(deviceId);
      if (!invite.pending.size) this.finish(invite, 'missed');
      return { ok: true, state: invite.state };
    }
    this.finish(invite, outcome, deviceId);
    return { ok: true, state: invite.state };
  }

  /**
   * The reason a live voice session starts with, when a phone answers a ring:
   * only for the device that answered it (starting the session counts as
   * answering, if the app's report hasn't arrived yet).
   */
  answeredInvite(deviceId: string, inviteId: string): CallInvite | null {
    const invite = this.invites.get(inviteId);
    if (!invite || !invite.deviceIds.includes(deviceId)) return null;
    if (invite.state === 'ringing') this.finish(invite, 'answered', deviceId);
    if (invite.state !== 'answered' || invite.answeredBy !== deviceId) return null;
    if (this.now() - invite.createdAt > ANSWERED_KEEP_MS) return null;
    return invite;
  }

  getInvite(id: string): CallInvite | undefined {
    return this.invites.get(id);
  }

  private prune(): void {
    const cutoff = this.now() - ANSWERED_KEEP_MS;
    for (const [id, inv] of this.invites) if (inv.state !== 'ringing' && inv.createdAt < cutoff) this.invites.delete(id);
  }

  /** Stop every ring (shutdown). */
  dispose(): void {
    for (const inv of this.invites.values()) this.finish(inv, 'missed');
    this.invites.clear();
  }
}

let current: ReachService | null = null;

/** The process's reach service (made on first use). */
export function reachService(): ReachService {
  current ??= new ReachService();
  return current;
}

/** Test hook. */
export function _setReachService(s: ReachService | null): void {
  current?.dispose();
  current = s;
}
