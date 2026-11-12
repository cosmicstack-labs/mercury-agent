/**
 * Text to speech, with the speech service the owner already set up (the
 * same one voice typing uses, see pickSpeechEngine): OpenAI
 * (gpt-4o-mini-tts, falling back to tts-1), Gemini (Flash TTS), Deepgram
 * (Aura 2) or ElevenLabs (Flash v2.5). MP3, or WAV from Gemini (speechMime
 * says which); every client plays both. Used to read Mercury's replies aloud
 * in the apps.
 */
import type { SpeechEngine } from './transcribe.js';
import { geminiStyle } from '../media/spoken-text.js';

/** Longest text spoken in one request; clients send a long reply in parts. */
export const SPEAK_MAX_CHARS = 4000;
/** Deepgram's own limit per request. */
const DEEPGRAM_MAX_CHARS = 2000;

const OPENAI_VOICE = 'coral';
const DEEPGRAM_MODEL = 'aura-2-thalia-en';
const ELEVENLABS_VOICE = 'JBFqnCBsd6RMkjVDRZzb';
const ELEVENLABS_MODEL = 'eleven_flash_v2_5';
const GEMINI_VOICE = 'Kore';
/** Speaking models, newest first; the next is tried when one isn't offered or is busy. */
const GEMINI_SPEAK_MODELS = ['gemini-3.8-flash-tts', 'gemini-2.5-flash-preview-tts'];

