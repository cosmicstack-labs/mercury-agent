/**
 * Speech to text, with a service the owner already set up in Mercury: the
 * OpenAI provider (gpt-4o-mini-transcribe, falling back to whisper-1), or a
 * Gemini, Deepgram (nova-3) or ElevenLabs (scribe_v1) key saved for voice
 * (Settings → Voice / the Optimus plugin). The voice the owner chose there
 * decides which one (see pickSpeechEngine). Used for voice notes from
 * channels and for dictation in the apps.
 */
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';

const MAX_BYTES = 25 * 1024 * 1024;

export interface TranscribeCreds {
  apiKey: string;
  baseUrl?: string;
}

export type SpeechEngine =
  | { kind: 'openai'; label: string; apiKey: string; baseUrl?: string }
  | { kind: 'deepgram'; label: string; apiKey: string }
  | { kind: 'elevenlabs'; label: string; apiKey: string }
  | { kind: 'gemini'; label: string; apiKey: string };

export type SpeechKind = SpeechEngine['kind'];

const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models';
/**
 * Listening models, fastest first (measured: a few seconds for a short
 * recording); the next is tried when one isn't offered (404) or is busy (5xx).
 */
const GEMINI_LISTEN_MODELS = ['gemini-2.5-flash-lite', 'gemini-flash-lite-latest', 'gemini-flash-latest'];

type Fetch = typeof fetch;

export async function transcribeAudio(path: string, creds: TranscribeCreds, signal?: AbortSignal): Promise<string> {
  if (statSync(path).size > MAX_BYTES) throw new Error('the voice note is longer than the 25 MB transcription limit');
  const bytes = readFileSync(path);
  return transcribeBytes(bytes, 'audio/ogg', basename(path).replace(/\.[^.]+$/, '') + '.ogg', { kind: 'openai', label: 'OpenAI', ...creds }, { signal });
}

/** A voice note on disk (channels send Ogg/Opus), with any speech service. */
export async function transcribeFile(path: string, engine: SpeechEngine, signal?: AbortSignal): Promise<string> {
  if (statSync(path).size > MAX_BYTES) throw new Error('the voice note is longer than the 25 MB transcription limit');
  return transcribeBytes(readFileSync(path), 'audio/ogg', basename(path).replace(/\.[^.]+$/, '') + '.ogg', engine, { signal });
}

/** File extension a speech API expects for a recorder's mime type. */
export function audioExtension(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes('webm')) return 'webm';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'm4a';
  if (m.includes('wav')) return 'wav';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  return 'webm';
}

