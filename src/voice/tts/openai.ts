/**
 * OpenAITTS — fallback TTS provider.
 *
 * Hits POST /v1/audio/speech with `response_format: "pcm"` so we get raw
 * 24kHz mono s16le bytes we can stream straight into the AudioBackend
 * without any decode step.
 *
 * Differences from Cartesia:
 *   - HTTP, not WebSocket. We get a chunked body and yield frames as bytes
 *     arrive — there is no per-utterance context_id, so cross-chunk
 *     prosody isn't preserved as well. The SentenceBuffer is therefore
 *     more important here: feed it larger warm chunks for better
 *     intonation.
 *   - Auth uses the OpenAICredential resolver (OAuth → config → env).
 *   - No persistent connection; each chunk is its own request. We rely on
 *     HTTP keepalive in undici/Node's global agent to amortize TLS cost.
 *
 * For streaming text input we issue one request per text chunk and yield
 * frames in order; concurrency is intentionally avoided to preserve
 * speaking order.
 */
import { BaseTTSProvider, type TTSCapabilities } from './base.js';
import { registerTTSProvider } from './registry.js';
import type { AudioChunk, TTSOptions, Voice } from '../types.js';
import { resolveOpenAICredential } from '../credentials.js';
import { loadConfig } from '../../utils/config.js';
import { logger } from '../../utils/logger.js';

const NATIVE_SAMPLE_RATE = 24000;
// Default catalogue when no /v1/voices is queryable — OpenAI does not
// expose a public voices endpoint; the names are fixed.
const DEFAULT_VOICES: Voice[] = [
  { id: 'alloy',   name: 'Alloy' },
  { id: 'ash',     name: 'Ash' },
  { id: 'ballad',  name: 'Ballad' },
  { id: 'coral',   name: 'Coral' },
  { id: 'echo',    name: 'Echo' },
  { id: 'fable',   name: 'Fable' },
  { id: 'nova',    name: 'Nova' },
  { id: 'onyx',    name: 'Onyx' },
  { id: 'sage',    name: 'Sage' },
  { id: 'shimmer', name: 'Shimmer' },
  { id: 'verse',   name: 'Verse' },
];

class OpenAITTS extends BaseTTSProvider {
  readonly name = 'openai';
  readonly capabilities: TTSCapabilities = {
    streaming: true, // streams chunks of a single request body
    nativeSampleRate: NATIVE_SAMPLE_RATE,
  };

  private consecutiveFailures = 0;

  async isAvailable(): Promise<boolean> {
    if (this.consecutiveFailures >= 3) return false;
    const cred = await resolveOpenAICredential();
    return cred !== null;
  }

  async listVoices(): Promise<Voice[]> {
    return DEFAULT_VOICES;
  }

  async *synthesize(text: string, opts: TTSOptions): AsyncIterable<AudioChunk> {
    if (opts.signal?.aborted || !text.trim()) return;

    const cred = await resolveOpenAICredential();
    if (!cred) throw new Error('OpenAI TTS: no credential available');

    const cfg = loadConfig().voice?.tts?.openai;
    const model = cfg?.model ?? 'gpt-4o-mini-tts';
    const voice = opts.voiceId ?? cfg?.voice ?? 'sage';

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${cred.token}`,
      'Content-Type': 'application/json',
      ...(cred.extraHeaders ?? {}),
    };

    const body = JSON.stringify({
      model,
      voice,
      input: text,
      response_format: 'pcm',
      // OpenAI rate range is 0.25–4.0; clamp safely.
      speed: opts.rate ? clamp(opts.rate, 0.25, 4.0) : undefined,
    });

    let res: Response;
    try {
      res = await fetch(`${cred.baseUrl}/audio/speech`, {
        method: 'POST',
        headers,
        body,
        signal: opts.signal,
      });
    } catch (err) {
      this.consecutiveFailures++;
      throw err;
    }

    if (!res.ok || !res.body) {
      this.consecutiveFailures++;
      const errText = await safeText(res);
      throw new Error(`OpenAI TTS HTTP ${res.status}: ${errText.slice(0, 200)}`);
    }

    this.consecutiveFailures = 0;

    const reader = res.body.getReader();
    try {
      while (true) {
        if (opts.signal?.aborted) {
          try { await reader.cancel(); } catch { /* ignore */ }
          return;
        }
        const { value, done } = await reader.read();
        if (done) return;
        if (!value || value.byteLength === 0) continue;
        yield {
          pcm: Buffer.from(value.buffer, value.byteOffset, value.byteLength),
          sampleRate: NATIVE_SAMPLE_RATE,
          channels: 1,
          timestamp: performance.now(),
        };
      }
    } catch (err) {
      logger.debug({ err }, 'voice.tts.openai stream error');
      throw err;
    } finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

async function safeText(res: Response): Promise<string> {
  try { return await res.text(); } catch { return ''; }
}

registerTTSProvider('openai', async () => new OpenAITTS());

export { OpenAITTS };
