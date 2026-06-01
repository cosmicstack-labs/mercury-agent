/**
 * CartesiaTTS — primary TTS provider.
 *
 * Uses Cartesia's Sonic-2 model over a persistent WebSocket at
 * `wss://api.cartesia.ai/tts/websocket`. The connection is opened lazily
 * on first synthesize() call and kept warm for the lifetime of the
 * VoiceManager.
 *
 * Streaming protocol (Cartesia v1 WS):
 *   client → { context_id, model_id, voice, output_format, transcript, continue }
 *   server → { context_id, type: "chunk",  data: <base64 pcm s16le> }
 *           | { context_id, type: "done"  }
 *           | { context_id, type: "error", error: string }
 *
 * Cross-chunk prosody is preserved by reusing the same `context_id` for
 * every chunk of a single utterance and setting `continue:true` on all
 * but the final chunk. The final chunk omits `continue` (or sets false)
 * which tells Cartesia to flush and end the context.
 *
 * One WS instance per provider. Concurrent utterances are serialized at
 * the VoiceManager level — Phase 1 has a single agent voice at a time.
 *
 * Errors / disconnects: the provider attempts a single reconnect on the
 * next synthesize() call. Repeated failures cause isAvailable() to
 * return false so the VoiceManager falls through to OpenAI.
 */
import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { BaseTTSProvider, type TTSCapabilities } from './base.js';
import { registerTTSProvider } from './registry.js';
import type { AudioChunk, TTSOptions, Voice } from '../types.js';
import { loadConfig } from '../../utils/config.js';
import { getCartesiaApiKey } from '../credentials.js';
import { logger } from '../../utils/logger.js';

const WS_URL = 'wss://api.cartesia.ai/tts/websocket';
const REST_BASE = 'https://api.cartesia.ai';
const CARTESIA_VERSION = '2024-11-13';
const NATIVE_SAMPLE_RATE = 22050;
const CONNECT_TIMEOUT_MS = 4000;
const CHUNK_AWAIT_TIMEOUT_MS = 15_000;

interface PendingContext {
  id: string;
  // FIFO of {resolve, reject} for chunk-end signaling.
  resolveDone: () => void;
  rejectDone: (err: Error) => void;
  // Bounded queue of audio frames awaiting consumption.
  queue: AudioChunk[];
  // Resolvers registered while queue is empty (single-reader contract).
  pendingResolver: ((c: AudioChunk | null) => void) | null;
  done: boolean;
  error: Error | null;
}

class CartesiaTTS extends BaseTTSProvider {
  readonly name = 'cartesia';
  readonly capabilities: TTSCapabilities = {
    streaming: true,
    nativeSampleRate: NATIVE_SAMPLE_RATE,
  };

  private ws: WebSocket | null = null;
  private wsReady: Promise<WebSocket> | null = null;
  private contexts = new Map<string, PendingContext>();
  private consecutiveFailures = 0;
  private disposed = false;

