/**
 * Speech to text, with services the owner already set up in Mercury:
 *   1. the OpenAI provider (gpt-4o-mini-transcribe, falling back to whisper-1),
 *   2. else a Deepgram key (nova-3) or an ElevenLabs key (scribe_v1) saved
 *      for voice (Settings → Voice / the Optimus plugin).
 * Used for voice notes from channels and for dictation in the apps.
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
  | { kind: 'elevenlabs'; label: string; apiKey: string };

type Fetch = typeof fetch;

export async function transcribeAudio(path: string, creds: TranscribeCreds, signal?: AbortSignal): Promise<string> {
  if (statSync(path).size > MAX_BYTES) throw new Error('the voice note is longer than the 25 MB transcription limit');
  const bytes = readFileSync(path);
  return transcribeBytes(bytes, 'audio/ogg', basename(path).replace(/\.[^.]+$/, '') + '.ogg', { kind: 'openai', label: 'OpenAI', ...creds }, { signal });
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
 * Which speech service to use, from what's configured. OpenAI first (best
 * at mixed languages and punctuation), then Deepgram, then ElevenLabs.
 */
export function pickSpeechEngine(
  openai: { apiKey?: string; baseUrl?: string; enabled?: boolean } | undefined,
  secret: (name: string) => string | undefined,
): SpeechEngine | null {
  if (openai?.apiKey && openai.enabled !== false) return { kind: 'openai', label: 'OpenAI', apiKey: openai.apiKey, baseUrl: openai.baseUrl };
  const deepgram = secret('DEEPGRAM_API_KEY');
  if (deepgram) return { kind: 'deepgram', label: 'Deepgram', apiKey: deepgram };
  const eleven = secret('ELEVENLABS_API_KEY');
  if (eleven) return { kind: 'elevenlabs', label: 'ElevenLabs', apiKey: eleven };
  return null;
}
