/**
 * Shared types for the Mercury voice subsystem.
 *
 * Two provider chains, both pluggable:
 *   • TTS: Cartesia Sonic (primary, streaming WS) → OpenAI TTS (fallback, HTTP).
 *   • STT: Cartesia Ink Whisper (primary, streaming WS) → OpenAI Whisper (fallback, HTTP).
 *
 * The audio I/O surface is intentionally narrow so every channel
 * (TUI, Web, Telegram, Termux) can plug into the same VoiceManager.
 */

export type TTSProviderName = 'cartesia' | 'openai' | 'local';
export type STTProviderName = 'cartesia' | 'openai' | 'local';

/** Voice subsystem state, surfaced to the UI status bar. */
export type VoiceState =
  | 'disabled'      // voice.enabled === false in config
  | 'initializing'  // VoiceManager.enable() in flight
  | 'ready'         // warmed and idle
  | 'speaking'      // TTS in flight
  | 'listening'     // STT capturing
  | 'error';        // last init failed; see lastError

/** Microphone lifecycle (state machine in src/voice/audio/recording.ts). */
export type MicState =
  | 'uninitialized'
  | 'probing'
  | 'denied'
  | 'unavailable'   // no device, SSH, etc.
  | 'ready'         // device open, paused
  | 'recording'
  | 'draining'      // recording stopped, awaiting final transcript
  | 'stopped'
  | 'released';     // child process confirmed dead, device free

/** OS-level mic permission state, normalized across platforms. */
export type MicPermissionStatus =
  | 'authorized'
  | 'denied'
  | 'not-determined'
  | 'unavailable';

/** PCM audio chunk. Sample rate / channels are negotiated at backend init. */
export interface AudioChunk {
  /** Interleaved s16le samples. */
  pcm: Buffer;
  /** Hz, e.g. 16000 for STT, 22050 for TTS. */
  sampleRate: number;
  channels: number;
  /** Monotonic timestamp in ms (performance.now-style). */
  timestamp: number;
}

/** Result of an STT call, partial or final. */
export interface TranscriptDelta {
  text: string;
  isFinal: boolean;
  /** 0–1, when the provider reports it. */
  confidence?: number;
}

/** Options for a TTS synthesis call. */
export interface TTSOptions {
  voiceId?: string;
  language?: string;
  /** 0.5–2.0 speech-rate multiplier, when the provider supports it. */
  rate?: number;
  /** Cancellation handle. */
  signal?: AbortSignal;
  /** Optional context id for cross-chunk prosody (Cartesia). */
  contextId?: string;
}

/** Options for an STT call. */
export interface STTOptions {
  language?: string;
  signal?: AbortSignal;
}

/** Voice describes a single TTS voice as advertised by the provider. */
export interface Voice {
  id: string;
  name: string;
  language?: string;
  /** Free-form provider-specific metadata. */
  meta?: Record<string, unknown>;
}

/** Backend capabilities — surfaced to detector + doctor output. */
export interface BackendCapabilities {
  /** True if backend can stream PCM in/out, false if it's file-based. */
  streaming: boolean;
  /** Estimated playback start latency in ms; informational only. */
  latencyMs: number;
  /** True if the backend requires a system binary that must be installed. */
  needsSystemBinary: boolean;
  /** Human-readable hint shown by doctor when unavailable. */
  installHint?: string;
}

/** Per-utterance timing telemetry; populated by VoiceManager. */
export interface VoiceTelemetry {
  ttsFirstTokenAt?: number;
  ttsFirstChunkSentAt?: number;
  ttsFirstAudioFrameAt?: number;
  ttsFirstSpeakerWriteAt?: number;
  ttsEndAt?: number;
  sttPressAt?: number;
  sttFirstFrameAt?: number;
  sttFirstPartialAt?: number;
  sttReleaseAt?: number;
  sttFinalAt?: number;
}
