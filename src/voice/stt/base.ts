/**
 * BaseSTTProvider — contract every STT implementation honors.
 *
 * Symmetric to BaseTTSProvider. Providers consume an async iterator of
 * PCM frames (16kHz s16le mono in Phase 2) and emit TranscriptDelta
 * objects — partials while audio is flowing, then a single final delta
 * after the stream ends.
 *
 * Streaming-capable providers (Cartesia Ink Whisper) emit partials in
 * real time; HTTP-only providers (OpenAI Whisper) buffer audio to the
 * end and emit one final delta. The VoiceManager treats both uniformly.
 */
import type { AudioChunk, STTOptions, TranscriptDelta } from '../types.js';

export interface STTCapabilities {
  /** True when the provider yields partial transcripts mid-stream. */
  streaming: boolean;
  /** Sample rate the provider expects on input PCM frames. */
  requiredSampleRate: number;
  /** Channels expected on input. */
  requiredChannels: number;
}

export abstract class BaseSTTProvider {
  abstract readonly name: string;
  abstract readonly capabilities: STTCapabilities;

  abstract isAvailable(): Promise<boolean>;

  /**
   * Transcribe a stream of PCM frames. Implementations must:
   *   - Yield partials as `{ isFinal: false, text }` whenever possible.
   *   - Yield a single `{ isFinal: true, text }` after the audio iterator
   *     completes (or on cancellation).
   *   - Honor opts.signal: abort the underlying WS/HTTP within ≤200ms.
   *   - Never throw past the first final delta — late errors must be
   *     swallowed and logged.
   */
  abstract transcribe(
    frames: AsyncIterable<AudioChunk>,
    opts: STTOptions,
  ): AsyncIterable<TranscriptDelta>;

  /** Tear down any persistent resources. Idempotent. */
  async dispose(): Promise<void> { /* default no-op */ }
}
