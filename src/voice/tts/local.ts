/**
 * LocalTTS — fully on-device TTS using whatever the OS already ships.
 *
 * No API key, no network, no per-utterance billing. Quality is lower than
 * Cartesia/OpenAI and there's no real streaming (most OS engines render
 * the full utterance to a file/pipe, then we transcode), but it gives
 * users a "works offline / no signup" fallback.
 *
 * Engine matrix:
 *   • macOS   — `say --data-format=LEI16@22050 -o /dev/stdout`
 *               (raw 16-bit LE PCM straight to stdout — perfect for us)
 *   • Linux   — `espeak-ng --stdout` (WAV header + PCM; ffmpeg-decoded)
 *               Falls back to plain `espeak` if espeak-ng isn't present.
 *   • Windows — PowerShell System.Speech.Synthesis to a temp WAV, then
 *               ffmpeg-decoded. (No raw-PCM SAPI path that doesn't go
 *               through a file.)
 *   • Termux  — `termux-tts-speak` (handled by the TermuxBackend stack;
 *               this provider just bails on Termux so the dedicated path
 *               is preferred).
 *
 * The synth happens in one shot per utterance — text-streaming providers
 * (Cartesia) deliver audio in 100ms slices; local engines need the full
 * sentence first. We compensate by yielding the resulting PCM in 20ms
 * frames so the playback sink can apply backpressure / get interrupted.
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BaseTTSProvider, type TTSCapabilities } from './base.js';
import type { AudioChunk, TTSOptions, Voice } from '../types.js';
import { runtime } from '../runtime.js';
import { findBinary } from '../audio/system.js';
import { logger } from '../../utils/logger.js';
import { registerTTSProvider } from './registry.js';

const NATIVE_SAMPLE_RATE = 22050;
const FRAME_MS = 20;
const BYTES_PER_FRAME = (NATIVE_SAMPLE_RATE * FRAME_MS / 1000) * 2; // mono s16le

interface EngineDescriptor {
  name: 'say' | 'espeak-ng' | 'espeak' | 'powershell';
  binary: string;
}

export class LocalTTS extends BaseTTSProvider {
  readonly name = 'local';
  readonly capabilities: TTSCapabilities = {
    streaming: false,
    nativeSampleRate: NATIVE_SAMPLE_RATE,
  };

  private engine: EngineDescriptor | null = null;
  private probed = false;

  private resolveEngine(): EngineDescriptor | null {
    if (this.probed) return this.engine;
    this.probed = true;
    // Termux has a dedicated backend; don't compete with it.
    if (runtime.isTermux) return (this.engine = null);
    switch (runtime.os) {
      case 'macos': {
        const p = findBinary('say').path;
        if (p) this.engine = { name: 'say', binary: p };
        break;
      }
      case 'linux': {
        const ng = findBinary('espeak-ng').path;
        if (ng) { this.engine = { name: 'espeak-ng', binary: ng }; break; }
        const sk = findBinary('espeak').path;
        if (sk) this.engine = { name: 'espeak', binary: sk };
        break;
      }
      case 'windows': {
        const ps = findBinary('powershell').path ?? findBinary('pwsh').path;
        if (ps) this.engine = { name: 'powershell', binary: ps };
        break;
      }
    }
    return this.engine;
  }

  isAvailable(): Promise<boolean> {
    return Promise.resolve(this.resolveEngine() !== null);
  }

  async listVoices(): Promise<Voice[]> {
    // We don't enumerate voices — OS engines have wildly different
    // listing semantics and most users won't care. Return a single
    // synthetic entry so /voice ... commands have something to show.
    const eng = this.resolveEngine();
    if (!eng) return [];
    return [{ id: 'system-default', name: `Local (${eng.name})`, language: 'en' }];
  }

  async *synthesize(text: string, opts: TTSOptions): AsyncIterable<AudioChunk> {
    if (!text || opts.signal?.aborted) return;
    const eng = this.resolveEngine();
    if (!eng) throw new Error('Local TTS: no on-device engine found.');

    const pcm = await synthesizeWithEngine(eng, text, opts.signal);
    if (!pcm.length) return;

    // Slice into 20ms frames so the playback sink can backpressure /
    // abort gracefully mid-utterance.
    for (let off = 0; off < pcm.length; off += BYTES_PER_FRAME) {
      if (opts.signal?.aborted) return;
      const end = Math.min(off + BYTES_PER_FRAME, pcm.length);
      yield {
        pcm: pcm.subarray(off, end),
        sampleRate: NATIVE_SAMPLE_RATE,
        channels: 1,
        timestamp: performance.now(),
      };
    }
  }
}

/* ── Engine drivers ──────────────────────────────────────────────────── */