  isAvailable(): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    const key = getCartesiaApiKey();
    if (!key) return Promise.resolve(false);
    // After 3 consecutive failures, mark unavailable until next process.
    return Promise.resolve(this.consecutiveFailures < 3);
  }

  async listVoices(): Promise<Voice[]> {
    const key = getCartesiaApiKey();
    if (!key) return [];
    try {
      const res = await fetch(`${REST_BASE}/voices`, {
        headers: {
          'X-API-Key': key,
          'Cartesia-Version': CARTESIA_VERSION,
        },
      });
      if (!res.ok) return [];
      const json = (await res.json()) as { id?: string; name?: string; language?: string }[] | { data?: any[] };
      const list = Array.isArray(json) ? json : (json as any).data ?? [];
      return list
        .filter((v: any) => v && v.id)
        .map((v: any) => ({
          id: String(v.id),
          name: String(v.name ?? v.id),
          language: v.language,
          meta: v,
        }));
    } catch (err) {
      logger.debug({ err }, 'voice.tts.cartesia listVoices failed');
      return [];
    }
  }

  async *synthesize(text: string, opts: TTSOptions): AsyncIterable<AudioChunk> {
    yield* this.synthesizeChunks(this.singleChunk(text), opts);
  }

  override async *synthesizeStream(
    textChunks: AsyncIterable<string>,
    opts: TTSOptions,
  ): AsyncIterable<AudioChunk> {
    yield* this.synthesizeChunks(textChunks, opts);
  }

  override async dispose(): Promise<void> {
    this.disposed = true;
    const ws = this.ws;
    this.ws = null;
    this.wsReady = null;
    for (const ctx of this.contexts.values()) {
      ctx.error = new Error('TTS disposed');
      ctx.done = true;
      ctx.pendingResolver?.(null);
      ctx.pendingResolver = null;
    }
    this.contexts.clear();
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      try { ws.close(1000, 'dispose'); } catch { /* ignore */ }
    }
  }

  /* ── Internal ──────────────────────────────────────────────────────── */

  private async *singleChunk(text: string): AsyncIterable<string> {
    yield text;
  }

  private async *synthesizeChunks(
    texts: AsyncIterable<string>,
    opts: TTSOptions,
  ): AsyncIterable<AudioChunk> {
    if (opts.signal?.aborted) return;

    const cfg = loadConfig().voice?.tts?.cartesia;
    const voiceId = opts.voiceId ?? cfg?.voiceId;
    const model = cfg?.model ?? 'sonic-2';
    const language = opts.language ?? cfg?.language ?? 'en';

    if (!voiceId) {
      throw new Error('Cartesia TTS: voice ID not configured (set CARTESIA_VOICE_ID or voice.tts.cartesia.voiceId)');
    }

    const contextId = opts.contextId ?? randomUUID();
    const ctx = this.openContext(contextId);

    // Abort handling: cancel context immediately on signal.
    const onAbort = () => {
      this.cancelContext(contextId, new Error('aborted'));
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const ws = await this.ensureWS();

      // Buffer the text iterator so we know which chunk is last.
      let lastSent: string | null = null;
      const buffered: string[] = [];
      for await (const t of texts) {
        if (opts.signal?.aborted) break;
        if (lastSent !== null) {
          this.sendChunk(ws, contextId, lastSent, voiceId, model, language, /* isFinal */ false);
        }
        lastSent = t;
        // Drain any audio that's already arrived between chunk sends.
        while (true) {
          const frame = ctx.queue.shift();
          if (!frame) break;
          buffered.push('frame');
          yield frame;
        }
      }
      // Send the final chunk (or an empty terminator if no text arrived).
      this.sendChunk(ws, contextId, lastSent ?? '', voiceId, model, language, /* isFinal */ true);

      // Drain frames until context completes.
      while (true) {
        if (opts.signal?.aborted) break;
        const frame = ctx.queue.shift();
        if (frame) {
          yield frame;
          continue;
        }
        if (ctx.done) break;
        const next = await this.awaitFrame(ctx);
        if (!next) break;
        yield next;
      }
      if (ctx.error) throw ctx.error;
      this.consecutiveFailures = 0;
    } catch (err) {
      this.consecutiveFailures++;
      logger.warn({ err, contextId }, 'voice.tts.cartesia synth failed');
      throw err;
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
      this.contexts.delete(contextId);
    }
  }

  private openContext(id: string): PendingContext {
    const ctx: PendingContext = {
      id,
      resolveDone: () => {},
      rejectDone: () => {},
      queue: [],
      pendingResolver: null,
      done: false,
      error: null,
    };
    this.contexts.set(id, ctx);
    return ctx;
  }

  private cancelContext(id: string, err: Error): void {
    const ctx = this.contexts.get(id);
    if (!ctx) return;
    ctx.error = err;
    ctx.done = true;
    ctx.pendingResolver?.(null);
    ctx.pendingResolver = null;
    // Best-effort cancel on server side.
    try {
      const ws = this.ws;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ context_id: id, cancel: true }));
      }
    } catch { /* ignore */ }
  }

  private awaitFrame(ctx: PendingContext): Promise<AudioChunk | null> {
    return new Promise<AudioChunk | null>((resolve) => {
      ctx.pendingResolver = resolve;
      // Safety timeout: if nothing arrives within 15 s, treat as failure.
      const timer = setTimeout(() => {
        if (ctx.pendingResolver === resolve) {
          ctx.pendingResolver = null;
          ctx.error = ctx.error ?? new Error('Cartesia TTS chunk timeout');
          ctx.done = true;
          resolve(null);
        }
      }, CHUNK_AWAIT_TIMEOUT_MS);
      // Wrap to clear timer when resolved by message handler.
      const orig = ctx.pendingResolver;
      ctx.pendingResolver = (c) => { clearTimeout(timer); orig(c); };
    });
  }

  private sendChunk(
    ws: WebSocket,
    contextId: string,
    text: string,
    voiceId: string,
    model: string,
    language: string,
    isFinal: boolean,
  ): void {
    const payload = {
      context_id: contextId,
      model_id: model,
      transcript: text,
      voice: { mode: 'id', id: voiceId },
      language,
      output_format: {
        container: 'raw',
        encoding: 'pcm_s16le',
        sample_rate: NATIVE_SAMPLE_RATE,
      },
      continue: !isFinal,
    };
    try {
      ws.send(JSON.stringify(payload));
    } catch (err) {
      logger.warn({ err, contextId }, 'voice.tts.cartesia ws.send failed');
      throw err;
    }
  }

  private async ensureWS(): Promise<WebSocket> {
    if (this.disposed) throw new Error('Cartesia TTS disposed');
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return this.ws;
    if (this.wsReady) return this.wsReady;

    const key = getCartesiaApiKey();
    if (!key) throw new Error('CARTESIA_API_KEY is required');

    this.wsReady = new Promise<WebSocket>((resolve, reject) => {
      const url = `${WS_URL}?api_key=${encodeURIComponent(key)}&cartesia_version=${encodeURIComponent(CARTESIA_VERSION)}`;
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        reject(new Error('Cartesia TTS connect timeout'));
        try { ws.terminate(); } catch { /* ignore */ }
      }, CONNECT_TIMEOUT_MS);

      ws.once('open', () => {
        clearTimeout(timer);
        this.ws = ws;
        this.attachHandlers(ws);
        resolve(ws);
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        this.wsReady = null;
        reject(err);
      });
    });

    try {
      return await this.wsReady;
    } catch (err) {
      this.wsReady = null;
      throw err;
    }
  }

  private attachHandlers(ws: WebSocket): void {
    ws.on('message', (data) => this.handleMessage(data));
    ws.on('close', (code, reason) => {
      logger.debug({ code, reason: reason.toString() }, 'voice.tts.cartesia ws closed');
      if (this.ws === ws) {
        this.ws = null;
        this.wsReady = null;
      }
      // Fail any in-flight contexts so consumers can fall back.
      for (const ctx of this.contexts.values()) {
        if (!ctx.done) {
          ctx.error = new Error(`Cartesia WS closed (${code})`);
          ctx.done = true;
          ctx.pendingResolver?.(null);
          ctx.pendingResolver = null;
        }
      }
    });
    ws.on('error', (err) => {
      logger.warn({ err }, 'voice.tts.cartesia ws error');
    });
  }

  private handleMessage(raw: any): void {
    let msg: any;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
    } catch {
      return;
    }
    const id: string | undefined = msg?.context_id;
    if (!id) return;
    const ctx = this.contexts.get(id);
    if (!ctx) return;

    if (msg.type === 'chunk' && typeof msg.data === 'string') {
      const buf = Buffer.from(msg.data, 'base64');
      const frame: AudioChunk = {
        pcm: buf,
        sampleRate: NATIVE_SAMPLE_RATE,
        channels: 1,
        timestamp: performance.now(),
      };
      if (ctx.pendingResolver) {
        const r = ctx.pendingResolver;
        ctx.pendingResolver = null;
        r(frame);
      } else {
        ctx.queue.push(frame);
      }
    } else if (msg.type === 'done') {
      ctx.done = true;
      if (ctx.pendingResolver) {
        const r = ctx.pendingResolver;
        ctx.pendingResolver = null;
        r(null);
      }
    } else if (msg.type === 'error') {
      ctx.error = new Error(`Cartesia: ${msg.error ?? 'unknown'}`);
      ctx.done = true;
      if (ctx.pendingResolver) {
        const r = ctx.pendingResolver;
        ctx.pendingResolver = null;
        r(null);
      }
    }
  }
}

// Module-load registration: registry composes the chain on demand.
registerTTSProvider('cartesia', async () => new CartesiaTTS());

export { CartesiaTTS };
