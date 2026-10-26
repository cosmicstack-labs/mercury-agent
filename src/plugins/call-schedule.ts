/**
 * Scheduled calls: "call me at 9pm about the deploy", reliably.
 *
 * A call is a precise action, not something an AI turn has to remember to do:
 * at the time, Mercury rings the owner (the channel plugin's call_owner tool)
 * with the topic as the opener. No answer → one retry after 5 minutes → a
 * chat message. Times are worked out here, in the host's timezone, and every
 * schedule is confirmed with the exact time, so a misunderstanding shows up
 * immediately rather than at 9pm.
 *
 * Saved to <plugin dir>/scheduled-calls.json, so calls survive restarts; one
 * that came due while Mercury was down is placed when it's back (up to 2h
 * late), otherwise the owner gets a "missed" note.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import { pluginDir, writeJsonAtomic } from './store.js';
import { listLiveTools } from './tool-bridge.js';

export interface ScheduledCall {
  id: string;
  at: string;
  topic: string;
  createdAt: string;
  attempts: number;
}

const RETRY_MS = 5 * 60_000;
const MAX_LATE_MS = 2 * 3600_000;
const MAX_AHEAD_MS = 30 * 24 * 3600_000;

// ── time parsing ──────────────────────────────────────────────────────────

/**
 * When to call, from what people actually say: "in 10 minutes", "10m",
 * "9pm", "9:30 pm", "21:00", "at 9", "after 9 PM", "tonight at 8",
 * "tomorrow 8:30am", "now", or an ISO date-time. A bare hour means the next
 * time that hour comes round (9 at 14:00 → 21:00 today).
 */
export function parseWhen(input: string, now = new Date()): Date | null {
  const t = input.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.,!]+$/g, '');
  if (!t) return null;
  if (/^(now|right now|immediately|asap)$/.test(t)) return new Date(now.getTime() + 5_000);

  const rel = /^(?:in |after )?(\d+(?:\.\d+)?) ?(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?)(?: from now)?$/.exec(t)
    ?? /^(?:in|after) (an?|half an?) (minute|hour)$/.exec(t);
  if (rel) {
    const n = rel[1] === 'a' || rel[1] === 'an' ? 1 : rel[1].startsWith('half') ? 0.5 : Number(rel[1]);
    const unit = rel[2][0];
    const ms = unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3600_000;
    return new Date(now.getTime() + n * ms);
  }

  if (/^\d{4}-\d{2}-\d{2}t/.test(t)) {
    const d = new Date(input.trim());
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const m = /^(?:(today|tonight|this evening|this morning|tomorrow)(?: at)? )?(?:(?:at|after|around|by) )?(\d{1,2})(?:[:.](\d{2}))? ?(am|pm|a\.m|p\.m)?(?: (today|tonight|tomorrow))?$/.exec(t);
  if (!m) return null;
  const day = m[1] ?? m[5];
  let hour = Number(m[2]);
  const minute = m[3] ? Number(m[3]) : 0;
  const ampm = m[4]?.startsWith('p') ? 'pm' : m[4]?.startsWith('a') ? 'am' : undefined;
  if (hour > 23 || minute > 59 || (ampm && (hour < 1 || hour > 12))) return null;
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  const evening = day === 'tonight' || day === 'this evening';

  const at = (base: Date, h: number) => {
    const d = new Date(base);
    d.setHours(h, minute, 0, 0);
    return d;
  };
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);

  if (day === 'tomorrow') {
    if (ampm || hour > 12 || hour === 0) return at(tomorrow, hour);
    return at(tomorrow, hour < 7 ? hour + 12 : hour); // "tomorrow 8" means 8am, "tomorrow 3" 3pm
  }
  // Explicit 24h time or am/pm: today if still ahead, otherwise tomorrow.
  if (ampm || hour > 12 || hour === 0 || evening) {
    const h = evening && hour < 12 ? hour + 12 : hour;
    const d = at(now, h);
    return d.getTime() > now.getTime() ? d : at(tomorrow, h);
  }
  // A bare 1–12: whichever of h:00 / (h+12):00 comes next.
  const options = [at(now, hour), at(now, hour === 12 ? 12 : hour + 12), at(tomorrow, hour), at(tomorrow, hour === 12 ? 12 : hour + 12)];
  return options.filter((d) => d.getTime() > now.getTime()).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
}

