/**
 * Termux audio backend.
 *
 * Termux on Android doesn't expose ALSA / PulseAudio / Core Audio in the
 * way a normal Linux box does — userland apps reach the audio HAL through
 * the `termux-api` bridge (a thin shim over Android intents that hands
 * audio buffers to the Termux:API companion app from F-Droid). This means
 * we cannot stream PCM frame-by-frame the way ffmpeg-streaming does on a
 * desktop OS; the bridge is intent-based and inherently per-utterance.
 *
 * Trade-off accepted:
 *   - Latency is worse (~500ms TTFB instead of ~80ms).
 *   - STT is non-streaming: we buffer the whole recording, finalize the
 *     file, then send it to the STT provider as one chunk. Live partials
 *     are not surfaced on Termux.
 *   - TTS playback waits for `drain()` and plays the buffered PCM as a
 *     single WAV via `play-audio` (or `termux-media-player play`).
 *
 * Required tools (probed at detection time):
 *   - `termux-microphone-record`  — capture
 *   - `play-audio` OR `termux-media-player`  — playback
 *
 * Install with:  pkg install termux-api
 * And install the Termux:API app from F-Droid; without it the CLI shims
 * exist but silently fail.
 *
 * The detector still prefers the ffmpeg-streaming backend when ffmpeg is
 * installed in Termux (some users `pkg install ffmpeg` for video work)
 * and audio devices happen to be exposed; this backend is the guaranteed-
 * to-work fallback that doesn't depend on Termux's optional OpenSL ES /
 * Oboe builds of ffmpeg.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AudioBackend, PlaybackOptions, PlaybackSink, RecordingOptions, RecordingSource } from './base.js';
import type { AudioChunk, BackendCapabilities } from '../../types.js';
import { findBinary } from '../system.js';
import { logger } from '../../../utils/logger.js';

const TERMUX_LATENCY_MS = 500;     // honest TTFB for the API bridge round-trip
const WAV_HEADER_BYTES   = 44;     // standard PCM WAV header size

export class TermuxAPIBackend implements AudioBackend {
  readonly name = 'termux-api';
  readonly capabilities: BackendCapabilities = {
    streaming: false,
    latencyMs: TERMUX_LATENCY_MS,
    needsSystemBinary: true,
    installHint:
      'pkg install termux-api    (and install the Termux:API companion app from F-Droid)',
  };

  async isAvailable(): Promise<boolean> {
    const mic  = findBinary('termux-microphone-record').path;
    const play = findBinary('play-audio').path; // termux-media-player isn't in the known list
    // We require the mic shim; playback is best-effort (TTS-only setups
    // still benefit from a working capture path being absent gracefully).
    return Boolean(mic && play);
  }

  async initPlayback(opts: PlaybackOptions): Promise<PlaybackSink> {
    return new TermuxPlaybackSink(opts);
  }

  async initRecording(opts: RecordingOptions): Promise<RecordingSource> {
    return new TermuxRecordingSource(opts);
  }
}

/* ── Playback ──────────────────────────────────────────────────────── */

class TermuxPlaybackSink implements PlaybackSink {
  private chunks: Buffer[] = [];
  private totalBytes = 0;
  private playing: ChildProcess | null = null;
  /** Set when the sink is closed; new write() calls become no-ops. */
  private closed = false;

  constructor(private opts: PlaybackOptions) {}

  async write(chunk: AudioChunk): Promise<void> {
    if (this.closed) return;
    const buf = Buffer.from(chunk.pcm);
    this.chunks.push(buf);
    this.totalBytes += buf.byteLength;
  }

  async drain(): Promise<void> {
    if (this.closed || this.totalBytes === 0) return;
    const pcm = Buffer.concat(this.chunks, this.totalBytes);
    this.chunks = [];
    this.totalBytes = 0;

    const wav = pcmToWav(pcm, this.opts.sampleRate, this.opts.channels);
    const tmpFile = join(tmpdir(), `mercury-tts-${process.pid}-${Date.now()}.wav`);
    try {
      writeFileSync(tmpFile, wav);
      const playBin = findBinary('play-audio').path;
      if (!playBin) {
        logger.warn('Termux playback skipped: play-audio not on PATH');
        return;
      }
      const proc = spawn(playBin, [tmpFile], { stdio: 'ignore' });
      this.playing = proc;
      await new Promise<void>((resolve) => {
        proc.once('exit', () => resolve());
        proc.once('error', () => resolve());
      });
      this.playing = null;
    } finally {
      try { rmSync(tmpFile, { force: true }); } catch { /* ignore */ }
    }
  }

