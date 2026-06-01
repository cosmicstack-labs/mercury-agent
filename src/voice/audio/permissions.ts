/**
 * Microphone permission abstraction (skeleton).
 *
 * Real implementations land in Phase 1+. This file establishes the contract
 * and provides a safe `unavailable` default for every platform so the rest of
 * the voice subsystem can be written and type-checked today.
 *
 * Permission is probed at four points:
 *   1. Onboarding (configure() voice step)
 *   2. `mercury doctor --voice`
 *   3. VoiceManager.enable()  (startup when voice mode is on)
 *   4. First push-to-talk press (user may have just granted)
 *
 * Each platform has its own probe:
 *   • macOS  — `node-mac-permissions` (npm) OR test-capture (Bun-compiled)
 *   • Linux  — /dev/snd/* readable + pactl/pw-cli reachable
 *   • Win    — PowerShell registry query
 *   • Termux — `termux-microphone-record -i`
 *   • SSH    — auto-deny (no audio device in a remote session)
 */
import { runtime } from '../runtime.js';
import type { MicPermissionStatus } from '../types.js';

export interface MicPermission {
  status: MicPermissionStatus;
  /** Whether `request()` can produce an OS-level prompt on this platform. */
  canPrompt: boolean;
  /** Trigger OS permission dialog where supported; resolves with new status. */
  request(): Promise<MicPermissionStatus>;
  /** Human-readable next-step instruction shown by doctor/onboarding. */
  hint(): string;
}

/**
 * Detect current microphone permission state.
 *
 * This is the only public entry point; callers should never construct
 * platform-specific implementations directly. Returns a safe `unavailable`
 * default on platforms not yet implemented so callers can degrade gracefully.
 */
export async function detectMicPermission(): Promise<MicPermission> {
  if (runtime.isSSH) {
    return unavailable('No microphone in SSH session — voice STT requires a local terminal.');
  }
  // Real per-platform probes land in the next brick.
  // For now we return a single "not-determined" default so VoiceManager can
  // proceed in disabled-by-default mode without false negatives.
  switch (runtime.os) {
    case 'macos':
      return notImplemented('macOS mic permission probe');
    case 'linux':
      return notImplemented('Linux mic permission probe');
    case 'windows':
      return notImplemented('Windows mic permission probe');
    case 'android':
      return notImplemented('Termux mic permission probe');
    default:
      return unavailable(`Microphone permission is not supported on ${runtime.os}.`);
  }
}

function unavailable(reason: string): MicPermission {
  return {
    status: 'unavailable',
    canPrompt: false,
    async request() { return 'unavailable'; },
    hint() { return reason; },
  };
}

function notImplemented(_label: string): MicPermission {
  // During scaffolding we report 'not-determined' so onboarding can still
  // proceed. The real probes replace this in Phase 1.
  return {
    status: 'not-determined',
    canPrompt: false,
    async request() { return 'not-determined'; },
    hint() { return 'Voice subsystem not yet enabled; permission probe pending.'; },
  };
}