/** "9:00 PM tonight (in 2 h 14 m)", "8:30 AM tomorrow (Thu 23 Oct)". */
export function describeTime(at: Date, now = new Date()): string {
  const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const sameDay = at.toDateString() === now.toDateString();
  const tmr = new Date(now);
  tmr.setDate(now.getDate() + 1);
  const day = sameDay ? (at.getHours() >= 17 ? 'tonight' : 'today') : at.toDateString() === tmr.toDateString() ? 'tomorrow' : at.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  const mins = Math.max(0, Math.round((at.getTime() - now.getTime()) / 60_000));
  const rel = mins < 1 ? 'in a moment' : mins < 60 ? `in ${mins} min` : mins < 24 * 60 ? `in ${Math.floor(mins / 60)} h${mins % 60 ? ` ${mins % 60} m` : ''}` : '';
  const tz = Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(at).find((p) => p.type === 'timeZoneName')?.value;
  return `${time}${tz ? ` ${tz}` : ''} ${day}${rel ? ` (${rel})` : ''}`;
}

// ── scheduler ─────────────────────────────────────────────────────────────

export class CallScheduler {
  private calls: ScheduledCall[] = [];
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private seq = 0;

  constructor(
    private readonly pluginId: string,
    /** Send the owner a chat message (missed call notes). */
    private readonly message: (text: string) => Promise<void>,
  ) {}

  private file(): string {
    return join(pluginDir(this.pluginId), 'scheduled-calls.json');
  }

