/**
 * VoiceManager — the single object channels talk to for voice I/O.
 *
 * Responsibilities:
 *   • Own the active TTS and STT providers, with fallback chains.
 *   • Hold the audio backend (playback sink + recording source).
 *   • Manage the microphone lifecycle (probe → ready → recording → released).
 *   • Run the buffered streaming pipeline (text deltas → sentence chunks →
 *     synthesized audio frames → speaker) with bounded backpressure.
 *   • Surface state to the UI (status bar, /voice status).
 *
 * Pipeline (speakStream):
 *   text deltas ──► SentenceBuffer ──► TTS provider ──► PlaybackSink
 *                                                       (with abort signal)
 *
 * Backpressure: the TTS provider yields async — if the sink rejects writes
 * (full queue), we await before requesting more chunks. SentenceBuffer
 * holds the unsent text tail; channels call ttsTick() on a 50 ms timer
 * to enforce time-based flush rules.
 *
 * Cancellation: cancelSpeaking() aborts the current AbortController which
 * propagates to (a) the TTS provider's WebSocket/HTTP request,
 * (b) the SentenceBuffer feeder, and (c) the PlaybackSink.flush(). All
 * three are designed to return within ≤50 ms.
 */
import { EventEmitter } from 'node:events';
import { runtime } from './runtime.js';
import { detectMicPermission, type MicPermission } from './audio/permissions.js';
import { detectBackend, type BackendDetectionResult } from './audio/backends/detector.js';
import type { AudioBackend, PlaybackSink } from './audio/backends/base.js';
import type { VoiceState, MicState, AudioChunk } from './types.js';
import { loadConfig } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { SentenceBuffer } from './buffering.js';
import { pickReadyTTS, disposeTTSProviders } from './tts/registry.js';
import { pickReadySTT, disposeSTTProviders } from './stt/registry.js';
import type { TranscriptDelta } from './types.js';
import type { RecordingSource } from './audio/backends/base.js';

// Module-load registration: importing the provider modules registers them
// with the registries. Keep these imports ordered so the preferred
// provider lands first.
import './tts/cartesia.js';
import './tts/openai.js';
import './stt/cartesia.js';
import './stt/openai.js';

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

export interface SpeakOptions {
  /** Optional external abort signal; combined with internal one. */
  signal?: AbortSignal;
  /** Skip pipeline entirely when false; useful for "muted" auto-speak. */
  enabled?: boolean;
}

export interface ListenOptions {
  /** Language hint passed to the STT provider ("auto" picks). */
  language?: string;
  /** Called for every partial / final transcript delta. */
  onDelta?: (delta: TranscriptDelta) => void;
  /** Optional external abort signal. */
  signal?: AbortSignal;
}

export interface ListenResult {
  /** Aggregated final transcript text (may be empty). */
  text: string;
  /** True if the user/system aborted before a final arrived. */
  aborted: boolean;
}

export class VoiceManager extends EventEmitter {
  private state: VoiceState = 'disabled';
  private micState: MicState = 'uninitialized';
  private micPermission: MicPermission['status'] = 'not-determined';
  private backendInfo: BackendDetectionResult | null = null;
  private lastError: string | null = null;

  private ttsProviderName: string | null = null;
  private sttProviderName: string | null = null;

  private backend: AudioBackend | null = null;
  private playback: PlaybackSink | null = null;
  private playbackSampleRate = 0;

  // Active speak controller — non-null while TTS is in flight.
  private speakAbort: AbortController | null = null;
  // Active listen controller — non-null while STT is in flight.
  private listenAbort: AbortController | null = null;
  private recording: RecordingSource | null = null;
  // Cached permission probe so we can call request() without re-running detect.
  private micPermissionHandle: MicPermission | null = null;

