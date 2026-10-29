/**
 * Text to speech, with the speech service the owner already set up (the
 * same one voice typing uses, see pickSpeechEngine): OpenAI
 * (gpt-4o-mini-tts, falling back to tts-1), Deepgram (Aura 2) or
 * ElevenLabs (Flash v2.5). Always MP3, so every client can play it.
 * Used to read Mercury's replies aloud in the apps.
 */
import type { SpeechEngine } from './transcribe.js';

/** Longest text spoken in one request; clients send a long reply in parts. */
export const SPEAK_MAX_CHARS = 4000;
/** Deepgram's own limit per request. */
const DEEPGRAM_MAX_CHARS = 2000;

const OPENAI_VOICE = 'coral';
const DEEPGRAM_MODEL = 'aura-2-thalia-en';
const ELEVENLABS_VOICE = 'JBFqnCBsd6RMkjVDRZzb';
const ELEVENLABS_MODEL = 'eleven_flash_v2_5';

type Fetch = typeof fetch;

export interface SpeakOptions {
  fetch?: Fetch;
  signal?: AbortSignal;
}

/** Speak `text` with `engine`; resolves with MP3 bytes. */
export async function synthesizeSpeech(text: string, engine: SpeechEngine, opts: SpeakOptions = {}): Promise<Uint8Array> {
  const input = text.trim();
  if (!input) throw new Error('nothing to say');
  const f = opts.fetch ?? fetch;
  const signal = opts.signal;

  if (engine.kind === 'deepgram') {
    const res = await f(`https://api.deepgram.com/v1/speak?model=${DEEPGRAM_MODEL}&encoding=mp3`, {
      method: 'POST',
      headers: { Authorization: `Token ${engine.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: input.slice(0, DEEPGRAM_MAX_CHARS) }),
      signal,
    });
    return audioOf(res, 'Deepgram');
  }

  if (engine.kind === 'elevenlabs') {
    const res = await f(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE}?output_format=mp3_44100_128`, {
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
    headers: { Authorization: `Bearer ${engine.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, voice: OPENAI_VOICE, input: input.slice(0, SPEAK_MAX_CHARS), response_format: 'mp3' }),
    signal,
  });
  let res = await say('gpt-4o-mini-tts');
  // An OpenAI-compatible endpoint without the newer model: try the classic one.
  if (res.status === 400 || res.status === 404) res = await say('tts-1');
  return audioOf(res, 'OpenAI');
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
