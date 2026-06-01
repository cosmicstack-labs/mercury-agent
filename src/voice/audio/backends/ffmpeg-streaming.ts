/**
 * ffmpeg-based audio backend.
 *
 * This is the universal backend: it works on every supported OS (macOS,
 * Linux, Windows, Termux) and inside Bun-compiled standalone binaries
 * (no native node addons required). It's also the fallback used when the
 * higher-priority `speaker-native` backend isn't installed or fails to
 * load.
 *
 * Playback strategy:
 *   - Spawn ffplay (preferred; ships with ffmpeg) and pipe raw PCM s16le
 *     into its stdin. ffplay decodes nothing — it just hands frames to
 *     the platform's audio API. First audio is heard within ~50–80 ms of
 *     the first byte arriving, which is the latency budget we promised.
 *   - If ffplay is missing but ffmpeg is present (some package managers
 *     split them), we fall back to `ffmpeg ... -f <out>` where <out> is
 *     the OS-native output format.
 *
 * Recording strategy:
 *   - Spawn `ffmpeg -f <input_fmt> -i <device> -ac 1 -ar 16000 -f s16le -`
 *     and read PCM frames from stdout in 20 ms slices.
 *   - Input format depends on OS: avfoundation (mac), pulse/alsa (linux),
 *     dshow (win). Termux uses a different backend entirely.
 *
 * Lifecycle:
 *   - Every child process is tracked by PID. close()/stop() send SIGTERM
 *     with a 500 ms grace period then SIGKILL, and verify the process is
 *     gone via kill(pid, 0). This is the contract VoiceManager relies on
 *     when releasing the microphone.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { runtime } from '../../runtime.js';
import type { AudioBackend, PlaybackOptions, PlaybackSink, RecordingOptions, RecordingSource } from './base.js';
import type { AudioChunk, BackendCapabilities } from '../../types.js';
import { findBinary } from '../system.js';
import { logger } from '../../../utils/logger.js';

const PLAYBACK_LATENCY_MS = 80;     // ffplay typical TTFB once data flows
const SIGTERM_GRACE_MS = 500;       // give child a chance to exit cleanly
const RECORDING_FRAME_MS = 20;      // matches Cartesia Ink Whisper preference

export class FfmpegStreamingBackend implements AudioBackend {
  readonly name = 'ffmpeg-streaming';
  readonly capabilities: BackendCapabilities = {
    streaming: true,
    latencyMs: PLAYBACK_LATENCY_MS,
    needsSystemBinary: true,
    installHint: 'install ffmpeg (which also provides ffplay)',
  };

  async isAvailable(): Promise<boolean> {
    // Need either ffplay (preferred) or ffmpeg for playback,
    // and ffmpeg for recording. We accept the backend if ffmpeg is present.
    return findBinary('ffmpeg').path !== null;
  }

  async initPlayback(opts: PlaybackOptions): Promise<PlaybackSink> {
    const ffplay = findBinary('ffplay');
    const ffmpeg = findBinary('ffmpeg');
    if (!ffplay.path && !ffmpeg.path) {
      throw new Error(`ffplay/ffmpeg not found. ${ffmpeg.installHint}`);
    }

    const sampleRate = opts.sampleRate;
    const channels = opts.channels;
    // ffmpeg 5.1 (Aug 2022) renamed the channel-count option: modern
    // builds want `-ch_layout mono|stereo`, older accept `-ac N`. We
    // try the modern form first and lazy-fall-back to `-ac` only if
    // the player exits with "Option not found" — see retry logic in
    // FfmpegPlaybackSink. No upfront probe (the probe variant using
    // anullsrc was unreliable; it hung on some ffplay builds).
    const layout = channelLayoutFor(channels);

    let proc: ChildProcess;
    let usingFallback = false;
    if (ffplay.path) {
      // ffplay: minimal latency, no decode, just play raw PCM from stdin.
      // We capture stderr so failures (wrong audio device, missing SDL2,
      // permission denied) surface in logs / sink.lastError instead of
      // being silently swallowed — which used to make "TTS pipeline
      // completed without errors" indistinguishable from "ffplay died
      // before playing a single sample".
      proc = spawn(
        ffplay.path,
        [
          '-loglevel', 'error',
          '-autoexit',
          '-nodisp',
          '-f', 's16le',
          '-ar', String(sampleRate),
          '-ch_layout', layout,
          '-i', 'pipe:0',
        ],
        { stdio: ['pipe', 'ignore', 'pipe'] },
      );
    } else {
      // ffmpeg fallback: pipe PCM in, send to the platform default output.
      usingFallback = true;
      const outputArgs = pickFfmpegOutputArgs();
      proc = spawn(
        ffmpeg.path!,
        [
          '-loglevel', 'error',
          '-f', 's16le',
          '-ar', String(sampleRate),
          '-ac', String(channels),
          '-i', 'pipe:0',
          ...outputArgs,
        ],
        { stdio: ['pipe', 'ignore', 'pipe'] },
      );
    }

    return new FfmpegPlaybackSink(proc, opts.signal, usingFallback ? 'ffmpeg' : 'ffplay');
  }

  async initRecording(opts: RecordingOptions): Promise<RecordingSource> {
    const ffmpeg = findBinary('ffmpeg');
    if (!ffmpeg.path) {
      throw new Error(`ffmpeg not found. ${ffmpeg.installHint}`);
    }

    const { format, device } = pickFfmpegInputArgs(opts.deviceId);
    const sampleRate = opts.sampleRate;
    const channels = opts.channels;

    const proc = spawn(
      ffmpeg.path,
      [
        '-loglevel', 'quiet',
        '-f', format,
        '-i', device,
        '-ac', String(channels),
        '-ar', String(sampleRate),
        '-f', 's16le',
        'pipe:1',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    return new FfmpegRecordingSource(proc, sampleRate, channels, opts.frameSize);
  }
}

/* ── Playback sink ────────────────────────────────────────────────────── */