async function synthesizeWithEngine(
  eng: EngineDescriptor,
  text: string,
  signal: AbortSignal | undefined,
): Promise<Buffer> {
  switch (eng.name) {
    case 'say':         return synthesizeWithSay(eng.binary, text, signal);
    case 'espeak-ng':   return synthesizeWithEspeak(eng.binary, text, signal);
    case 'espeak':      return synthesizeWithEspeak(eng.binary, text, signal);
    case 'powershell':  return synthesizeWithPowershell(eng.binary, text, signal);
  }
}

/**
 * macOS `say`. The --data-format flag yields raw little-endian s16 at
 * 22050 Hz directly on stdout, so no ffmpeg pass is needed.
 */
function synthesizeWithSay(
  binary: string,
  text: string,
  signal: AbortSignal | undefined,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(binary, [
      '--data-format', `LEI16@${NATIVE_SAMPLE_RATE}`,
      '-o', '/dev/stdout',
      text,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    collectChild(p, signal).then(resolve, reject);
  });
}

/**
 * espeak-ng / espeak. `--stdout` produces a WAV stream (header + PCM).
 * Pipe through ffmpeg to produce headerless s16le @ 22050 Hz mono so
 * the rest of the pipeline doesn't have to parse RIFF.
 */
function synthesizeWithEspeak(
  binary: string,
  text: string,
  signal: AbortSignal | undefined,
): Promise<Buffer> {
  const ff = findBinary('ffmpeg');
  if (!ff.path) {
    return Promise.reject(new Error(`Local TTS: ${ff.installHint}`));
  }
  return new Promise((resolve, reject) => {
    const espeak = spawn(binary, ['--stdout', text], { stdio: ['ignore', 'pipe', 'pipe'] });
    const ffmpeg = spawn(ff.path!, [
      '-loglevel', 'error',
      '-i', 'pipe:0',
      '-f', 's16le',
      '-ar', String(NATIVE_SAMPLE_RATE),
      '-ac', '1',
      'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    espeak.stdout.pipe(ffmpeg.stdin);
    espeak.on('error', reject);
    collectChild(ffmpeg, signal).then(resolve, reject);
  });
}

/**
 * Windows PowerShell SAPI. There's no raw-PCM stdout path that doesn't
 * involve a file, so we synthesize to a temp WAV and ffmpeg-decode it.
 */
async function synthesizeWithPowershell(
  binary: string,
  text: string,
  signal: AbortSignal | undefined,
): Promise<Buffer> {
  const ff = findBinary('ffmpeg');
  if (!ff.path) throw new Error(`Local TTS: ${ff.installHint}`);
  const wavPath = join(tmpdir(), `mercury-tts-${randomUUID()}.wav`);
  // PowerShell escaping: single-quote text + double-up single quotes.
  const safe = text.replace(/'/g, "''");
  const script = `
    Add-Type -AssemblyName System.Speech;
    $s = New-Object System.Speech.Synthesis.SpeechSynthesizer;
    $s.SetOutputToWaveFile('${wavPath.replace(/'/g, "''")}');
    $s.Speak('${safe}');
    $s.Dispose();
  `;
  await new Promise<void>((resolve, reject) => {
    const p = spawn(binary, ['-NoProfile', '-Command', script], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`PowerShell SAPI failed (${code}): ${err.slice(0, 200)}`)));
    p.on('error', reject);
    signal?.addEventListener('abort', () => p.kill('SIGTERM'), { once: true });
  });
  try {
    const pcm = await new Promise<Buffer>((resolve, reject) => {
      const p = spawn(ff.path!, [
        '-loglevel', 'error',
        '-i', wavPath,
        '-f', 's16le',
        '-ar', String(NATIVE_SAMPLE_RATE),
        '-ac', '1',
        'pipe:1',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      collectChild(p, signal).then(resolve, reject);
    });
    return pcm;
  } finally {
    fs.unlink(wavPath).catch(() => { /* best effort */ });
  }
}

/**
 * Spawn helper: collect stdout, surface stderr on non-zero exit, honor
 * AbortSignal. Returns the accumulated Buffer or rejects.
 */
function collectChild(
  proc: ReturnType<typeof spawn>,
  signal: AbortSignal | undefined,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const out: Buffer[] = [];
    let err = '';
    proc.stdout?.on('data', (d: Buffer) => { out.push(d); });
    proc.stderr?.on('data', (d: Buffer) => { err += d.toString(); });
    proc.on('exit', (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else {
        logger.warn({ code, stderr: err.slice(0, 300) }, 'voice.tts.local engine failed');
        reject(new Error(`Local TTS engine exited ${code}: ${err.trim().split('\n').slice(-2).join(' | ')}`));
      }
    });
    proc.on('error', (e) => reject(e));
    if (signal) {
      const abort = () => { try { proc.kill('SIGTERM'); } catch { /* */ } };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }
  });
}

// Module-load registration.
registerTTSProvider('local', async () => new LocalTTS());
