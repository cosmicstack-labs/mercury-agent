import { create } from "zustand";
import type { SoundId } from "./sounds";

/**
 * What notifies, and how: preferences (this device), which conversations
 * have something new (the blue dot) or are waiting on you (amber), and the
 * in-app alerts shown when system notifications are off or blocked.
 */

export interface NotifyPrefs {
  /** System notifications, if the OS allows them. */
  system: boolean;
  needsYou: boolean;
  done: boolean;
  /** A finished task notifies only when it ran at least this long (seconds). */
  doneAfterSec: number;
  failed: boolean;
  sound: SoundId;
  volume: number;
  muted: boolean;
  /** Count on the Dock / taskbar icon. */
  badge: boolean;
  /** Asked once whether to turn system notifications on. */
  asked: boolean;
}

export const DEFAULT_PREFS: NotifyPrefs = { system: true, needsYou: true, done: true, doneAfterSec: 30, failed: true, sound: "pop", volume: 0.6, muted: false, badge: true, asked: false };

const PREFS_KEY = "mercury.notify.prefs.v1";
const CUSTOM_KEY = "mercury.notify.customSound.v1";
const SEEN_KEY = "mercury.notify.unread.v1";

function read<T>(key: string, fallback: T): T {
  try { const raw = localStorage.getItem(key); return raw ? (JSON.parse(raw) as T) : fallback; } catch { return fallback; }
}
function write(key: string, value: unknown): void {
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(value)); } catch { /* per-device nicety */ }
}

export interface CustomSound { name: string; url: string }

export interface Alert {
  id: string;
  kind: "needs" | "done" | "failed" | "ask";
  title: string;
  body: string;
  sessionId?: string;
}

interface NotifyState {
  prefs: NotifyPrefs;
  custom: CustomSound | null;
  /** Conversations with a reply you haven't opened. */
  unread: Record<string, number>;
  /** Conversations waiting for your answer. */
  waiting: Record<string, string>;
  alerts: Alert[];
  setPrefs(patch: Partial<NotifyPrefs>): void;
  setCustom(c: CustomSound | null): void;
  markUnread(id: string): void;
  markWaiting(id: string, promptId: string): void;
  clearWaiting(id: string, promptId?: string): void;
  seen(id: string): void;
  /** Forget marks on conversations that no longer exist (deleted). */
  keepOnly(ids: Set<string>): void;
  pushAlert(a: Omit<Alert, "id">): void;
  dismiss(id: string): void;
}

export const useNotify = create<NotifyState>((set) => ({
  prefs: { ...DEFAULT_PREFS, ...read<Partial<NotifyPrefs>>(PREFS_KEY, {}) },
  custom: read<CustomSound | null>(CUSTOM_KEY, null),
  unread: read<Record<string, number>>(SEEN_KEY, {}),
  waiting: {},
  alerts: [],
  setPrefs: (patch) => set((s) => { const prefs = { ...s.prefs, ...patch }; write(PREFS_KEY, prefs); return { prefs }; }),
  setCustom: (custom) => { write(CUSTOM_KEY, custom); set({ custom }); },
  markUnread: (id) => set((s) => { const unread = { ...s.unread, [id]: Date.now() }; write(SEEN_KEY, unread); return { unread }; }),
  markWaiting: (id, promptId) => set((s) => ({ waiting: { ...s.waiting, [id]: promptId } })),
  clearWaiting: (id, promptId) => set((s) => {
    if (!(id in s.waiting) || (promptId && s.waiting[id] !== promptId)) return s;
    const waiting = { ...s.waiting };
    delete waiting[id];
    return { waiting };
  }),
  seen: (id) => set((s) => {
    if (!(id in s.unread)) return s;
    const unread = { ...s.unread };
    delete unread[id];
    write(SEEN_KEY, unread);
    return { unread };
  }),
  keepOnly: (ids) => set((s) => {
    const gone = Object.keys(s.unread).filter((id) => !ids.has(id));
    const goneWaiting = Object.keys(s.waiting).filter((id) => !ids.has(id));
    if (!gone.length && !goneWaiting.length) return s;
    const unread = { ...s.unread };
    for (const id of gone) delete unread[id];
    const waiting = { ...s.waiting };
    for (const id of goneWaiting) delete waiting[id];
    write(SEEN_KEY, unread);
    return { unread, waiting };
  }),
  pushAlert: (a) => set((s) => ({ alerts: [...s.alerts.filter((x) => !(a.sessionId && x.sessionId === a.sessionId && x.kind === a.kind)), { ...a, id: crypto.randomUUID() }].slice(-3) })),
  dismiss: (id) => set((s) => ({ alerts: s.alerts.filter((a) => a.id !== id) })),
}));

/** Should a finished turn notify? Long ones only; failures always (when on). */
export function worthTelling(kind: "done" | "failed", ms: number, prefs: NotifyPrefs): boolean {
  if (kind === "failed") return prefs.failed;
  return prefs.done && ms >= prefs.doneAfterSec * 1000;
}