export async function transcribeBytes(
  bytes: Uint8Array,
  mime: string,
  filename: string,
  engine: SpeechEngine,
  opts: { signal?: AbortSignal; fetch?: Fetch; language?: string } = {},
): Promise<string> {
  if (bytes.byteLength > MAX_BYTES) throw new Error('the recording is longer than the 25 MB transcription limit');
  if (bytes.byteLength < 200) throw new Error('nothing was recorded');
  const f = opts.fetch ?? fetch;
  const signal = opts.signal ?? AbortSignal.timeout(60_000);
  const type = mime.split(';')[0] || 'audio/webm';

  if (engine.kind === 'deepgram') {
    const params = new URLSearchParams({ model: 'nova-3', smart_format: 'true', punctuate: 'true' });
    if (opts.language) params.set('language', opts.language); else params.set('detect_language', 'true');
    const res = await f(`https://api.deepgram.com/v1/listen?${params}`, {
      method: 'POST',
      headers: { Authorization: `Token ${engine.apiKey}`, 'Content-Type': type },
      body: bytes,
      signal,
    });
    const body = (await res.json().catch(() => ({}))) as { results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> }; err_msg?: string };
    if (!res.ok) throw new Error(vendorError('Deepgram', res.status, body.err_msg));
    return (body.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '').trim();
  }

  if (engine.kind === 'gemini') {
    let lastError = '';
    for (const model of GEMINI_LISTEN_MODELS) {
      const res = await f(`${GEMINI_API}/${model}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': engine.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [
            { inlineData: { mimeType: type, data: Buffer.from(bytes).toString('base64') } },
            { text: `Transcribe this recording exactly${opts.language ? ` (language: ${opts.language})` : ', in the language it is spoken in'}. Reply with only the transcript, nothing else. If nothing is said, reply with nothing.` },
          ] }],
          generationConfig: { temperature: 0 },
        }),
        signal,
      });
      const body = (await res.json().catch(() => ({}))) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; error?: { message?: string } };
      if (res.ok) return (body.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim();
      lastError = vendorError('Gemini', res.status, body.error?.message);
      if (res.status !== 404 && res.status < 500) break;
    }
    throw new Error(lastError);
  }

  if (engine.kind === 'elevenlabs') {
    const form = new FormData();
    form.append('model_id', 'scribe_v1');
    if (opts.language) form.append('language_code', opts.language);
    form.append('file', new Blob([bytes], { type }), filename);
    const res = await f('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': engine.apiKey }, body: form, signal });
    const body = (await res.json().catch(() => ({}))) as { text?: string; detail?: { message?: string } | string };
    if (!res.ok) throw new Error(vendorError('ElevenLabs', res.status, typeof body.detail === 'string' ? body.detail : body.detail?.message));
    return (body.text ?? '').trim();
  }

  const base = (engine.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  let lastError = '';
  for (const model of ['gpt-4o-mini-transcribe', 'whisper-1']) {
    const form = new FormData();
    form.append('model', model);
    if (opts.language) form.append('language', opts.language);
    form.append('file', new Blob([bytes], { type }), filename);
    const res = await f(`${base}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${engine.apiKey}` }, body: form, signal });
    const body = (await res.json().catch(() => ({}))) as { text?: string; error?: { message?: string; code?: string } };
    if (res.ok && typeof body.text === 'string') return body.text.trim();
    lastError = vendorError('OpenAI', res.status, body.error?.message);
    // Only a missing model is worth retrying with the other one.
    if (!/model/i.test(body.error?.message ?? '') || res.status === 401 || res.status === 429) break;
  }
  throw new Error(lastError);
}

function vendorError(vendor: string, status: number, detail?: string): string {
  if (status === 401 || status === 403) return `${vendor} rejected the key. Check it in Settings.`;
  if (status === 429) return `${vendor} is rate-limiting right now. Try again in a moment.`;
  return detail ? `${vendor}: ${detail}` : `${vendor} answered ${status}`;
}

/**
 * Which speech service to use, from what's configured. The voice the owner
 * picked (Settings → Voice: Optimus's voice engine, or its listening and
 * speaking services) comes first when it has a key, so choosing Gemini there
 * means Mercury reads aloud and listens with Gemini too. Otherwise the first
 * service that has a key: OpenAI, Gemini, Deepgram, ElevenLabs.
 */
export function pickSpeechEngine(
  openai: { apiKey?: string; baseUrl?: string; enabled?: boolean } | undefined,
  secret: (name: string) => string | undefined,
  preferred: ReadonlyArray<string | undefined> = [],
): SpeechEngine | null {
  const available: Partial<Record<SpeechKind, SpeechEngine>> = {};
  if (openai?.apiKey && openai.enabled !== false) available.openai = { kind: 'openai', label: 'OpenAI', apiKey: openai.apiKey, baseUrl: openai.baseUrl };
  const gemini = secret('GEMINI_API_KEY');
  if (gemini) available.gemini = { kind: 'gemini', label: 'Gemini', apiKey: gemini };
  const deepgram = secret('DEEPGRAM_API_KEY');
  if (deepgram) available.deepgram = { kind: 'deepgram', label: 'Deepgram', apiKey: deepgram };
  const eleven = secret('ELEVENLABS_API_KEY');
  if (eleven) available.elevenlabs = { kind: 'elevenlabs', label: 'ElevenLabs', apiKey: eleven };
  for (const p of preferred) {
    const hit = p ? available[p as SpeechKind] : undefined;
    if (hit) return hit;
  }
  return available.openai ?? available.gemini ?? available.deepgram ?? available.elevenlabs ?? null;
}

/**
 * The owner's voice choice, as speech services to prefer: Optimus's voice
 * engine (gemini, openai, elevenlabs…), then its listening or speaking
 * service when the engine is Mercury's own pipeline.
 */
export function preferredSpeech(settings: Record<string, unknown>, use: 'listen' | 'speak'): string[] {
  const engine = typeof settings.voiceEngine === 'string' ? settings.voiceEngine : undefined;
  const stt = typeof settings.sttProvider === 'string' ? settings.sttProvider : undefined;
  const tts = typeof settings.ttsProvider === 'string' ? settings.ttsProvider : undefined;
  const out: string[] = [];
  if (engine) out.push(engine);
  if (use === 'listen' && stt) out.push(stt);
  if (use === 'speak' && tts) out.push(tts);
  return out;
}
