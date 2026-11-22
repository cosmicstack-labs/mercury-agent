import { randomBytes, randomInt } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getMercuryHome } from '../utils/config.js';

/**
 * Owner tasks (ADR-048): something only the owner can do, handed to them and
 * waited for. Solving a CAPTCHA, reading out a one-time code, finishing a step
 * on a website. Unlike an approval (yes/no), a task carries what the owner
 * needs to see (an image, an audio clip, a link) and comes back with their
 * answer as text.
 *
 * It goes to every place the owner is — their messaging channels (with the
 * image attached), the phone apps (a notification), Mercury Desktop and the
 * terminal — and is answered once, with a short code: "K7Q2M 4fz9q". Nobody
 * answering in time is a timeout, never a guess.
 */

export type OwnerTaskStatus = 'pending' | 'answered' | 'declined' | 'expired' | 'cancelled';

export interface OwnerTaskMedia {
  kind: 'image' | 'audio';
  mimeType: string;
  /** Saved under ~/.mercury/owner-tasks/ so channels can attach it and the terminal can open it. */
  path: string;
  bytes: number;
}

export interface OwnerTask {
  id: string;
  /** Short code the owner answers with ("K7Q2M <answer>") — no 0/O/1/I. */
  code: string;
  /** One line: "Solve this CAPTCHA", "Enter the code from your bank's text". */
  title: string;
  /** What exactly to do, and what to send back. */
  prompt: string;
  /** Who is asking: "Mercury", "plugin captcha", a bot. Shown to the owner. */
  who: string;
  /** The site or page this is for, so the owner can judge it. */
  link?: string;
  media?: OwnerTaskMedia;
  /** "done" tasks need no text back: the owner did something and says so. */
  answerKind: 'text' | 'done';
  at: number;
  expiresAt: number;
  status: OwnerTaskStatus;
  answer?: string;
  answeredBy?: string;
}

export interface OwnerTaskRequest {
  title: string;
  prompt: string;
  who: string;
  link?: string;
  media?: { kind: 'image' | 'audio'; mimeType: string; data: Buffer };
  answerKind?: 'text' | 'done';
}

export type OwnerTaskResult =
  | { status: 'answered'; answer: string; by: string }
  | { status: 'declined' | 'expired' | 'cancelled' };

type Listener = (t: OwnerTask, change: 'new' | 'settled') => void;

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const KEEP_SETTLED_MS = 15 * 60_000;
export const OWNER_TASK_MAX_MEDIA_BYTES = 5 * 1024 * 1024;
export const OWNER_TASK_MAX_ANSWER = 2000;
const MIME_EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/webm': 'webm', 'audio/mp4': 'm4a',
};

export function ownerTasksDir(): string {
  return join(getMercuryHome(), 'owner-tasks');
}

export class OwnerTasks {
  private items = new Map<string, OwnerTask>();
  private waiters = new Map<string, Array<(r: OwnerTaskResult) => void>>();
  private listeners = new Set<Listener>();

  constructor(private readonly now: () => number = Date.now, private readonly dir: () => string = ownerTasksDir) {}

  onChange(l: Listener): () => void {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  }

  private emit(t: OwnerTask, change: 'new' | 'settled'): void {
    for (const l of this.listeners) { try { l({ ...t }, change); } catch { /* a listener's problem */ } }
  }