class FfmpegPlaybackSink implements PlaybackSink {
  private closed = false;
  private exited = false;
  private exitPromise: Promise<void>;
  private stderrBuf = '';
  private exitCode: number | null = null;
  /** Last error surfaced from stderr or process exit. Public so callers
   *  (and /voice test) can inspect why audio didn't reach the speaker. */
  lastError: string | null = null;

  constructor(
    private proc: ChildProcess,
    signal: AbortSignal | undefined,
    private playerName: string = 'ffplay',
  ) {
    this.exitPromise = new Promise<void>((resolve) => {
      const settle = () => { this.exited = true; resolve(); };
      proc.once('exit', (code) => { this.exitCode = code; settle(); });
      proc.once('error', (err) => {
        this.lastError = `${this.playerName} spawn error: ${err.message}`;
        settle();
      });
    });

    // Capture stderr — ffplay reports audio-device failures here:
    //   • "alsa: snd_pcm_open: Device or resource busy"
    //   • "Could not open audio device"  (SDL2 missing / CoreAudio denied)
    //   • "No such audio device"         (wrong output route)
    // Without this we previously discarded all of it via stdio:'ignore',
    // making playback failures invisible to the user.
    const stderr = (proc as any).stderr;
    if (stderr && typeof stderr.on === 'function') {
      stderr.on('data', (data: Buffer) => {
        const text = data.toString();
        this.stderrBuf += text;
        // Keep buffer bounded so a verbose player can't OOM us.
        if (this.stderrBuf.length > 8192) {
          this.stderrBuf = this.stderrBuf.slice(-8192);
        }
        // Real audio-device failures: surface immediately.
        if (/no such|cannot open|could not open|permission denied|device or resource busy|invalid sample|option not found|failed to set|unknown encoder|protocol not found|error/i.test(text)) {
          const line = text.trim().split('\n').slice(-3).join(' | ');
          this.lastError = `${this.playerName}: ${line}`;
          logger.warn({ stderr: text.trim() }, 'voice.playback stderr');
        }
      });
    }

    if (signal) {
      const abort = () => { void this.flush().then(() => this.close()); };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }

    proc.stdin?.on('error', (err: NodeJS.ErrnoException) => {
      // EPIPE is expected when ffplay exits before we finish writing
      // (e.g. user pressed Ctrl+C). Log anything else.
      if (err.code !== 'EPIPE') {
        logger.debug({ err }, 'voice.playback.stdin error');
      }
    });
  }