  start(): void {
    try {
      const raw = existsSync(this.file()) ? (JSON.parse(readFileSync(this.file(), 'utf8')) as ScheduledCall[]) : [];
      this.calls = Array.isArray(raw) ? raw.filter((c) => c && typeof c.at === 'string' && typeof c.id === 'string') : [];
    } catch {
      this.calls = [];
    }
    const now = Date.now();
    for (const c of [...this.calls]) {
      const due = Date.parse(c.at);
      if (due < now - MAX_LATE_MS) {
        this.remove(c.id);
        void this.message(`📞 I missed the call I'd scheduled for ${describeTime(new Date(due))} about "${c.topic}" (Mercury wasn't running). Say /call now to ring you now.`).catch(() => {});
      } else {
        this.arm(c);
      }
    }
    this.save();
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  list(): ScheduledCall[] {
    return [...this.calls].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  }

  /** Schedule a call; returns the confirmation to show (or throws with a plain reason). */
  schedule(when: string, topic: string, now = new Date()): { call: ScheduledCall; confirmation: string } {
    const at = parseWhen(when, now);
    if (!at) throw new Error(`I couldn't work out when "${when}" is. Try "9pm", "in 20 minutes" or "tomorrow 8:30am".`);
    if (at.getTime() - now.getTime() > MAX_AHEAD_MS) throw new Error('That\'s more than 30 days away; pick a closer time.');
    const call: ScheduledCall = {
      id: `c${Date.now().toString(36)}${(++this.seq).toString(36)}`,
      at: at.toISOString(),
      topic: topic.trim().slice(0, 300) || 'checking in',
      createdAt: now.toISOString(),
      attempts: 0,
    };
    this.calls.push(call);
    this.arm(call);
    this.save();
    return { call, confirmation: `✅ I'll call you at ${describeTime(at, now)}${call.topic !== 'checking in' ? ` about ${call.topic}` : ''}.` };
  }

  /** Cancel by id, by list number (1-based), or "all". Returns how many were cancelled. */
  cancel(which: string): number {
    const list = this.list();
    const targets = which === 'all' ? list : list.filter((c, i) => c.id === which || String(i + 1) === which);
    for (const c of targets) this.remove(c.id);
    this.save();
    return targets.length;
  }

  private remove(id: string): void {
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
    this.calls = this.calls.filter((c) => c.id !== id);
  }

  private save(): void {
    try {
      mkdirSync(pluginDir(this.pluginId), { recursive: true });
      writeJsonAtomic(this.file(), this.calls);
    } catch (err) {
      logger.warn({ err }, 'Could not save scheduled calls');
    }
  }

  private arm(c: ScheduledCall): void {
    const existing = this.timers.get(c.id);
    if (existing) clearTimeout(existing);
    // Long waits are re-armed in steps (timers drift over days; Node caps at ~24.8 days).
    const wait = Math.max(0, Date.parse(c.at) - Date.now());
    const step = Math.min(wait, 6 * 3600_000);
    const t = setTimeout(() => {
      if (Date.parse(c.at) - Date.now() > 1000) { this.arm(c); return; }
      void this.place(c);
    }, step);
    t.unref?.();
    this.timers.set(c.id, t);
  }

  /** Ring the owner. One retry after 5 minutes if they don't pick up, then a message. */
  private async place(c: ScheduledCall): Promise<void> {
    this.timers.delete(c.id);
    const tool = listLiveTools().find((t) => t.pluginId === this.pluginId && t.name === 'call_owner');
    let outcome = '';
    if (!tool) {
      outcome = 'the WhatsApp plugin isn\'t running';
    } else {
      try {
        // Pre-approved: the owner scheduled this call themselves, and it can only ring them.
        const ac = new AbortController();
        const reason = `you asked me to call${c.topic !== 'checking in' ? ` about ${c.topic}` : ' you now'}`;
        outcome = String(await tool.invoke({ reason }, ac.signal));
      } catch (err) {
        outcome = `failed: ${(err as Error).message}`;
      }
    }
    if (outcome.startsWith('answered')) {
      this.remove(c.id);
      this.save();
      return;
    }
    c.attempts += 1;
    if (c.attempts < 2 && !/isn't running|Voice calls|need/.test(outcome)) {
      c.at = new Date(Date.now() + RETRY_MS).toISOString();
      this.arm(c);
      this.save();
      return;
    }
    this.remove(c.id);
    this.save();
    const why = /no_answer|declined|busy/.test(outcome) ? 'you didn\'t pick up' : outcome.replace(/^failed:\s*/, '').slice(0, 200);
    await this.message(`📞 I tried to call you${c.topic !== 'checking in' ? ` about ${c.topic}` : ''}, but ${why}. Say /call now when you're free, or just reply here.`).catch(() => {});
  }
}

// ── the active scheduler (one per running channel plugin with calls) ──────

const schedulers = new Map<string, CallScheduler>();

export function registerCallScheduler(pluginId: string, s: CallScheduler | null): void {
  const old = schedulers.get(pluginId);
  if (old && old !== s) old.stop();
  if (s) schedulers.set(pluginId, s);
  else schedulers.delete(pluginId);
}

export function activeCallScheduler(): CallScheduler | undefined {
  return schedulers.values().next().value;
}

// ── /call and /calls ──────────────────────────────────────────────────────

export const CALL_HELP = [
  'Usage:',
  '  /call 9pm about the deploy     call you then (also: in 20m, tomorrow 8:30am, tonight 8, now)',
  '  /calls                         list scheduled calls',
  '  /calls cancel 2 | all          cancel one (by number) or all',
].join('\n');

/** Handle "/call …" and "/calls …". Returns the reply text. */
export function handleCallCommand(trimmed: string, isMember: boolean): string {
  const s = activeCallScheduler();
  if (!s) return '📞 Calls need the WhatsApp plugin, linked and running. Set it up with /plugins install whatsapp.';
  if (isMember) return 'Only the owner can schedule calls.';
  const [cmd, ...rest] = trimmed.slice(1).split(/\s+/);
  const args = rest.join(' ').trim();
  if (cmd === 'calls') {
    if (/^cancel\b/i.test(args)) {
      const which = args.replace(/^cancel\s*/i, '').trim() || '';
      if (!which) return 'Which one? /calls cancel 1, or /calls cancel all.';
      const n = s.cancel(which.toLowerCase());
      return n ? `🗑 Cancelled ${n} call${n === 1 ? '' : 's'}.` : 'No scheduled call matches that. See /calls.';
    }
    const list = s.list();
    if (!list.length) return '📞 No calls scheduled. Try: /call 9pm about the deploy';
    return ['📞 Scheduled calls:', ...list.map((c, i) => `${i + 1}. ${describeTime(new Date(c.at))}: ${c.topic}`), '', 'Cancel with /calls cancel <number> or all.'].join('\n');
  }
  if (!args || args === 'help') return CALL_HELP;
  // "/call 9pm about the deploy", "/call in 20 minutes to review the PR", "/call now"
  const m = /^(.*?)(?:\s+(?:about|to|for|re|regarding|with)\s+(.+))?$/i.exec(args);
  const when = (m?.[1] ?? args).trim();
  const topic = (m?.[2] ?? '').trim();
  try {
    return s.schedule(when, topic).confirmation;
  } catch (err) {
    return `✗ ${(err as Error).message}`;
  }
}