  async flush(): Promise<void> {
    // Drop any queued audio and stop in-flight playback. Mirrors the
    // barge-in contract from ffmpeg-streaming.
    this.chunks = [];
    this.totalBytes = 0;
    if (this.playing) {
      try { this.playing.kill('SIGTERM'); } catch { /* ignore */ }
      this.playing = null;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
  }

  isAlive(): boolean {
    // Termux playback is fire-and-forget per write() — there's no
    // long-lived child to outlive. Consider the sink alive until
    // explicitly closed; ensurePlayback() will re-init on the next
    // write anyway since each utterance spawns a fresh play-audio call.
    return !this.closed;
  }
}

/* ── Recording ─────────────────────────────────────────────────────── */

class TermuxRecordingSource implements RecordingSource {
  private mic: ChildProcess | null = null;
  private tmpDir: string;
  private tmpFile: string;
  /** Resolves when the underlying mic process exits (recording finalized). */
  private exitPromise: Promise<void>;
  private stopped = false;
  pid?: number;

  constructor(private opts: RecordingOptions) {
    const bin = findBinary('termux-microphone-record').path;
    if (!bin) throw new Error('termux-microphone-record not on PATH');

    this.tmpDir  = mkdtempSync(join(tmpdir(), 'mercury-mic-'));
    this.tmpFile = join(this.tmpDir, 'capture.wav');

    // -e WAV forces PCM container; -l 0 = unlimited (we stop manually).
    // -r and -c request the wire format the STT provider expects.
    const args = [
      '-f', this.tmpFile,
      '-e', 'WAV',
      '-r', String(opts.sampleRate),
      '-c', String(opts.channels),
      '-l', '0',
    ];
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.mic = proc;
    this.pid = proc.pid;

    this.exitPromise = new Promise<void>((resolve) => {
      proc.once('exit', () => resolve());
      proc.once('error', (err) => {
        logger.warn({ err: err.message }, 'termux-microphone-record error');
        resolve();
      });
    });
  }

  async *frames(): AsyncIterable<AudioChunk> {
    // Termux is non-streaming: we sit here until recording is stopped,
    // then read the finalized WAV and yield its PCM payload as a single
    // chunk. STT providers happily accept large frames; only the live
    // partial UX is lost (acceptable trade for working on Android).
    await this.exitPromise;

    if (!existsSync(this.tmpFile)) {
      logger.warn({ tmpFile: this.tmpFile }, 'Termux recording: capture file missing');
      return;
    }
    let wav: Buffer;
    try {
      wav = readFileSync(this.tmpFile);
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Termux recording: read failed');
      return;
    }
    if (wav.byteLength <= WAV_HEADER_BYTES) return; // empty / truncated

    // termux-microphone-record writes a standard 44-byte PCM WAV header
    // when -e WAV is used; strip it to hand raw s16le PCM to STT.
    const pcm = wav.subarray(WAV_HEADER_BYTES);
    yield {
      pcm,
      sampleRate: this.opts.sampleRate,
      channels: this.opts.channels,
      timestamp: performance.now(),
    };
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    // The official way to terminate a -l 0 recording is `termux-microphone-record -q`.
    // It signals the companion app to flush + close the file cleanly. We
    // call it first and only fall back to SIGTERM if the process is still
    // alive after a short grace period.
    try {
      spawnSync(findBinary('termux-microphone-record').path!, ['-q'], {
        stdio: 'ignore',
        timeout: 1500,
      });
    } catch (err: any) {
      logger.warn({ err: err.message }, 'termux-microphone-record -q failed');
    }

    if (this.mic) {
      const proc = this.mic;
      // Wait up to 1.5s for the process to exit on its own, then SIGTERM.
      const waited = await Promise.race([
        this.exitPromise.then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), 1500)),
      ]);
      if (!waited) {
        try { proc.kill('SIGTERM'); } catch { /* ignore */ }
        await Promise.race([
          this.exitPromise,
          new Promise<void>((r) => setTimeout(r, 500)),
        ]);
        try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      }
      this.mic = null;
    }

    // Best-effort cleanup. We leave the tmp file in place if frames()
    // hasn't been awaited yet, so the consumer can still read it; the
    // os/tmp reaper picks it up otherwise.
    try {
      if (existsSync(this.tmpFile) && statSync(this.tmpFile).size <= WAV_HEADER_BYTES) {
        rmSync(this.tmpDir, { recursive: true, force: true });
      }
    } catch { /* ignore */ }
  }
}

/* ── Helpers ───────────────────────────────────────────────────────── */

/**
 * Wrap raw s16le PCM in a minimal RIFF/WAVE header so `play-audio` (which
 * autodetects container) can play it without re-encoding. 44-byte header,
 * mono/stereo configurable, 16-bit only — matches what the rest of the
 * voice subsystem produces.
 */
function pcmToWav(pcm: Buffer, sampleRate: number, channels: number): Buffer {
  const bitsPerSample = 16;
  const byteRate   = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const dataSize   = pcm.byteLength;
  const buf        = Buffer.alloc(WAV_HEADER_BYTES + dataSize);

  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);  // RIFF chunk size
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);            // PCM fmt chunk size
  buf.writeUInt16LE(1, 20);             // PCM = 1
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  pcm.copy(buf, WAV_HEADER_BYTES);
  return buf;
}