/** Voices each service offers by name (ElevenLabs uses voice ids; Deepgram, Aura model names). */
export const SPEECH_VOICES: Partial<Record<SpeechEngine['kind'], string[]>> = {
  openai: ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar'],
  gemini: ['Kore', 'Puck', 'Charon', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr'],
  deepgram: ['aura-2-thalia-en', 'aura-2-andromeda-en', 'aura-2-apollo-en', 'aura-2-arcas-en', 'aura-2-helena-en', 'aura-2-orion-en'],
};

/**
 * mp3 plays everywhere; "ogg" is Ogg/Opus, what Telegram and WhatsApp play
 * as a voice note. OpenAI and Deepgram make it themselves; Gemini and
 * ElevenLabs output is converted with ffmpeg when it is installed (else it
 * stays as it was, and goes as an audio file).
 */
export type SpeechFormat = 'mp3' | 'ogg';

/** The audio type synthesizeSpeech returns for an engine (and format). */
export function speechMime(engine: SpeechEngine, format: SpeechFormat = 'mp3'): string {
  if (format === 'ogg' && (engine.kind === 'openai' || engine.kind === 'deepgram')) return 'audio/ogg';
  return engine.kind === 'gemini' ? 'audio/wav' : 'audio/mpeg';
}

type Fetch = typeof fetch;

export interface SpeakOptions {
  fetch?: Fetch;
  signal?: AbortSignal;
  /** A voice the service knows (SPEECH_VOICES; an ElevenLabs voice id). */
  voice?: string;
  /** How to say it ("calm and warm", "excited"): OpenAI gpt-4o-mini-tts and Gemini follow it. */
  instructions?: string;
  format?: SpeechFormat;
}

/** Speak `text` with `engine`; resolves with audio bytes of type speechMime(engine). */
export async function synthesizeSpeech(text: string, engine: SpeechEngine, opts: SpeakOptions = {}): Promise<Uint8Array> {
  const input = text.trim();
  if (!input) throw new Error('nothing to say');
  const f = opts.fetch ?? fetch;
  const signal = opts.signal;
  const ogg = opts.format === 'ogg';

  if (engine.kind === 'deepgram') {
    const model = opts.voice && /^aura-/i.test(opts.voice) ? opts.voice : DEEPGRAM_MODEL;
    const encoding = ogg ? 'encoding=opus&container=ogg' : 'encoding=mp3';
    const res = await f(`https://api.deepgram.com/v1/speak?model=${encodeURIComponent(model)}&${encoding}`, {
      method: 'POST',
      headers: { Authorization: `Token ${engine.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: input.slice(0, DEEPGRAM_MAX_CHARS) }),
      signal,
    });
    return audioOf(res, 'Deepgram');
  }

  if (engine.kind === 'gemini') {
    let last: Response | null = null;
    for (const model of GEMINI_SPEAK_MODELS) {
      const res = await f(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': engine.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // Gemini takes the style as words in front of the text, and reads out anything
          // that isn't a short description of the voice (geminiStyle).
          contents: [{ parts: [{ text: (geminiStyle(opts.instructions) ? `Say ${geminiStyle(opts.instructions)}: ` : '') + input.slice(0, SPEAK_MAX_CHARS) }] }],
          generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: opts.voice || GEMINI_VOICE } } } },
        }),
        signal,
      });
      if (res.ok) {
        const body = (await res.json().catch(() => ({}))) as { candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> } }> };
        const part = body.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData;
        if (!part?.data) throw new Error('Gemini sent no audio');
        return asWav(Buffer.from(part.data, 'base64'), part.mimeType ?? '');
      }
      last = res;
      if (res.status !== 404 && res.status < 500) break;
    }
    return audioOf(last!, 'Gemini');
  }

  if (engine.kind === 'elevenlabs') {
    const res = await f(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(opts.voice || ELEVENLABS_VOICE)}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': engine.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: input.slice(0, SPEAK_MAX_CHARS), model_id: ELEVENLABS_MODEL }),
      signal,
    });
    return audioOf(res, 'ElevenLabs');
  }

  const base = (engine.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const say = (model: string) => f(`${base}/audio/speech`, {
    method: 'POST',
    headers: { ...(engine.headers ?? { Authorization: `Bearer ${engine.apiKey}` }), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      voice: opts.voice || OPENAI_VOICE,
      input: input.slice(0, SPEAK_MAX_CHARS),
      // "opus" is Ogg/Opus: a voice note as it is.
      response_format: ogg ? 'opus' : 'mp3',
      // Only the instructable models take a style; tts-1 rejects the field.
      ...(opts.instructions && !/^tts-1/i.test(model) ? { instructions: opts.instructions } : {}),
    }),
    signal,
  });
  // A chosen model is used as is; otherwise the newer one, then the classic one
  // on an OpenAI-compatible endpoint that doesn't have it.
  if (engine.model) return audioOf(await say(engine.model), engine.label);
  let res = await say('gpt-4o-mini-tts');
  if (res.status === 400 || res.status === 404) res = await say('tts-1');
  return audioOf(res, engine.label || 'OpenAI');
}

/**
 * Gemini sends a WAV file, or raw 16-bit PCM ("audio/L16;rate=24000"):
 * the latter gets a WAV header so every player takes it.
 */
export function asWav(bytes: Uint8Array, mime: string): Uint8Array {
  if (bytes.byteLength >= 12 && Buffer.from(bytes.subarray(0, 4)).toString('latin1') === 'RIFF') return bytes;
  const rate = Number(/rate=(\d+)/i.exec(mime)?.[1] ?? 24000);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + bytes.byteLength, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(bytes.byteLength, 40);
  return new Uint8Array(Buffer.concat([header, Buffer.from(bytes)]));
}

async function audioOf(res: Response, vendor: string): Promise<Uint8Array> {
  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as { error?: { message?: string } | string; detail?: { message?: string } | string; err_msg?: string };
      const e = body.error ?? body.detail ?? body.err_msg;
      detail = typeof e === 'string' ? e : e?.message ?? '';
    } catch { /* not JSON */ }
    if (res.status === 401 || res.status === 403) throw new Error(`${vendor} rejected the key. Check it in Settings.`);
    if (res.status === 429) throw new Error(`${vendor} is rate-limiting right now. Try again in a moment.`);
    throw new Error(detail ? `${vendor}: ${detail.slice(0, 200)}` : `${vendor} answered ${res.status}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength === 0) throw new Error(`${vendor} sent no audio`);
  return bytes;
}
