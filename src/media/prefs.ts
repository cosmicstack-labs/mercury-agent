/**
 * The owner's media model choices: one default per kind, plus fallbacks
 * tried in order when it fails. Kept in ~/.mercury/media-prefs.json (not
 * mercury.yaml: the agent rewrites that file on provider switches).
 * No default means "pick automatically" (service.ts).
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getMercuryHome } from '../utils/config.js';
import { parseRef, type MediaKind } from './catalog.js';

export interface KindPrefs {
  primary?: string;
  fallbacks?: string[];
}

/** Speaking (phase 2): the service or model, the voice, and when chat replies come as voice notes. */
export interface SpeechPrefs {
  /** "openai" | "gemini" | "deepgram" | "elevenlabs", or "provider::model"; absent = the voice in Settings → Voice. */
  choice?: string;
  voice?: string;
  /** off: never; mirror: when they sent a voice note; always: every chat-app reply. */
  replies?: 'off' | 'mirror' | 'always';
}

export type MediaPrefs = Partial<Record<MediaKind, KindPrefs>> & { speech?: SpeechPrefs };

let prefs: MediaPrefs | null = null;

function path(): string {
  return join(getMercuryHome(), 'media-prefs.json');
}

const validRef = (v: unknown): v is string => typeof v === 'string' && v.length <= 512 && parseRef(v) !== null;

export function loadMediaPrefs(): MediaPrefs {
  if (prefs) return prefs;
  prefs = {};
  try {
    const raw = existsSync(path()) ? JSON.parse(readFileSync(path(), 'utf-8')) : {};
    for (const kind of ['image', 'video', 'music'] as const) {
      const k = raw?.[kind];
      if (!k || typeof k !== 'object') continue;
      prefs[kind] = {
        ...(validRef(k.primary) ? { primary: k.primary } : {}),
        ...(Array.isArray(k.fallbacks) ? { fallbacks: k.fallbacks.filter(validRef).slice(0, 5) } : {}),
      };
    }
    const speech = raw?.speech;
    if (speech && typeof speech === 'object') {
      prefs.speech = {
        ...(typeof speech.choice === 'string' && speech.choice.length <= 512 && (SPEECH_ENGINES.includes(speech.choice) || validRef(speech.choice)) ? { choice: speech.choice } : {}),
        ...(typeof speech.voice === 'string' && speech.voice.trim() && speech.voice.length <= 120 ? { voice: speech.voice.trim() } : {}),
        ...(speech.replies === 'off' || speech.replies === 'mirror' || speech.replies === 'always' ? { replies: speech.replies } : {}),
      };
    }
  } catch { /* unreadable: automatic */ }
  return prefs;
}

/** Speech services Mercury calls directly (keys in Settings → Voice / Models). */
export const SPEECH_ENGINES: readonly string[] = ['openai', 'gemini', 'deepgram', 'elevenlabs'];

function save(all: MediaPrefs): void {
  const tmp = `${path()}.tmp`;
  writeFileSync(tmp, JSON.stringify(all, null, 2), 'utf-8');
  renameSync(tmp, path());
}

/**
 * Change speaking prefs. `undefined` leaves a field, `null` clears it.
 * Throws on a value that can't be right.
 */
export function setSpeechPrefs(update: { choice?: string | null; voice?: string | null; replies?: SpeechPrefs['replies'] | null }): SpeechPrefs {
  const all = loadMediaPrefs();
  const next: SpeechPrefs = { ...all.speech };
  if (update.choice !== undefined) {
    if (update.choice === null) delete next.choice;
    else if (SPEECH_ENGINES.includes(update.choice) || validRef(update.choice)) next.choice = update.choice;
    else throw new Error(`Not a speech service or model: ${update.choice}`);
    // A voice belongs to a service: a new service starts from its own default.
    delete next.voice;
  }
  if (update.voice !== undefined) {
    if (update.voice === null || !update.voice.trim()) delete next.voice;
    else if (update.voice.length > 120) throw new Error('Voice name too long');
    else next.voice = update.voice.trim();
  }
  if (update.replies !== undefined) {
    if (update.replies === null) delete next.replies;
    else if (['off', 'mirror', 'always'].includes(update.replies)) next.replies = update.replies;
    else throw new Error(`Voice replies must be off, mirror or always`);
  }
  all.speech = next;
  save(all);
  return next;
}

/** Set (or with null clear) the default model for a kind. A new default leaves the fallbacks. */
export function setMediaDefault(kind: MediaKind, ref: string | null): void {
  const all = loadMediaPrefs();
  const current = all[kind] ?? {};
  if (ref !== null && !validRef(ref)) throw new Error(`Not a model reference: ${ref}`);
  all[kind] = { ...current, ...(ref ? { primary: ref } : {}) };
  if (!ref) delete all[kind]!.primary;
  if (ref && all[kind]!.fallbacks) all[kind]!.fallbacks = all[kind]!.fallbacks!.filter((f) => f !== ref);
  save(all);
}

/** Test hook. */
export function resetMediaPrefsCache(): void {
  prefs = null;
}