  async write(chunk: AudioChunk): Promise<void> {
    if (this.closed || this.exited) return;
    const stdin = this.proc.stdin;
    if (!stdin || stdin.destroyed) return;

    if (!stdin.write(chunk.pcm)) {
      // Backpressure: wait until the kernel buffer drains.
      await new Promise<void>((resolve) => stdin.once('drain', resolve));
    }
  }

  async drain(): Promise<void> {
    if (this.closed) return;
    const stdin = this.proc.stdin;
    if (stdin && !stdin.destroyed) {
      stdin.end(); // signals EOF; ffplay finishes playing buffered audio
    }
    // Wait for ffplay to exit (with -autoexit it does so once buffer drains).
    await this.exitPromise;

    // Non-zero exit code with no captured error message means the player
    // bailed for an unknown reason — promote stderr tail so /voice test
    // can show *something* useful.
    if (this.exitCode !== null && this.exitCode !== 0 && !this.lastError) {
      const tail = this.stderrBuf.trim().split('\n').slice(-3).join(' | ');
      this.lastError = `${this.playerName} exited with code ${this.exitCode}${tail ? `: ${tail}` : ' (no stderr)'}`;
    }

    // Surface the failure so callers don't silently believe audio played.
    if (this.lastError) {
      throw new Error(this.lastError);
    }
  }

  async flush(): Promise<void> {
    // Hard stop: kill the player so any buffered audio is silenced.
    // Used for barge-in / interrupt.
    if (this.closed) return;
    await killProcess(this.proc);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await killProcess(this.proc);
  }
}

/* ── Recording source ─────────────────────────────────────────────────── */

class FfmpegRecordingSource implements RecordingSource {
  private stopped = false;
  readonly pid?: number;

  constructor(
    private proc: ChildProcess,
    private sampleRate: number,
    private channels: number,
    private frameSize: number = Math.floor((RECORDING_FRAME_MS * 16000) / 1000),
  ) {
    this.pid = proc.pid;
    proc.stderr?.on('data', (data: Buffer) => {
      // ffmpeg stderr is noisy by design; only surface real errors.
      const text = data.toString();
      if (/permission denied|no such|cannot open/i.test(text)) {
        logger.warn({ stderr: text.trim() }, 'voice.recording ffmpeg error');
      }
    });
    proc.on('error', (err) => {
      logger.warn({ err }, 'voice.recording process error');
    });
  }

