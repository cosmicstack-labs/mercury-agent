import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempHome } from '../plugins/test-fixtures.js';
import { _resetPresence, openLiveLink } from './presence.js';
import { ReachService } from './service.js';
import { listMissed } from './missed.js';
import { DEFAULT_REACH_SETTINGS, inQuietHours, mergeReachSettings, type ReachSettings } from './settings.js';
import type { DeviceSummary } from '../web/devices.js';

/**
 * Calls and notifications to the owner's phone (ADR-046): only over a live
 * connection, with the owner's limits, and with fallbacks that always leave
 * the owner something to see.
 */

const phone = (id: string, over: Partial<DeviceSummary['reach']> = {}): DeviceSummary => ({
  id, name: `Phone ${id}`, platform: 'ios', createdAt: '', lastSeenAt: null, expiresAt: null,
  reach: { platform: 'ios', appVersion: '1.0', ring: true, notify: true, capabilities: ['callkit'], updatedAt: '', ...over },
});

interface Sent { device: string; event: string; data: Record<string, unknown> }

function live(id: string, sent: Sent[]): () => void {
  return openLiveLink(id, (event, data) => { sent.push({ device: id, event, data: data as Record<string, unknown> }); });
}

describe('ReachService', () => {
  let env: ReturnType<typeof tempHome>;
  let sent: Sent[];
  let settings: ReachSettings;
  let phones: DeviceSummary[];
  let now: number;

  beforeEach(() => {
    env = tempHome();
    _resetPresence();
    sent = [];
    settings = DEFAULT_REACH_SETTINGS;
    phones = [phone('aaaa0001'), phone('aaaa0002')];
    now = new Date(2026, 10, 18, 14, 0).getTime();
  });
  afterEach(() => { vi.useRealTimers(); _resetPresence(); env.restore(); });

  const make = (more: ConstructorParameters<typeof ReachService>[0] = {}) => new ReachService({
    now: () => now, settings: () => settings, phones: () => phones, ringTimeoutMs: 1000, ...more,
  });

  describe('choosing how to reach the owner', () => {
    it('rings every live phone that is set to ring, and only those', async () => {
      live('aaaa0001', sent);
      phones.push(phone('aaaa0003', { ring: false }));
      live('aaaa0003', sent);
      const s = make();
      const p = s.callOwner({ reason: 'the deploy failed' });
      await Promise.resolve();
      const rings = sent.filter((e) => e.event === 'ring');
      expect(rings.map((e) => e.device)).toEqual(['aaaa0001']);
      expect(rings[0].data).toMatchObject({ caller: 'Mercury', reason: 'the deploy failed', urgency: 'normal' });
      expect(s.report('aaaa0001', String(rings[0].data.id), 'answered')).toEqual({ ok: true, state: 'answered' });
      const r = await p;
      expect(r).toMatchObject({ outcome: 'answered', via: 'app', deviceId: 'aaaa0001' });
      expect(r.text).toMatch(/^answered: the owner picked up on Phone aaaa0001/);
    });

    it('falls back to WhatsApp when no phone is live', async () => {
      const wa = vi.fn(async () => 'answered: the owner picked up and the call is in progress.');
      const s = make({ whatsappCall: () => wa });
      const r = await s.callOwner({ reason: 'server down' });
      expect(wa).toHaveBeenCalledWith('server down');
      expect(r).toMatchObject({ outcome: 'answered', via: 'whatsapp' });
      expect(sent).toEqual([]);
    });

    it('with no live phone and no WhatsApp, schedules the one retry instead of calling again', async () => {
      const retry = vi.fn();
      const s = make({ scheduleRetry: retry });
      const r = await s.callOwner({ reason: 'server down' });
      expect(r.outcome).toBe('no_phone');
      expect(retry).toHaveBeenCalledWith('server down');
      expect(r.text).toMatch(/try once more in 5 minutes/);
    });

    it('without a scheduler (or for the last attempt) leaves a missed-call note and messages the owner', async () => {
      const messages: string[] = [];
      const s = make({ messageOwner: async (t) => { messages.push(t); } });
      const r = await s.callOwner({ reason: 'server down' });
      expect(r.outcome).toBe('no_phone');
      expect(listMissed()).toMatchObject([{ kind: 'call', title: 'Missed call from Mercury', body: 'server down' }]);
      expect(messages[0]).toMatch(/I tried to call you about server down/);
    });

    it('scheduled attempts (followUp off) leave the retry and the note to the scheduler', async () => {
      const retry = vi.fn();
      const s = make({ scheduleRetry: retry });
      const r = await s.callOwner({ reason: 'x', followUp: false, source: 'scheduled' });
      expect(r.outcome).toBe('no_phone');
      expect(retry).not.toHaveBeenCalled();
      expect(listMissed()).toEqual([]);
    });
  });

  describe('a ring', () => {
    it('times out as no_answer and then tries WhatsApp', async () => {
      vi.useFakeTimers();
      live('aaaa0001', sent);
      const wa = vi.fn(async () => 'no_answer: the owner did not pick up. Send them a message instead.');
      const retry = vi.fn();
      const s = make({ whatsappCall: () => wa, scheduleRetry: retry });
      const p = s.callOwner({ reason: 'r' });
      await vi.advanceTimersByTimeAsync(1001);
      const r = await p;
      expect(r.outcome).toBe('no_answer');
      expect(wa).toHaveBeenCalled();
      expect(retry).toHaveBeenCalled();
      expect(sent.filter((e) => e.event === 'ring_end').map((e) => e.data.outcome)).toEqual(['missed']);
    });

    it('a decline is the owner\'s answer: no WhatsApp, no retry, a note in the app', async () => {
      live('aaaa0001', sent);
      const wa = vi.fn(async () => 'answered');
      const retry = vi.fn();
      const s = make({ whatsappCall: () => wa, scheduleRetry: retry });
      const p = s.callOwner({ reason: 'r' });
      await Promise.resolve();
      s.report('aaaa0001', String(sent[0].data.id), 'declined');
      const r = await p;
      expect(r.outcome).toBe('declined');
      expect(wa).not.toHaveBeenCalled();
      expect(retry).not.toHaveBeenCalled();
      expect(listMissed()[0].title).toMatch(/declined/);
    });

    it('stops the other phones when one answers', async () => {
      live('aaaa0001', sent);
      live('aaaa0002', sent);
      const s = make();
      const p = s.callOwner({ reason: 'r' });
      await Promise.resolve();
      const id = String(sent[0].data.id);
      s.report('aaaa0002', id, 'answered');
      await p;
      expect(sent.filter((e) => e.event === 'ring_end')).toEqual([{ device: 'aaaa0001', event: 'ring_end', data: { id, outcome: 'answered_elsewhere' } }]);
      // Too late for the first phone.
      expect(s.report('aaaa0001', id, 'answered')).toMatchObject({ ok: false, status: 409 });
      // Answering twice from the same phone is fine.
      expect(s.report('aaaa0002', id, 'answered')).toEqual({ ok: true, state: 'answered' });
    });

    it('ends as missed once every phone reported missed, before the timeout', async () => {
      live('aaaa0001', sent);
      live('aaaa0002', sent);
      const s = make();
      const p = s.callOwner({ reason: 'r', followUp: false });
      await Promise.resolve();
      const id = String(sent[0].data.id);
      s.report('aaaa0001', id, 'missed');
      expect(s.getInvite(id)?.state).toBe('ringing');
      s.report('aaaa0002', id, 'missed');
      expect((await p).outcome).toBe('no_answer');
    });

    it('only a phone the ring went to can report it', async () => {
      live('aaaa0001', sent);
      const s = make();
      const p = s.callOwner({ reason: 'r', deviceIds: ['aaaa0001'], followUp: false });
      await Promise.resolve();
      const id = String(sent[0].data.id);
      expect(s.report('aaaa0002', id, 'answered')).toMatchObject({ ok: false, status: 404 });
      expect(s.report('aaaa0001', 'nope', 'answered')).toMatchObject({ ok: false, status: 404 });
      s.report('aaaa0001', id, 'declined');
      await p;
    });

    it('gives the voice session the reason only for the phone that answered', async () => {
      live('aaaa0001', sent);
      live('aaaa0002', sent);
      const s = make();
      const p = s.callOwner({ reason: 'the build broke', opener: 'Your build broke at step 3' });
      await Promise.resolve();
      const id = String(sent[0].data.id);
      // Starting the session counts as answering when the report hasn't arrived yet.
      expect(s.answeredInvite('aaaa0001', id)?.opener).toBe('Your build broke at step 3');
      expect(s.answeredInvite('aaaa0002', id)).toBeNull();
      expect((await p).outcome).toBe('answered');
    });
  });

  describe('the owner\'s limits', () => {
    it('calls off → a notification instead', async () => {
      settings = mergeReachSettings(DEFAULT_REACH_SETTINGS, { calls: false });
      live('aaaa0001', sent);
      const r = await make().callOwner({ reason: 'r' });
      expect(r).toMatchObject({ outcome: 'disabled', via: 'notification' });
      expect(sent.map((e) => e.event)).toEqual(['notify']);
      expect(sent[0].data).toMatchObject({ kind: 'missed-call', title: 'Mercury wanted to call you', body: 'r' });
    });

    it('below the urgency threshold → a notification', async () => {
      settings = mergeReachSettings(DEFAULT_REACH_SETTINGS, { minCallUrgency: 'high' });
      const r = await make().callOwner({ reason: 'r', urgency: 'normal' });
      expect(r.outcome).toBe('below_threshold');
      expect(listMissed()).toHaveLength(1);
    });

    it('quiet hours: only critical calls ring; notifications arrive silently', async () => {
      settings = mergeReachSettings(DEFAULT_REACH_SETTINGS, { quietHours: { enabled: true, start: '13:00', end: '15:00' } });
      live('aaaa0001', sent);
      const s = make();
      expect((await s.callOwner({ reason: 'r', urgency: 'high' })).outcome).toBe('quiet');
      expect(sent[0]).toMatchObject({ event: 'notify', data: { silent: true } });
      const p = s.callOwner({ reason: 'fire', urgency: 'critical' });
      await Promise.resolve();
      const ring = sent.find((e) => e.event === 'ring');
      expect(ring).toBeTruthy();
      s.report('aaaa0001', String(ring!.data.id), 'answered');
      expect((await p).outcome).toBe('answered');
    });

    it('rate-limits calls per rolling hour', async () => {
      settings = mergeReachSettings(DEFAULT_REACH_SETTINGS, { maxCallsPerHour: 2 });
      const s = make();
      expect((await s.callOwner({ reason: 'a', followUp: false })).outcome).toBe('no_phone');
      expect((await s.callOwner({ reason: 'b', followUp: false })).outcome).toBe('no_phone');
      expect((await s.callOwner({ reason: 'c', followUp: false })).outcome).toBe('rate_limited');
      now += 3600_001;
      expect((await s.callOwner({ reason: 'd', followUp: false })).outcome).toBe('no_phone');
    });

    it('a test ring ignores the limits and rings only the phone that asked', async () => {
      settings = mergeReachSettings(DEFAULT_REACH_SETTINGS, { calls: false, maxCallsPerHour: 0 });
      live('aaaa0001', sent);
      live('aaaa0002', sent);
      const s = make();
      const p = s.callOwner({ reason: 'test', source: 'test', deviceIds: ['aaaa0002'] });
      await Promise.resolve();
      expect(sent.map((e) => [e.device, e.event])).toEqual([['aaaa0002', 'ring']]);
      s.report('aaaa0002', String(sent[0].data.id), 'declined');
      expect((await p).outcome).toBe('declined');
      expect(listMissed()).toEqual([]);
    });
  });

  describe('notifications', () => {
    it('go to live phones that want them', async () => {
      live('aaaa0001', sent);
      phones.push(phone('aaaa0003', { notify: false }));
      live('aaaa0003', sent);
      const r = await make().notifyOwner({ title: 'Done', body: 'The report is ready', kind: 'result' });
      expect(r).toMatchObject({ outcome: 'delivered', devices: ['aaaa0001'] });
      expect(sent[0].data).toMatchObject({ title: 'Done', body: 'The report is ready', kind: 'result', silent: false });
    });

    it('wait for the app when no phone is live; urgent ones also go to the messaging channel', async () => {
      const messages: string[] = [];
      const s = make({ messageOwner: async (t) => { messages.push(t); } });
      expect((await s.notifyOwner({ title: 'FYI', body: 'b' })).outcome).toBe('queued');
      expect(messages).toEqual([]);
      await s.notifyOwner({ title: 'Disk full', body: 'b', urgency: 'high' });
      expect(messages).toEqual(['🔔 Disk full\nb']);
      expect(listMissed().map((m) => m.title)).toEqual(['FYI', 'Disk full']);
    });

    it('respect the off switch (except critical) and the hourly limit', async () => {
      settings = mergeReachSettings(DEFAULT_REACH_SETTINGS, { notifications: false, maxNotificationsPerHour: 1 });
      const s = make();
      expect((await s.notifyOwner({ title: 't', body: '' })).outcome).toBe('disabled');
      expect((await s.notifyOwner({ title: 't', body: '', urgency: 'critical' })).outcome).toBe('queued');
      expect((await s.notifyOwner({ title: 't', body: '', urgency: 'critical' })).outcome).toBe('rate_limited');
    });
  });
});