  /**
   * Enable the voice subsystem. Idempotent.
   */
  async enable(): Promise<void> {
    if (this.state !== 'disabled' && this.state !== 'error') return;

    this.setState('initializing');
    this.lastError = null;
    try {
      const cfg = loadConfig();
      if (!cfg.voice?.enabled) {
        this.setState('disabled');
        return;
      }

      // 1. Probe mic permission (best-effort; TTS works without it).
      const perm = await detectMicPermission();
      this.micPermissionHandle = perm;
      this.micPermission = perm.status;
      this.micState = perm.status === 'authorized' ? 'ready'
                    : perm.status === 'denied' ? 'denied'
                    : 'probing';

      // 2. Detect audio backend.
      this.backendInfo = await detectBackend();
      if (!this.backendInfo.backend) {
        this.setState('error');
        this.lastError = this.backendInfo.reason ?? 'No audio backend available.';
        return;
      }
      this.backend = this.backendInfo.backend;

      // 3. Pick TTS provider (with fallback walked by registry).
      const tts = await pickReadyTTS();
      this.ttsProviderName = tts ? tts.name : null;

      // 4. Pick STT provider similarly.
      const stt = await pickReadySTT();
      this.sttProviderName = stt ? stt.name : null;

      // TTS unavailability is non-fatal; user may still grant access later.
      this.setState('ready');
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.setState('error');
    }
  }

