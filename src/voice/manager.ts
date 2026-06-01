/**
 * VoiceManager — the single object channels talk to for voice I/O.
 *
 * Responsibilities (filled in incrementally across phases):
 *   • Own the active TTS and STT providers, with fallback chains.
 *   • Hold the audio backend (playback sink + recording source).
 *   • Manage the microphone lifecycle (probe → ready → recording → released).
 *   • Run the buffered streaming pipeline (text deltas → sentence chunks →
 *     synthesized audio frames → speaker) with bounded backpressure.
 *   • Surface state to the UI (status bar, /voice status).
 *
 * Phase 0 scope: enable/disable lifecycle, state reporting, no real I/O.
 */
import { EventEmitter } from 'node:events';
import { runtime } from './runtime.js';
import { detectMicPermission, type MicPermission } from './audio/permissions.js';
import { detectBackend, type BackendDetectionResult } from './audio/backends/detector.js';
import type { VoiceState, MicState } from './types.js';
import { loadConfig } from '../utils/config.js';

export interface VoiceStatusSnapshot {
  state: VoiceState;
  micState: MicState;
  micPermission: MicPermission['status'];
  ttsProvider: string | null;
  sttProvider: string | null;
  backend: string | null;
  reason?: string;
  /** Last error message if state === 'error'. */
  lastError?: string;
}

export class VoiceManager extends EventEmitter {
  private state: VoiceState = 'disabled';
  private micState: MicState = 'uninitialized';
  private micPermission: MicPermission['status'] = 'not-determined';
  private backendInfo: BackendDetectionResult | null = null;
  private lastError: string | null = null;

  // Provider slots, populated in Phase 1+ when registries land.
  private ttsProviderName: string | null = null;
  private sttProviderName: string | null = null;

  /**
   * Enable the voice subsystem. Idempotent — calling twice is a no-op once
   * READY. Resolves when initialization completes (or errors out cleanly).
   */
  async enable(): Promise<void> {
    if (this.state !== 'disabled' && this.state !== 'error') return;

    this.setState('initializing');
    this.lastError = null;
    try {
      const cfg = loadConfig();
      if (!cfg.voice?.enabled) {
        // Config flag overrides programmatic enable; useful for /voice on
        // to actually persist the flag before calling enable().
        this.setState('disabled');
        return;
      }

      // Step 1: probe permission (cheap, no allocation).
      const perm = await detectMicPermission();
      this.micPermission = perm.status;
      this.micState = perm.status === 'authorized' ? 'ready'
                    : perm.status === 'denied' ? 'denied'
                    : 'probing';

      // Step 2: detect audio backend.
      this.backendInfo = await detectBackend();

      // Step 3: TTS/STT providers come online in Phase 1.
      this.ttsProviderName = cfg.voice.tts?.provider ?? null;
      this.sttProviderName = cfg.voice.stt?.provider ?? null;

      // Phase 0: even if everything probes successfully, we report 'ready'
      // but no audio actually flows until later phases land providers.
      if (!this.backendInfo.backend) {
        this.setState('error');
        this.lastError = this.backendInfo.reason ?? 'No audio backend available.';
        return;
      }

      this.setState('ready');
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.setState('error');
    }
  }

  /**
   * Disable voice; releases mic, drains TTS, closes backend handles.
   * Idempotent. Must be safe to call from process-exit handlers.
   */
  async disable(): Promise<void> {
    if (this.state === 'disabled') return;
    // Real teardown lands with the mic lifecycle brick. For now just flip state.
    this.micState = 'released';
    this.setState('disabled');
  }

  getStatus(): VoiceStatusSnapshot {
    return {
      state: this.state,
      micState: this.micState,
      micPermission: this.micPermission,
      ttsProvider: this.ttsProviderName,
      sttProvider: this.sttProviderName,
      backend: this.backendInfo?.backend?.name ?? null,
      reason: this.backendInfo?.reason,
      lastError: this.lastError ?? undefined,
    };
  }

  /** Short description for the status bar (e.g. "🔊 ready · cartesia"). */
  formatStatusLine(): string {
    const s = this.getStatus();
    switch (s.state) {
      case 'disabled':     return 'Voice: off';
      case 'initializing': return 'Voice: warming…';
      case 'ready':        return `Voice: ready · ${s.ttsProvider ?? '-'}/${s.sttProvider ?? '-'}`;
      case 'speaking':     return '🔊 speaking';
      case 'listening':    return '🎙 listening';
      case 'error':        return `Voice: error · ${s.lastError ?? 'unknown'}`;
    }
  }

  /** Diagnostic dump for /voice status. */
  describe(): string {
    const s = this.getStatus();
    const lines = [
      `state:        ${s.state}`,
      `mic state:    ${s.micState}`,
      `mic perm:     ${s.micPermission}`,
      `TTS provider: ${s.ttsProvider ?? '(none)'}`,
      `STT provider: ${s.sttProvider ?? '(none)'}`,
      `backend:      ${s.backend ?? '(none)'}`,
      `runtime:      ${runtime.describe()}`,
    ];
    if (s.reason)     lines.push(`reason:       ${s.reason}`);
    if (s.lastError)  lines.push(`last error:   ${s.lastError}`);
    return lines.join('\n');
  }

  private setState(next: VoiceState): void {
    if (this.state === next) return;
    const prev = this.state;
    this.state = next;
    this.emit('state', { from: prev, to: next });
  }
}

/* ── Module-level singleton ────────────────────────────────────────────── */

let _instance: VoiceManager | null = null;

export function getVoiceManager(): VoiceManager {
  if (!_instance) _instance = new VoiceManager();
  return _instance;
}

/** For tests. Not exported from the package index. */
export function _resetVoiceManagerForTests(): void {
  _instance = null;
}