describe('reach settings', () => {
  it('keeps only valid values', () => {
    const s = mergeReachSettings(DEFAULT_REACH_SETTINGS, {
      calls: 'yes', maxCallsPerHour: 999, minCallUrgency: 'extreme', quietHours: { enabled: true, start: '25:00', end: '06:30' },
      triggers: { botNeedsYou: 'call', botFailed: 'shout' },
    });
    expect(s.calls).toBe(true);
    expect(s.maxCallsPerHour).toBe(20);
    expect(s.minCallUrgency).toBe('normal');
    expect(s.quietHours).toEqual({ enabled: true, start: '22:00', end: '06:30' });
    expect(s.triggers).toEqual({ botNeedsYou: 'call', botFailed: 'off', longTaskFailed: 'notify' });
  });

  it('quiet hours wrap midnight', () => {
    const s = mergeReachSettings(DEFAULT_REACH_SETTINGS, { quietHours: { enabled: true, start: '22:00', end: '07:00' } });
    const at = (h: number, m = 0) => new Date(2026, 10, 18, h, m);
    expect(inQuietHours(s, at(23))).toBe(true);
    expect(inQuietHours(s, at(3))).toBe(true);
    expect(inQuietHours(s, at(7))).toBe(false);
    expect(inQuietHours(s, at(21, 59))).toBe(false);
    expect(inQuietHours(DEFAULT_REACH_SETTINGS, at(23))).toBe(false);
  });
});