  /**
   * Disable voice; releases mic, drains TTS, closes backend handles.
   * Idempotent.
   */
  async disable(): Promise<void> {
    if (this.state === 'disabled') return;
    await this.cancelSpeaking().catch(() => {});
    await this.stopListening().catch(() => {});
    if (this.playback) {
      await this.playback.close().catch(() => {});
      this.playback = null;
      this.playbackSampleRate = 0;
    }
    await disposeTTSProviders().catch(() => {});
    await disposeSTTProviders().catch(() => {});
    this.backend = null;
    this.backendInfo = null;
    this.ttsProviderName = null;
    this.sttProviderName = null;
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

  /** Short description for the status bar. */
  formatStatusLine(): string {
    const s = this.getStatus();
    switch (s.state) {
      case 'disabled':     return 'Voice: off';
      case 'initializing': return 'Voice: warming…';
      case 'ready':        return `Voice: ready · ${s.ttsProvider ?? '-'}/${s.sttProvider ?? '-'}`;
      case 'speaking':     return 'Voice: speaking';
      case 'listening':    return 'Voice: listening';
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

  /* ── Speak pipeline ────────────────────────────────────────────────── */

  /**
   * Speak a streaming sequence of text deltas. Returns when the audio has
   * finished playing (or playback was cancelled). Safe to call repeatedly;
   * subsequent calls implicitly cancel the previous one.
   */
  async speakStream(
    textDeltas: AsyncIterable<string>,
    opts: SpeakOptions = {},
  ): Promise<void> {
    if (opts.enabled === false) {
      // Drain the deltas so producer doesn't deadlock, but emit nothing.
      for await (const _ of textDeltas) { /* discard */ }
      return;
    }
    if (this.state !== 'ready' && this.state !== 'speaking') return;
    if (!this.backend) return;

    // Cancel any prior utterance.
    await this.cancelSpeaking();

    const tts = await pickReadyTTS();
    if (!tts) {
      logger.warn('voice.speak no TTS provider available');
      // Still drain deltas to release the producer.
      for await (const _ of textDeltas) { /* discard */ }
      return;
    }
    this.ttsProviderName = tts.name;

    const internal = new AbortController();
    this.speakAbort = internal;
    const externalAbort = () => internal.abort();
    opts.signal?.addEventListener('abort', externalAbort, { once: true });

    this.setState('speaking');

    try {
      const sink = await this.ensurePlayback(tts.capabilities.nativeSampleRate);
      const buffer = new SentenceBuffer({ normalize: loadConfig().voice?.tts?.normalize !== false });

      // Convert text deltas → sentence chunks (async iterator).
      const chunkIter = pumpSentenceChunks(buffer, textDeltas, internal.signal);

      // Synthesize and forward to sink with bounded backpressure.
      const audioIter = tts.synthesizeStream(chunkIter, { signal: internal.signal });

      for await (const frame of audioIter) {
        if (internal.signal.aborted) break;
        await sink.write(frame);
      }
      if (!internal.signal.aborted) {
        await sink.drain();
      }
    } catch (err) {
      logger.warn({ err }, 'voice.speak pipeline error');
      // Try fallback once if Cartesia failed mid-utterance.
      // (Phase 2 enhancement: actually retry with the next provider.)
    } finally {
      opts.signal?.removeEventListener('abort', externalAbort);
      if (this.speakAbort === internal) this.speakAbort = null;
      if (this.state === 'speaking') this.setState('ready');
    }
  }

  /** Cancel the in-flight utterance (≤50 ms). */
  async cancelSpeaking(): Promise<void> {
    const ctrl = this.speakAbort;
    this.speakAbort = null;
    if (ctrl && !ctrl.signal.aborted) ctrl.abort();
    if (this.playback) {
      try { await this.playback.flush(); } catch { /* ignore */ }
    }
  }

  /* ── Listen pipeline ───────────────────────────────────────────────── */

  /**
   * Open the mic, stream audio frames to the STT provider, and return the
   * final transcript when `stopListening()` is called (or the external
   * signal aborts). Idempotent: a second call cancels the first.
   *
   * Voice barge-in: starting a listen session implicitly cancels TTS so
   * the user can talk over the agent without typing.
   */
  async startListening(opts: ListenOptions = {}): Promise<ListenResult> {
    if (this.state !== 'ready' && this.state !== 'speaking' && this.state !== 'listening') {
      return { text: '', aborted: true };
    }
    if (!this.backend) return { text: '', aborted: true };

    // Cancel any prior listen + any TTS in progress.
    await this.stopListening().catch(() => {});
    await this.cancelSpeaking().catch(() => {});

    // Ensure we actually have mic access; attempt prompt if not-determined.
    if (this.micPermission !== 'authorized') {
      const refreshed = await this.requestMicPermission();
      if (refreshed !== 'authorized') {
        this.lastError = this.micPermissionHandle?.hint() ?? 'Microphone access denied.';
        return { text: '', aborted: true };
      }
    }

    const stt = await pickReadySTT();
    if (!stt) {
      logger.warn('voice.listen no STT provider available');
      return { text: '', aborted: true };
    }
    this.sttProviderName = stt.name;

    const internal = new AbortController();
    this.listenAbort = internal;
    const externalAbort = () => internal.abort();
    opts.signal?.addEventListener('abort', externalAbort, { once: true });

    this.setMicState('recording');
    this.setState('listening');

    let aggregated = '';
    let aborted = false;
    let recording: RecordingSource | null = null;

    try {
      recording = await this.backend.initRecording({
        sampleRate: stt.capabilities.requiredSampleRate,
        channels: stt.capabilities.requiredChannels,
        frameSize: 320, // 20ms @ 16kHz
        signal: internal.signal,
      });
      this.recording = recording;

      // STT consumes frames; we capture deltas and aggregate final text.
      const deltaIter = stt.transcribe(recording.frames(), {
        language: opts.language,
        signal: internal.signal,
      });

      for await (const delta of deltaIter) {
        if (internal.signal.aborted) { aborted = true; break; }
        try { opts.onDelta?.(delta); } catch (err) {
          logger.debug({ err }, 'voice.listen onDelta callback threw');
        }
        if (delta.isFinal && delta.text) {
          aggregated = aggregated
            ? `${aggregated} ${delta.text}`.trim()
            : delta.text.trim();
        }
      }
      if (internal.signal.aborted) aborted = true;
    } catch (err) {
      aborted = true;
      logger.warn({ err }, 'voice.listen pipeline error');
    } finally {
      opts.signal?.removeEventListener('abort', externalAbort);
      if (recording) {
        this.setMicState('draining');
        try { await recording.stop(); } catch { /* ignore */ }
        this.setMicState('released');
        // After release, mic is logically 'ready' again because the backend
        // can re-init immediately on next press.
        this.setMicState('ready');
      }
      if (this.recording === recording) this.recording = null;
      if (this.listenAbort === internal) this.listenAbort = null;
      if (this.state === 'listening') this.setState('ready');
    }

    return { text: aggregated, aborted };
  }

  /** Stop the current listen session (graceful flush). */
  async stopListening(): Promise<void> {
    const ctrl = this.listenAbort;
    if (!ctrl) return;
    // Signal the STT pipeline to wrap up; the loop will drain naturally
    // because the recording source closes its frames() iterator on stop().
    if (this.recording) {
      try { await this.recording.stop(); } catch { /* ignore */ }
    }
    // If the provider is still waiting for a final after a few seconds,
    // abort hard. The transcribe loop handles abort gracefully.
    setTimeout(() => {
      if (this.listenAbort === ctrl) ctrl.abort();
    }, 1500);
  }

  /** Trigger an OS permission prompt where possible and refresh status. */
  async requestMicPermission(): Promise<MicPermission['status']> {
    // Always re-probe — permission may have changed in System Settings.
    const handle = this.micPermissionHandle ?? (await detectMicPermission());
    this.micPermissionHandle = handle;
    const status = handle.canPrompt ? await handle.request() : handle.status;
    this.micPermission = status;
    this.micState = status === 'authorized' ? 'ready'
                  : status === 'denied' ? 'denied'
                  : 'probing';
    return status;
  }

  /* ── Internal ──────────────────────────────────────────────────────── */

  private async ensurePlayback(sampleRate: number): Promise<PlaybackSink> {
    if (!this.backend) throw new Error('No audio backend');
    if (this.playback && this.playbackSampleRate === sampleRate) {
      return this.playback;
    }
    if (this.playback) {
      await this.playback.close().catch(() => {});
      this.playback = null;
    }
    this.playback = await this.backend.initPlayback({
      sampleRate,
      channels: 1,
    });
    this.playbackSampleRate = sampleRate;
    return this.playback;
  }

  private setState(next: VoiceState): void {
    if (this.state === next) return;
    const prev = this.state;
    this.state = next;
    this.emit('state', { from: prev, to: next });
  }

  private setMicState(next: MicState): void {
    if (this.micState === next) return;
    const prev = this.micState;
    this.micState = next;
    this.emit('micState', { from: prev, to: next });
  }
}

/**
 * Drive the SentenceBuffer from a text-delta async iterator and yield
 * sentence-sized chunks. Also runs the 50 ms tick timer so time-based
 * flushes fire when no new tokens arrive.
 */
async function* pumpSentenceChunks(
  buffer: SentenceBuffer,
  textDeltas: AsyncIterable<string>,
  signal: AbortSignal,
): AsyncIterable<string> {
  // Concurrent: producer feeds buffer, ticker periodically nudges it,
  // consumer (this generator) yields ready chunks.
  const queue: string[] = [];
  let producerDone = false;
  let waiter: (() => void) | null = null;

  const wake = () => { if (waiter) { const w = waiter; waiter = null; w(); } };

  const tick = setInterval(() => {
    for (const c of buffer.tick()) {
      if (c.text) queue.push(c.text);
    }
    wake();
  }, 50);

  const producer = (async () => {
    try {
      for await (const delta of textDeltas) {
        if (signal.aborted) break;
        for (const c of buffer.push(delta)) {
          if (c.text) queue.push(c.text);
        }
        wake();
      }
    } finally {
      for (const c of buffer.end()) {
        if (c.text) queue.push(c.text);
      }
      producerDone = true;
      wake();
    }
  })();

  try {
    while (true) {
      if (signal.aborted) return;
      while (queue.length > 0) {
        const next = queue.shift()!;
        yield next;
      }
      if (producerDone) return;
      await new Promise<void>((resolve) => { waiter = resolve; });
    }
  } finally {
    clearInterval(tick);
    await producer.catch(() => {});
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
