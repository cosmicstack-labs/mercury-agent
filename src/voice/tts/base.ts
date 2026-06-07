/**
 * BaseTTSProvider — contract every TTS implementation honors.
 *
 * Two backends ship in Phase 1:
 *   - CartesiaTTS  (primary)  — persistent WebSocket, streaming PCM
 *   - OpenAITTS    (fallback) — HTTP audio.speech, buffered
 *
 * Providers emit `AudioChunk`s; the VoiceManager pipes them into the
 * active AudioBackend's PlaybackSink. Providers must not assume a
 * particular sample rate; the consumer asks for what it wants via opts.
 */
import type { AudioChunk, TTSOptions, Voice } from '../types.js';

export interface TTSCapabilities {
  /** True when the provider can synthesize while text is still streaming. */
  streaming: boolean;
  /** PCM sample rate this provider emits natively (best to match playback). */
  nativeSampleRate: number;
}

export abstract class BaseTTSProvider {
  abstract readonly name: string;
  abstract readonly capabilities: TTSCapabilities;

  /** Cheap readiness check (key present, network reachable, etc.). */
  abstract isAvailable(): Promise<boolean>;

  /** Voices available to this provider (cached after first call by callers). */
  abstract listVoices(): Promise<Voice[]>;

  /**
   * Synthesize a single string into PCM frames.
   * Used by all providers; non-streaming providers buffer internally.
   */
  abstract synthesize(text: string, opts: TTSOptions): AsyncIterable<AudioChunk>;

  /**
   * Synthesize a streaming sequence of text chunks. Default implementation
   * concatenates each chunk's audio sequentially; streaming-capable
   * providers (Cartesia) override to maintain a shared context for prosody.
   */
  async *synthesizeStream(
    textChunks: AsyncIterable<string>,
    opts: TTSOptions,
  ): AsyncIterable<AudioChunk> {
    for await (const text of textChunks) {
      if (!text) continue;
      if (opts.signal?.aborted) return;
      yield* this.synthesize(text, opts);
    }
  }

  /** Tear down any persistent resources (sockets, timers). Idempotent. */
  async dispose(): Promise<void> { /* default no-op */ }
}
