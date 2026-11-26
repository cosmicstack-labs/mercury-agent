/**
 * The owner's settings for calls and notifications from Mercury (ADR-046):
 * Settings → Calls from Mercury in the apps, `~/.mercury/reach/settings.json`.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getMercuryHome } from '../utils/config.js';

export const URGENCIES = ['low', 'normal', 'high', 'critical'] as const;
export type Urgency = (typeof URGENCIES)[number];

export const TRIGGER_ACTIONS = ['off', 'notify', 'call'] as const;
export type TriggerAction = (typeof TRIGGER_ACTIONS)[number];

/** Things going wrong that can reach the owner without anyone asking. */
export interface ReachTriggers {
  /** A bot's run failed for good or is waiting on the owner (its Needs-you card). */
  botNeedsYou: TriggerAction;
  /** A bot said it couldn't do its job. */
  botFailed: TriggerAction;
  /** A background task that ran for 10 minutes or more failed or timed out. */
  longTaskFailed: TriggerAction;
}

export interface ReachSettings {
  /** Mercury may ring the owner's phone. */
  calls: boolean;
  /** Mercury may send the owner notifications. */
  notifications: boolean;
  /** No ringing in these hours (local time, may wrap midnight); notifications arrive silently. */
  quietHours: { enabled: boolean; start: string; end: string };
  /** A call below this urgency becomes a notification. */
  minCallUrgency: Urgency;
  /** During quiet hours, only calls at this urgency or above ring. */
  quietHoursCallUrgency: Urgency;
  /** Calls per rolling hour (a looping task must never spam the owner). */
  maxCallsPerHour: number;
  /** Notifications per rolling hour. */
  maxNotificationsPerHour: number;
  triggers: ReachTriggers;
  /** When no phone is live or nobody answers: try the owner's other channels. */
  fallback: { whatsapp: boolean; message: boolean };
}

export const DEFAULT_REACH_SETTINGS: ReachSettings = {
  calls: true,
  notifications: true,
  quietHours: { enabled: false, start: '22:00', end: '07:00' },
  minCallUrgency: 'normal',
  quietHoursCallUrgency: 'critical',
  maxCallsPerHour: 4,
  maxNotificationsPerHour: 30,
  triggers: { botNeedsYou: 'notify', botFailed: 'off', longTaskFailed: 'notify' },
  fallback: { whatsapp: true, message: true },
};

export function reachDir(): string {
  return join(getMercuryHome(), 'reach');
}

function settingsPath(): string {
  return join(reachDir(), 'settings.json');
}

export function urgencyRank(u: Urgency): number {
  return URGENCIES.indexOf(u);
}

export function asUrgency(v: unknown, fallback: Urgency = 'normal'): Urgency {
  return (URGENCIES as readonly unknown[]).includes(v) ? (v as Urgency) : fallback;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function bool(v: unknown, d: boolean): boolean {
  return typeof v === 'boolean' ? v : d;
}

function int(v: unknown, d: number, min: number, max: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, Math.round(v))) : d;
}

function trigger(v: unknown, d: TriggerAction): TriggerAction {
  return (TRIGGER_ACTIONS as readonly unknown[]).includes(v) ? (v as TriggerAction) : d;
}

/** Merge a partial update (from the app, or the file) onto a base, keeping only valid values. */
export function mergeReachSettings(base: ReachSettings, patch: unknown): ReachSettings {
  const p = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>;
  const q = (p.quietHours && typeof p.quietHours === 'object' ? p.quietHours : {}) as Record<string, unknown>;
  const t = (p.triggers && typeof p.triggers === 'object' ? p.triggers : {}) as Record<string, unknown>;
  const f = (p.fallback && typeof p.fallback === 'object' ? p.fallback : {}) as Record<string, unknown>;
  return {
    calls: bool(p.calls, base.calls),
    notifications: bool(p.notifications, base.notifications),
    quietHours: {
      enabled: bool(q.enabled, base.quietHours.enabled),
      start: typeof q.start === 'string' && HHMM.test(q.start) ? q.start : base.quietHours.start,
      end: typeof q.end === 'string' && HHMM.test(q.end) ? q.end : base.quietHours.end,
    },
    minCallUrgency: asUrgency(p.minCallUrgency, base.minCallUrgency),
    quietHoursCallUrgency: asUrgency(p.quietHoursCallUrgency, base.quietHoursCallUrgency),
    maxCallsPerHour: int(p.maxCallsPerHour, base.maxCallsPerHour, 0, 20),
    maxNotificationsPerHour: int(p.maxNotificationsPerHour, base.maxNotificationsPerHour, 0, 120),
    triggers: {
      botNeedsYou: trigger(t.botNeedsYou, base.triggers.botNeedsYou),
      botFailed: trigger(t.botFailed, base.triggers.botFailed),
      longTaskFailed: trigger(t.longTaskFailed, base.triggers.longTaskFailed),
    },
    fallback: { whatsapp: bool(f.whatsapp, base.fallback.whatsapp), message: bool(f.message, base.fallback.message) },
  };
}

export function readReachSettings(): ReachSettings {
  try {
    const path = settingsPath();
    if (!existsSync(path)) return DEFAULT_REACH_SETTINGS;
    return mergeReachSettings(DEFAULT_REACH_SETTINGS, JSON.parse(readFileSync(path, 'utf-8')));
  } catch {
    return DEFAULT_REACH_SETTINGS;
  }
}

export function writeReachSettings(patch: unknown): ReachSettings {
  const next = mergeReachSettings(readReachSettings(), patch);
  mkdirSync(reachDir(), { recursive: true, mode: 0o700 });
  const path = settingsPath();
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmp, path);
  return next;
}

/** Inside quiet hours at this moment (local time)? A window may wrap midnight (22:00–07:00). */
export function inQuietHours(s: ReachSettings, now: Date = new Date()): boolean {
  if (!s.quietHours.enabled) return false;
  const mins = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
  const start = mins(s.quietHours.start);
  const end = mins(s.quietHours.end);
  const t = now.getHours() * 60 + now.getMinutes();
  if (start === end) return false;
  return start < end ? t >= start && t < end : t >= start || t < end;
}