  private newCode(): string {
    const taken = new Set([...this.items.values()].filter((t) => t.status === 'pending').map((t) => t.code));
    for (;;) {
      const code = Array.from({ length: 5 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
      if (!taken.has(code)) return code;
    }
  }

  /** Hand the owner a task. Throws on a bad request (empty prompt, media too large or of an unknown type). */
  request(input: OwnerTaskRequest, ttlMs: number): OwnerTask {
    this.sweep();
    const title = input.title.trim().slice(0, 120);
    const prompt = input.prompt.trim().slice(0, 1000);
    if (!title || !prompt) throw new Error('An owner task needs a title and a prompt.');
    const at = this.now();
    const id = randomBytes(9).toString('base64url');
    let media: OwnerTaskMedia | undefined;
    if (input.media) {
      const ext = MIME_EXT[input.media.mimeType.toLowerCase()];
      if (!ext) throw new Error(`Unsupported media type ${input.media.mimeType}: send an image (png, jpeg, gif, webp) or audio (mp3, wav, ogg, webm, m4a).`);
      if (input.media.kind !== (input.media.mimeType.startsWith('image/') ? 'image' : 'audio')) throw new Error('Media kind and type disagree.');
      if (input.media.data.length === 0 || input.media.data.length > OWNER_TASK_MAX_MEDIA_BYTES) throw new Error(`Media must be 1 byte to ${OWNER_TASK_MAX_MEDIA_BYTES / 1048576} MB.`);
      mkdirSync(this.dir(), { recursive: true, mode: 0o700 });
      const path = join(this.dir(), `${id}.${ext}`);
      writeFileSync(path, input.media.data, { mode: 0o600 });
      media = { kind: input.media.kind, mimeType: input.media.mimeType.toLowerCase(), path, bytes: input.media.data.length };
    }
    const link = input.link && /^https?:\/\//i.test(input.link.trim()) ? input.link.trim().slice(0, 2048) : undefined;
    const t: OwnerTask = {
      id, code: this.newCode(), title, prompt, who: input.who.trim().slice(0, 80) || 'Mercury',
      ...(link ? { link } : {}), ...(media ? { media } : {}),
      answerKind: input.answerKind ?? 'text', at, expiresAt: at + ttlMs, status: 'pending',
    };
    this.items.set(id, t);
    const timer = setTimeout(() => this.finish(id, 'expired', 'timeout'), ttlMs);
    timer.unref?.();
    this.emit(t, 'new');
    return { ...t };
  }

  /** By id or by its code (case-insensitive). Null when there's no such task. */
  find(idOrCode: string): OwnerTask | null {
    const key = idOrCode.trim();
    const t = this.items.get(key) ?? [...this.items.values()].find((x) => x.status === 'pending' && x.code === key.toUpperCase());
    return t ? { ...t } : null;
  }

  /** The owner's answer. Null when the task isn't pending (already answered, expired, unknown). */
  answer(idOrCode: string, answer: string, by: string): OwnerTask | null {
    const found = this.find(idOrCode);
    const t = found ? this.items.get(found.id) : undefined;
    if (!t || t.status !== 'pending') return null;
    if (this.now() > t.expiresAt) { this.finish(t.id, 'expired', 'timeout'); return null; }
    const text = answer.trim().slice(0, OWNER_TASK_MAX_ANSWER);
    if (!text && t.answerKind === 'text') return null;
    t.answer = text || 'done';
    return this.finish(t.id, 'answered', by);
  }

  decline(idOrCode: string, by: string): OwnerTask | null {
    const found = this.find(idOrCode);
    if (!found || found.status !== 'pending') return null;
    return this.finish(found.id, 'declined', by);
  }

  /** The asker gave up (its turn was stopped). */
  cancel(id: string): void {
    this.finish(id, 'cancelled', 'asker');
  }

  private finish(id: string, status: Exclude<OwnerTaskStatus, 'pending'>, by: string): OwnerTask | null {
    const t = this.items.get(id);
    if (!t || t.status !== 'pending') return null;
    t.status = status;
    t.answeredBy = by;
    const result: OwnerTaskResult = status === 'answered' ? { status, answer: t.answer ?? '', by } : { status };
    for (const w of this.waiters.get(id) ?? []) w(result);
    this.waiters.delete(id);
    this.emit(t, 'settled');
    return { ...t };
  }

  /** Resolves when the task is answered, declined, cancelled or expires. */
  wait(id: string, signal?: AbortSignal): Promise<OwnerTaskResult> {
    const t = this.items.get(id);
    if (!t) return Promise.resolve({ status: 'expired' });
    if (t.status !== 'pending') return Promise.resolve(t.status === 'answered' ? { status: 'answered', answer: t.answer ?? '', by: t.answeredBy ?? '' } : { status: t.status });
    return new Promise((resolve) => {
      this.waiters.set(id, [...(this.waiters.get(id) ?? []), resolve]);
      if (signal) {
        if (signal.aborted) this.cancel(id);
        else signal.addEventListener('abort', () => this.cancel(id), { once: true });
      }
    });
  }

  pending(): OwnerTask[] {
    this.sweep();
    return [...this.items.values()].filter((t) => t.status === 'pending').sort((x, y) => x.at - y.at).map((t) => ({ ...t }));
  }

  get(id: string): OwnerTask | null {
    const t = this.items.get(id);
    return t ? { ...t } : null;
  }

  /** Settled tasks are forgotten after a while, with their media. */
  private sweep(): void {
    const now = this.now();
    for (const [id, t] of this.items) {
      if (t.status !== 'pending' && now - t.expiresAt > KEEP_SETTLED_MS) {
        if (t.media) try { rmSync(t.media.path, { force: true }); } catch { /* gone already */ }
        this.items.delete(id);
      }
    }
  }
}

/** "K7Q2M 4fz9q", "answer K7Q2M 4fz9q", "K7Q2M: 4fz9q", "decline K7Q2M". */
export function parseOwnerTaskReply(text: string): { code: string; answer: string } | { code: string; decline: true } | null {
  const t = text.trim();
  const decline = /^(?:decline|skip|cancel)\s+([A-HJ-NP-Z2-9]{5})\s*$/i.exec(t);
  if (decline) return { code: decline[1].toUpperCase(), decline: true };
  const m = /^(?:\/?answer\s+)?([A-HJ-NP-Z2-9]{5})\s*[:\-–]?\s+([\s\S]+)$/i.exec(t);
  if (!m) return null;
  return { code: m[1].toUpperCase(), answer: m[2].trim() };
}

/** What the owner sees in a messaging channel or the terminal. */
export function ownerTaskText(t: OwnerTask, now = Date.now()): string {
  const mins = Math.max(1, Math.round((t.expiresAt - now) / 60_000));
  const lines = [
    `🧩 ${t.who} needs you: ${t.title}`,
    t.prompt,
    ...(t.link ? [`Page: ${t.link}`] : []),
    ...(t.media ? [`(${t.media.kind === 'image' ? 'Image' : 'Audio'} attached.)`] : []),
    t.answerKind === 'done'
      ? `When you've done it, reply “${t.code} done”. Reply “decline ${t.code}” to skip. Expires in ${mins} min.`
      : `Reply “${t.code} <your answer>”, or “decline ${t.code}” to skip. Expires in ${mins} min.`,
    'Never send a password or a bank PIN this way.',
  ];
  return lines.join('\n');
}

const CHANNEL_NAMES: Record<string, string> = { telegram: 'Telegram', whatsapp: 'WhatsApp', signal: 'Signal', discord: 'Discord', slack: 'Slack', cli: 'the terminal', web: 'the app' };

/** The follow-up every chat gets once a task is over, wherever it was answered. */
export function ownerTaskSettledText(t: OwnerTask): string {
  const by = t.answeredBy ? CHANNEL_NAMES[t.answeredBy] ?? t.answeredBy : ''; // a channel, or the app's device name ("Salman's iPhone")
  switch (t.status) {
    case 'answered': return `✅ ${t.code} answered${by ? ` on ${by}` : ''}: ${t.title}. Nothing more to do.`;
    case 'declined': return `Skipped ${t.code}${by ? ` on ${by}` : ''}: ${t.title}.`;
    case 'expired': return `⌛ ${t.code} expired: nobody answered in time (${t.title}).`;
    default: return `${t.code} is no longer needed: ${t.title}.`;
  }
}

let shared: OwnerTasks | null = null;
export function ownerTasks(): OwnerTasks {
  shared ??= new OwnerTasks();
  return shared;
}

/** Test hook. */
export function _setOwnerTasks(t: OwnerTasks | null): void {
  shared = t;
}
