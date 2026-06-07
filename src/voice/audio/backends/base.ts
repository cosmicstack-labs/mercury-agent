/**
 * AudioBackend — the abstraction every voice provider talks through.
 *
 * The detector picks one backend per session based on (a) the OS, (b) the
 * runtime (Node vs Bun-compiled), and (c) which system binaries / native
 * modules are present. Providers stay backend-agnostic.
 *
 * Backend priority order is fixed per platform in `detector.ts`:
 *   macOS   — speaker-native → ffmpeg-streaming → afplay
 *   Linux   — speaker-native → ffmpeg-streaming → unix-tools (paplay/aplay)
 *   Windows — speaker-native → ffmpeg-streaming (dshow)
 *   Termux  — termux-api (only option)
 *   Bun     — native paths skipped automatically via runtime.canLoadNative
 */
import type { AudioChunk, BackendCapabilities } from '../../types.js';

/** Sink for outgoing audio (TTS playback). */
export interface PlaybackSink {
  /** Push a chunk; resolves once accepted (not necessarily played). */
  write(chunk: AudioChunk): Promise<void>;
  /** Wait for the queue to drain (audio fully played). */
  drain(): Promise<void>;
  /** Cancel any pending audio immediately (used for barge-in). */
  flush(): Promise<void>;
  /** Release resources. Must be idempotent. */
  close(): Promise<void>;
  /**
   * True when the underlying playback process/stream is still usable
   * for new writes. False once it has exited, errored, or been closed.
   * Callers should re-init the sink when this returns false — otherwise
   * subsequent writes silently disappear (this was the second-message
   * TTS bug: ffplay exits after drain(), the cached sink reads back as
   * "dead", and any further frames go to a closed pipe).
   */
  isAlive(): boolean;
}

/** Source of incoming audio (STT capture). */
export interface RecordingSource {
  /** Async iterator of raw PCM frames. */
  frames(): AsyncIterable<AudioChunk>;
  /** Stop capture and release the device. Must be idempotent. */
  stop(): Promise<void>;
  /** PID of the underlying child process, when applicable. */
  pid?: number;
}

export interface PlaybackOptions {
  sampleRate: number;       // e.g. 22050 for Cartesia
  channels: number;         // 1 for mono
  bitDepth?: 16;            // s16le only for now
  signal?: AbortSignal;
}

export interface RecordingOptions {
  sampleRate: number;       // 16000 for Cartesia Ink Whisper
  channels: number;         // 1
  /** Preferred frame size in samples (20ms @ 16kHz = 320). */
  frameSize?: number;
  /** When provided, force a specific input device. */
  deviceId?: string;
  signal?: AbortSignal;
}

/** Backend contract. All methods may throw; the detector probes via isAvailable(). */
export interface AudioBackend {
  /** Stable identifier shown in status bar (e.g. "speaker-native"). */
  readonly name: string;
  readonly capabilities: BackendCapabilities;
  /** Cheap probe — must not allocate device handles. */
  isAvailable(): Promise<boolean>;
  initPlayback(opts: PlaybackOptions): Promise<PlaybackSink>;
  initRecording(opts: RecordingOptions): Promise<RecordingSource>;
}
