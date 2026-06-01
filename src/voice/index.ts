/**
 * Public entry point for the voice subsystem.
 *
 * Channels import from this barrel only; internal layout may shift.
 */
export { getVoiceManager, VoiceManager } from './manager.js';
export { runtime } from './runtime.js';
export type {
  VoiceState,
  MicState,
  MicPermissionStatus,
  TTSProviderName,
  STTProviderName,
  AudioChunk,
  TranscriptDelta,
  TTSOptions,
  STTOptions,
  Voice,
  VoiceTelemetry,
} from './types.js';
export type { VoiceStatusSnapshot } from './manager.js';
