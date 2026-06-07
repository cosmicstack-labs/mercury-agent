/**
 * OpenAISTT — fallback STT provider using Whisper-1 over HTTP.
 *
 * Whisper has no streaming endpoint; we buffer the full utterance into
 * memory, wrap it as a 16kHz mono WAV, and POST to /v1/audio/transcriptions
 * with multipart/form-data. Latency is therefore tied to utterance length
 * + ~500ms server processing — fine as a fallback when Cartesia is
 * unavailable.
 *
 * Output: one synthetic partial halfway through processing (so the UI
 * doesn't look frozen) and one final delta with the full transcript.
 * The synthetic partial is intentionally empty; consumers should treat
 * partial.text === '' as "still working".
 */
import { BaseSTTProvider, type STTCapabilities } from './base.js';
import { registerSTTProvider } from './registry.js';
import type { AudioChunk, STTOptions, TranscriptDelta } from '../types.js';
import { resolveOpenAICredential } from '../credentials.js';
import { loadConfig } from '../../utils/config.js';
import { logger } from '../../utils/logger.js';

const REQUIRED_SAMPLE_RATE = 16000;
const REQUIRED_CHANNELS = 1;
const MAX_BUFFER_BYTES = 25 * 1024 * 1024; // OpenAI 25MB limit

class OpenAISTT extends BaseSTTProvider {
  readonly name = 'openai';
  readonly capabilities: STTCapabilities = {
    streaming: false,
    requiredSampleRate: REQUIRED_SAMPLE_RATE,
    requiredChannels: REQUIRED_CHANNELS,
  };

  private consecutiveFailures = 0;

  async isAvailable(): Promise<boolean> {
    if (this.consecutiveFailures >= 3) return false;
    return (await resolveOpenAICredential()) !== null;
  }

  async *transcribe(
    frames: AsyncIterable<AudioChunk>,
    opts: STTOptions,
  ): AsyncIterable<TranscriptDelta> {
    const cred = await resolveOpenAICredential();
    if (!cred) throw new Error('OpenAI STT: no credential available');

    const cfg = loadConfig().voice?.stt?.openai;
    const model = cfg?.model ?? 'whisper-1';
    const language = opts.language ?? cfg?.language ?? 'auto';

    // Collect frames into a single PCM buffer.
    const chunks: Buffer[] = [];
    let total = 0;
    let sampleRate = REQUIRED_SAMPLE_RATE;
    for await (const frame of frames) {
      if (opts.signal?.aborted) return;
      chunks.push(frame.pcm);
      total += frame.pcm.byteLength;
      sampleRate = frame.sampleRate;
      if (total > MAX_BUFFER_BYTES) {
        throw new Error('OpenAI STT: utterance exceeds 25MB limit');
      }
    }
    if (total === 0) {
      yield { text: '', isFinal: true };
      return;
    }

    // Synthetic partial so the UI shows "transcribing…".
    yield { text: '', isFinal: false };

    const pcm = Buffer.concat(chunks, total);
    const wav = pcmToWav(pcm, sampleRate, REQUIRED_CHANNELS);

    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'utterance.wav');
    form.append('model', model);
    if (language && language !== 'auto') form.append('language', language);
    form.append('response_format', 'json');

    let res: Response;
    try {
      res = await fetch(`${cred.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${cred.token}`,
          ...(cred.extraHeaders ?? {}),
        },
        body: form,
        signal: opts.signal,
      });
    } catch (err) {
      this.consecutiveFailures++;
      throw err;
    }

    if (!res.ok) {
      this.consecutiveFailures++;
      const errText = await safeText(res);
      throw new Error(`OpenAI STT HTTP ${res.status}: ${errText.slice(0, 200)}`);
    }

    this.consecutiveFailures = 0;
    const json = (await res.json()) as { text?: string };
    yield { text: (json.text ?? '').trim(), isFinal: true };
  }
}

/* ── WAV header builder for 16-bit PCM ─────────────────────────────────── */

function pcmToWav(pcm: Buffer, sampleRate: number, channels: number): Buffer {
  const byteRate = sampleRate * channels * 2;
  const blockAlign = channels * 2;
  const dataSize = pcm.byteLength;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);            // fmt chunk size
  header.writeUInt16LE(1, 20);             // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);            // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm], 44 + dataSize);
}

async function safeText(res: Response): Promise<string> {
  try { return await res.text(); } catch { return ''; }
}

registerSTTProvider('openai', async () => new OpenAISTT());

export { OpenAISTT };
