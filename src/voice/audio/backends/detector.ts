/**
 * Audio backend detector.
 *
 * Picks the highest-priority backend that reports `isAvailable() === true`.
 * Result is cached for the lifetime of the VoiceManager instance; doctor
 * re-runs detection on demand and prints all probed backends.
 *
 * Priority order (per platform):
 *   macOS   — ffmpeg-streaming → (speaker-native, Phase 1b)
 *   Linux   — ffmpeg-streaming → (speaker-native, Phase 1b)
 *   Windows — ffmpeg-streaming
 *   Termux  — termux-api (Phase 5; not yet implemented)
 *   SSH     — none (auto-disabled)
 *
 * Native backends (skipped when runtime.canLoadNative === false) land in
 * Phase 1b as latency optimizations. The ffmpeg path is the contract:
 * it works in every supported environment including Bun-compiled binaries.
 */
import { runtime } from '../../runtime.js';
import type { AudioBackend } from './base.js';
import { FfmpegStreamingBackend } from './ffmpeg-streaming.js';

export interface BackendDetectionResult {
  backend: AudioBackend | null;
  /** All probed backends and whether they were available. */
  probed: Array<{ name: string; available: boolean; reason?: string }>;
  /** Friendly reason if backend is null. */
  reason?: string;
}

export async function detectBackend(): Promise<BackendDetectionResult> {
  if (runtime.isSSH) {
    return {
      backend: null,
      probed: [],
      reason: 'Voice is disabled in SSH sessions (no local audio device).',
    };
  }
  if (runtime.isTermux) {
    return {
      backend: null,
      probed: [],
      reason: 'Termux backend not yet implemented (Phase 5).',
    };
  }

  const candidates: AudioBackend[] = [
    // Phase 1b will prepend SpeakerNativeBackend here when canLoadNative.
    new FfmpegStreamingBackend(),
  ];

  const probed: BackendDetectionResult['probed'] = [];
  for (const b of candidates) {
    try {
      const ok = await b.isAvailable();
      probed.push({ name: b.name, available: ok });
      if (ok) return { backend: b, probed };
    } catch (err) {
      probed.push({
        name: b.name,
        available: false,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    backend: null,
    probed,
    reason: 'No audio backend available. Install ffmpeg to enable voice.',
  };
}
