/**
 * CartesiaSTT — primary STT provider using Ink Whisper over WebSocket.
 *
 * Endpoint: wss://api.cartesia.ai/stt/websocket
 *   Query params: api_key, cartesia_version, model, encoding, sample_rate,
 *                 container, language.
 *
 * Protocol (Cartesia STT v1):
 *   client → binary PCM frames (s16le, 16kHz, mono)
 *   client → text "finalize" or { type: "finalize" } to flush
 *   client → text "done"     or { type: "done" }     to close gracefully
 *   server → { type: "transcript", text, is_final, language? }
 *           | { type: "flush_done" }
 *           | { type: "done" }
 *           | { type: "error", message }
 *
 * Connection model:
 *   One WS per transcribe() call. Ink Whisper is cheap to (re)open
 *   (~80–150ms) and the per-utterance lifetime is naturally bounded by
 *   PTT release. Keeping a persistent socket would require multiplexing
 *   utterances which adds complexity for no latency gain.
 *
 * Frames are forwarded as fast as the recorder yields them. We do NOT
 * accumulate — backpressure on the WS is handled by ws's internal queue;
 * if it grows beyond a threshold we log and continue (audio chunks are
 * tiny, ~640 bytes for a 20ms frame at 16kHz).
 */
import { WebSocket } from 'ws';
import { BaseSTTProvider, type STTCapabilities } from './base.js';
import { registerSTTProvider } from './registry.js';
import type { AudioChunk, STTOptions, TranscriptDelta } from '../types.js';
import { loadConfig } from '../../utils/config.js';
import { logger } from '../../utils/logger.js';

const WS_URL = 'wss://api.cartesia.ai/stt/websocket';
const CARTESIA_VERSION = '2024-11-13';
const REQUIRED_SAMPLE_RATE = 16000;
const REQUIRED_CHANNELS = 1;
const CONNECT_TIMEOUT_MS = 4000;
const FINAL_TIMEOUT_MS = 5000;

class CartesiaSTT extends BaseSTTProvider {
  readonly name = 'cartesia';
  readonly capabilities: STTCapabilities = {
    streaming: true,
    requiredSampleRate: REQUIRED_SAMPLE_RATE,
    requiredChannels: REQUIRED_CHANNELS,
  };

  private consecutiveFailures = 0;

  isAvailable(): Promise<boolean> {
    if (this.consecutiveFailures >= 3) return Promise.resolve(false);
    return Promise.resolve(!!process.env.CARTESIA_API_KEY?.trim());
  }

  async *transcribe(
    frames: AsyncIterable<AudioChunk>,
    opts: STTOptions,
  ): AsyncIterable<TranscriptDelta> {
    const key = process.env.CARTESIA_API_KEY?.trim();
    if (!key) throw new Error('Cartesia STT: CARTESIA_API_KEY required');

    const cfg = loadConfig().voice?.stt?.cartesia;
    const model = cfg?.model ?? 'ink-whisper';
    const language = opts.language ?? cfg?.language ?? 'auto';

    const url = new URL(WS_URL);
    url.searchParams.set('api_key', key);
    url.searchParams.set('cartesia_version', CARTESIA_VERSION);
    url.searchParams.set('model', model);
    url.searchParams.set('encoding', 'pcm_s16le');
    url.searchParams.set('sample_rate', String(REQUIRED_SAMPLE_RATE));
    url.searchParams.set('container', 'raw');
    if (language && language !== 'auto') {
      url.searchParams.set('language', language);
    }

    const ws = new WebSocket(url.toString());

    // Bounded async queue for transcript deltas.
    const deltas: TranscriptDelta[] = [];
    let done = false;
    let error: Error | null = null;
    let waiter: (() => void) | null = null;
    const wake = () => { if (waiter) { const w = waiter; waiter = null; w(); } };

    const onAbort = () => {
      try { ws.close(1000, 'abort'); } catch { /* ignore */ }
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    // Wait for socket open before sending anything.
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          try { ws.terminate(); } catch { /* ignore */ }
          reject(new Error('Cartesia STT connect timeout'));
        }, CONNECT_TIMEOUT_MS);
        ws.once('open', () => { clearTimeout(timer); resolve(); });
        ws.once('error', (err) => { clearTimeout(timer); reject(err); });
      });
    } catch (err) {
      this.consecutiveFailures++;
      opts.signal?.removeEventListener('abort', onAbort);
      throw err;
    }

    ws.on('message', (raw) => {
      let msg: any;
      try { msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8')); }
      catch { return; }
      if (msg?.type === 'transcript' && typeof msg.text === 'string') {
        deltas.push({
          text: msg.text,
          isFinal: !!msg.is_final,
          confidence: typeof msg.confidence === 'number' ? msg.confidence : undefined,
        });
        wake();
      } else if (msg?.type === 'error') {
        error = new Error(`Cartesia STT: ${msg.message ?? 'unknown'}`);
        done = true;
        wake();
      } else if (msg?.type === 'done') {
        done = true;
        wake();
      }
    });

    ws.on('close', () => { done = true; wake(); });
    ws.on('error', (err) => { logger.debug({ err }, 'voice.stt.cartesia ws error'); });

    // Pump audio frames in the background.
    const pump = (async () => {
      try {
        for await (const frame of frames) {
          if (opts.signal?.aborted) break;
          if (ws.readyState !== WebSocket.OPEN) break;
          ws.send(frame.pcm);
        }
      } catch (err) {
        logger.debug({ err }, 'voice.stt.cartesia frame pump error');
      } finally {
        // Tell server to flush and close gracefully.
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.send('finalize'); } catch { /* ignore */ }
          try { ws.send('done'); } catch { /* ignore */ }
        }
        // Force-close if server doesn't respond.
        setTimeout(() => {
          if (ws.readyState !== WebSocket.CLOSED) {
            try { ws.close(1000, 'final timeout'); } catch { /* ignore */ }
          }
        }, FINAL_TIMEOUT_MS);
      }
    })();

    try {
      while (true) {
        if (opts.signal?.aborted) return;
        while (deltas.length > 0) {
          const d = deltas.shift()!;
          yield d;
        }
        if (done) {
          if (error) throw error;
          this.consecutiveFailures = 0;
          return;
        }
        await new Promise<void>((resolve) => { waiter = resolve; });
      }
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
      await pump.catch(() => {});
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        try { ws.close(); } catch { /* ignore */ }
      }
    }
  }
}

registerSTTProvider('cartesia', async () => new CartesiaSTT());

export { CartesiaSTT };
