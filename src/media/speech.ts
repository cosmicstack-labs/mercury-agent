/**
 * Speaking (ADR-042 phase 2): one choice of speech service and voice for
 * everything that speaks — the generate_speech tool, /voice, voice-note
 * replies in chat apps, and reading replies aloud in the apps.
 *
 * What speaks, in order:
 *   1. the owner's choice in Settings → AI → Media or /media speech: a
 *      service Mercury calls directly (OpenAI, Gemini, Deepgram, ElevenLabs)
 *      or a text-to-speech model found on a provider (LiteLLM, Mercury
 *      Cloud, any OpenAI-compatible /audio/speech)
 *   2. the voice chosen in Settings → Voice, else the first service with a
 *      key (what read-aloud always used)
 */
import { execFile } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { freeName } from '../artifacts/output-dir.js';
import { loadConfig } from '../utils/config.js';
import { secretValue } from '../plugins/store.js';
import { currentSpeechEngine } from '../plugins/speech-choice.js';
import { SPEAK_MAX_CHARS, SPEECH_VOICES, speechMime, synthesizeSpeech, type SpeechFormat } from '../plugins/speak.js';
import type { SpeechEngine } from '../plugins/transcribe.js';
import { parseRef, speechModels, type MediaModel, type MediaSource } from './catalog.js';
import { loadMediaPrefs, type SpeechPrefs } from './prefs.js';
import { slug } from './service.js';

const run = promisify(execFile);

export interface SpeechOption {
  /** "openai" | "gemini" | "deepgram" | "elevenlabs", or "provider::model". */
  id: string;
  label: string;
  group: string;
  /** Voices it knows by name (empty: any id the service takes, e.g. ElevenLabs voice ids). */
  voices: string[];
}

export interface SpeechTarget {
  engine: SpeechEngine;
  id: string;
  label: string;
  voice?: string;
}

const ENGINE_LABEL: Record<string, string> = { openai: 'OpenAI', gemini: 'Gemini', deepgram: 'Deepgram', elevenlabs: 'ElevenLabs' };

/** Services Mercury can call directly with keys the owner already gave. */
function directEngines(): Partial<Record<SpeechEngine['kind'], SpeechEngine>> {
  const out: Partial<Record<SpeechEngine['kind'], SpeechEngine>> = {};
  const openai = loadConfig().providers.openai;
  if (openai?.apiKey && openai.enabled !== false) out.openai = { kind: 'openai', label: 'OpenAI', apiKey: openai.apiKey, baseUrl: openai.baseUrl };
  const gemini = secretValue('GEMINI_API_KEY');
  if (gemini) out.gemini = { kind: 'gemini', label: 'Gemini', apiKey: gemini };
  const deepgram = secretValue('DEEPGRAM_API_KEY');
  if (deepgram) out.deepgram = { kind: 'deepgram', label: 'Deepgram', apiKey: deepgram };
  const eleven = secretValue('ELEVENLABS_API_KEY');
  if (eleven) out.elevenlabs = { kind: 'elevenlabs', label: 'ElevenLabs', apiKey: eleven };
  return out;
}

export class SpeechService {
  constructor(private readonly sources: () => MediaSource[], private readonly fetchImpl: typeof fetch = globalThis.fetch) {}

  prefs(): SpeechPrefs {
    return loadMediaPrefs().speech ?? {};
  }

  /** Every way Mercury can speak right now: direct services, then provider models. */
  async options(opts: { refresh?: boolean } = {}): Promise<SpeechOption[]> {
    const direct = Object.values(directEngines()).map((e) => ({ id: e.kind, label: ENGINE_LABEL[e.kind], group: 'Speech services', voices: SPEECH_VOICES[e.kind] ?? [] }));
    const models = await speechModels(this.sources(), { refresh: opts.refresh, fetchImpl: this.fetchImpl });
    // The OpenAI provider's own models are the "OpenAI" service with a model picked.
    return [
      ...direct,
      ...models.map((m: MediaModel) => ({ id: m.ref, label: m.label, group: m.group, voices: SPEECH_VOICES.openai ?? [] })),
    ];
  }

