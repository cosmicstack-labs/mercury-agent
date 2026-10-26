/**
 * Speech to text for voice notes, with the OpenAI provider the owner already
 * set up in Mercury (gpt-4o-mini-transcribe, falling back to whisper-1).
 */
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';

const MAX_BYTES = 25 * 1024 * 1024;

export interface TranscribeCreds {
  apiKey: string;
  baseUrl?: string;
}

export async function transcribeAudio(path: string, creds: TranscribeCreds, signal?: AbortSignal): Promise<string> {
  if (statSync(path).size > MAX_BYTES) throw new Error('the voice note is longer than the 25 MB transcription limit');
  const base = (creds.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const bytes = readFileSync(path);
  let lastError = '';
  for (const model of ['gpt-4o-mini-transcribe', 'whisper-1']) {
    const form = new FormData();
    form.append('model', model);
    form.append('file', new Blob([bytes], { type: 'audio/ogg' }), basename(path).replace(/\.[^.]+$/, '') + '.ogg');
    const res = await fetch(`${base}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${creds.apiKey}` },
      body: form,
      signal: signal ?? AbortSignal.timeout(60_000),
    });
    const body = (await res.json().catch(() => ({}))) as { text?: string; error?: { message?: string; code?: string } };
    if (res.ok && typeof body.text === 'string') return body.text.trim();
    lastError = body.error?.message ?? `HTTP ${res.status}`;
    // Only a missing model is worth retrying with the other one.
    if (!/model/i.test(lastError) || res.status === 401 || res.status === 429) break;
  }
  throw new Error(lastError);
}