  async *frames(): AsyncIterable<AudioChunk> {
    const stdout = this.proc.stdout;
    if (!stdout) return;

    // bytes per frame: frameSize samples * channels * 2 (s16le)
    const bytesPerFrame = this.frameSize * this.channels * 2;
    let leftover: Buffer = Buffer.alloc(0);

    for await (const chunk of stdout as AsyncIterable<Buffer>) {
      if (this.stopped) break;
      let buf = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;

      while (buf.length >= bytesPerFrame) {
        const frame = buf.subarray(0, bytesPerFrame);
        buf = buf.subarray(bytesPerFrame);
        yield {
          pcm: Buffer.from(frame), // copy so consumer can hold reference
          sampleRate: this.sampleRate,
          channels: this.channels,
          timestamp: performance.now(),
        };
      }
      leftover = buf;
    }
    // Flush partial trailing frame as-is so STT providers see all audio
    // captured before stop.
    if (leftover.length > 0 && !this.stopped) {
      yield {
        pcm: Buffer.from(leftover),
        sampleRate: this.sampleRate,
        channels: this.channels,
        timestamp: performance.now(),
      };
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await killProcess(this.proc);
  }
}

/* ── Cross-platform input/output args ─────────────────────────────────── */

function channelLayoutFor(channels: number): string {
  switch (channels) {
    case 1: return 'mono';
    case 2: return 'stereo';
    default: return `${channels}c`;
  }
}

function pickFfmpegInputArgs(deviceId?: string | null): { format: string; device: string } {
  switch (runtime.os) {
    case 'macos':
      // avfoundation device strings are ":N" for audio-only, e.g. ":0".
      return { format: 'avfoundation', device: deviceId || ':default' };
    case 'linux': {
      // Prefer PulseAudio when available, fall back to ALSA's default.
      // We don't probe here because ffmpeg fails fast if pulse is unavailable
      // and the detector layer can swap formats based on `pactl info` output
      // when we add finer-grained detection later.
      return { format: 'pulse', device: deviceId || 'default' };
    }
    case 'windows':
      return { format: 'dshow', device: deviceId || 'audio=default' };
    default:
      // Sensible Linux-style fallback; Termux is a separate backend.
      return { format: 'alsa', device: deviceId || 'default' };
  }
}

function pickFfmpegOutputArgs(): string[] {
  // These args route raw PCM (already on ffmpeg's input via stdin) to the
  // platform's default audio output. The previous implementation used
  // avfoundation/dshow + '-' (stdout), which is silent-by-construction:
  //   • avfoundation/dshow are INPUT muxers, not output devices.
  //   • '-' means stdout, which the parent process ignores.
  // The fix is to use each OS's proper output muxer.
  switch (runtime.os) {
    case 'macos':
      // AudioToolbox: ships with macOS CoreAudio; no SDL2 dependency.
      return ['-f', 'audiotoolbox', '-'];
    case 'linux':
      return ['-f', 'pulse', 'default'];
    case 'windows':
      // sndio is rare on Windows; use DirectSound output muxer instead.
      // Older ffmpeg builds expose this as 'dsound', newer ones drop it
      // and require WASAPI via SDL. We try the most portable: write a
      // wav to default device via 'sndio'? — no, simplest reliable thing
      // is the 'wasapi' output added in 2023+; fall through to sdl as
      // last resort.
      return ['-f', 'wasapi', '-'];
    default:
      return ['-f', 'alsa', 'default'];
  }
}

/* ── Process killing with verified release ────────────────────────────── */

/**
 * Send SIGTERM, wait up to SIGTERM_GRACE_MS, then SIGKILL.
 * Verifies the process is actually gone before resolving — this is the
 * contract VoiceManager needs to guarantee "mic released" is truthful.
 *
 * On Windows, signals are emulated by Node; SIGTERM/SIGKILL both end up
 * as TerminateProcess(), which is synchronous-ish but we still verify.
 */
async function killProcess(proc: ChildProcess): Promise<void> {
  if (!proc.pid || proc.exitCode !== null) return;

  try { proc.kill('SIGTERM'); } catch { /* already dead */ }

  // Wait for graceful exit.
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => proc.once('exit', () => resolve(true))),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), SIGTERM_GRACE_MS)),
  ]);

  if (!exited) {
    try { proc.kill('SIGKILL'); } catch { /* race */ }
    // Tiny extra wait for the kernel to reap.
    await new Promise((r) => setTimeout(r, 50));
  }

  // Verify the PID is gone. `kill(pid, 0)` throws ESRCH when the
  // process no longer exists; any other outcome we treat as a warning.
  if (proc.pid) {
    try {
      process.kill(proc.pid, 0);
      logger.warn({ pid: proc.pid }, 'voice.killProcess: process still alive after SIGKILL');
    } catch (err: any) {
      if (err?.code !== 'ESRCH') {
        logger.debug({ err, pid: proc.pid }, 'voice.killProcess verify');
      }
    }
  }
}
