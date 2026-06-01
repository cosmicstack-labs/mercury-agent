/**
 * Audio backend detector.
 *
 * Skeleton only. Picks the highest-priority backend that reports
 * isAvailable() === true. Real backend implementations land in Phase 1.
 *
 * The detector runs once per VoiceManager.enable() and caches the result.
 * `doctor --voice` re-runs it on demand and prints all backends with their
 * availability so users can diagnose why a fallback was chosen.
 */
import { runtime } from '../../runtime.js';
import type { AudioBackend } from './base.js';

export interface BackendDetectionResult {
  backend: AudioBackend | null;
  /** All probed backends and whether they were available. */
  probed: Array<{ name: string; available: boolean; reason?: string }>;
  /** Friendly reason if backend is null. */
  reason?: string;
}

/**
 * Detect the best available audio backend for this host.
 *
 * The implementation here is intentionally empty for Phase 0. Returning
 * `{ backend: null }` is the correct "voice unavailable" outcome and lets
 * the manager render a clean status without throwing.
 */
export async function detectBackend(): Promise<BackendDetectionResult> {
  // Phase 1 will register backends here in priority order, e.g.:
  //
  //   const candidates: AudioBackend[] = [];
  //   if (runtime.isTermux) {
  //     candidates.push(new TermuxBackend());
  //   } else {
  //     if (runtime.canLoadNative) candidates.push(new SpeakerNativeBackend());
  //     candidates.push(new FfmpegStreamingBackend());
  //     if (runtime.os === 'linux' || runtime.os === 'macos') {
  //       candidates.push(new UnixToolsBackend());
  //     }
  //     if (runtime.os === 'windows') candidates.push(new WindowsDshowBackend());
  //   }
  //   for (const c of candidates) {
  //     if (await c.isAvailable()) return { backend: c, probed: [...] };
  //   }

  return {
    backend: null,
    probed: [],
    reason: `Voice backends not yet implemented for ${runtime.describe()}.`,
  };
}