  /** What speaks now (null: nothing set up). */
  async target(): Promise<SpeechTarget | null> {
    const prefs = this.prefs();
    const voice = prefs.voice;
    if (prefs.choice) {
      const direct = directEngines()[prefs.choice as SpeechEngine['kind']];
      if (direct) return { engine: direct, id: direct.kind, label: ENGINE_LABEL[direct.kind], ...(voice ? { voice } : {}) };
      const ref = parseRef(prefs.choice);
      const src = ref ? this.sources().find((s) => s.name === ref.provider) : undefined;
      const ep = src ? await src.endpoint().catch(() => undefined) : undefined;
      if (ref && ep) {
        return {
          engine: { kind: 'openai', label: `${ref.model}`, apiKey: '', baseUrl: ep.baseUrl, headers: ep.headers, model: ref.model },
          id: prefs.choice,
          label: ref.model,
          ...(voice ? { voice } : {}),
        };
      }
      // The choice is gone (key removed, provider off): fall back below.
    }
    const engine = currentSpeechEngine('speak');
    return engine ? { engine, id: engine.kind, label: engine.label, ...(voice && !prefs.choice ? { voice } : {}) } : null;
  }

  /** Speak text; ogg is a voice note (converted with ffmpeg where the service can't make it). */
  async speak(text: string, opts: { voice?: string; instructions?: string; format?: SpeechFormat; signal?: AbortSignal } = {}): Promise<{ bytes: Uint8Array; mime: string; ext: string; label: string }> {
    const t = await this.target();
    if (!t) throw new Error('No speech service is set up: add an OpenAI key (Settings → Models), or a Gemini, Deepgram or ElevenLabs key (Settings → Voice).');
    const format = opts.format ?? 'mp3';
    const bytes = await synthesizeSpeech(text.slice(0, SPEAK_MAX_CHARS), t.engine, {
      fetch: this.fetchImpl,
      signal: opts.signal,
      voice: opts.voice ?? t.voice,
      instructions: opts.instructions,
      format,
    });
    const mime = speechMime(t.engine, format);
    if (format === 'ogg' && mime !== 'audio/ogg') {
      const converted = await toOggOpus(bytes, mime === 'audio/wav' ? 'wav' : 'mp3');
      if (converted) return { bytes: converted, mime: 'audio/ogg', ext: 'ogg', label: t.label };
    }
    return { bytes, mime, ext: mime === 'audio/ogg' ? 'ogg' : mime === 'audio/wav' ? 'wav' : 'mp3', label: t.label };
  }

  /** Speak into a file in `outDir`; named from the text. */
  async speakToFile(text: string, outDir: string, opts: { voice?: string; instructions?: string; format?: SpeechFormat; signal?: AbortSignal } = {}): Promise<{ file: string; label: string; ms: number }> {
    const started = Date.now();
    const audio = await this.speak(text, opts);
    mkdirSync(outDir, { recursive: true });
    const file = join(outDir, freeName(outDir, `${slug(text).slice(0, 40) || 'speech'}.${audio.ext}`));
    writeFileSync(file, audio.bytes);
    return { file, label: audio.label, ms: Date.now() - started };
  }
}

/** Ogg/Opus from mp3 or wav with ffmpeg; null when ffmpeg isn't there or fails. */
export async function toOggOpus(bytes: Uint8Array, from: 'mp3' | 'wav'): Promise<Uint8Array | null> {
  const dir = join(tmpdir(), `mercury-voice-${process.pid}-${Date.now()}`);
  try {
    mkdirSync(dir, { recursive: true });
    const input = join(dir, `in.${from}`);
    const output = join(dir, 'out.ogg');
    writeFileSync(input, bytes);
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', input, '-c:a', 'libopus', '-b:a', '48k', '-ac', '1', output], { timeout: 60_000 });
    const { readFileSync } = await import('node:fs');
    return new Uint8Array(readFileSync(output));
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A reply as it should sound: no markdown, no code, links by name, and
 * short enough for a voice note (the full text was sent as a message).
 */
export function speakableText(markdown: string, max = 1500): string {
  let t = markdown
    .replace(/```[\s\S]*?```/g, ' (code in the message) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/[*_~>|]+/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
  if (t.length > max) {
    const cut = t.slice(0, max);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'));
    t = `${cut.slice(0, end > max * 0.6 ? end + 1 : max).trim()} The rest is in the message.`;
  }
  return t;
}

/** Should this chat-app reply also come as a voice note? */
export function voiceReplyWanted(channelType: string, sentVoiceNote: boolean, replies: SpeechPrefs['replies'] = 'mirror'): boolean {
  if (['web', 'cli', 'internal'].includes(channelType)) return false;
  return replies === 'always' || (replies === 'mirror' && sentVoiceNote);
}

let speechService: SpeechService | null = null;
export function setSpeechService(s: SpeechService | null): void { speechService = s; }
export function getSpeechService(): SpeechService | null { return speechService; }
