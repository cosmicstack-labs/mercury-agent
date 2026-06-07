/**
 * LocalSTT — fully on-device speech recognition via whisper.cpp.
 *
 * Why whisper.cpp:
 *   • Single statically-linked binary (`whisper-cli`) plus a ggml model
 *     file. No Python, no PyTorch, no GPU required (Metal/CUDA optional).
 *   • Cross-platform: Homebrew ships `whisper-cpp` on macOS, prebuilt
 *     Windows binaries from the upstream releases, easy CMake build on
 *     Linux.
 *   • CPU-only base.en model is ~140MB, transcribes faster than realtime
 *     on any modern laptop.
 *
 * Lifecycle per `transcribe()` call:
 *   1. Drain the AsyncIterable of 16kHz s16le mono PCM frames into a
 *      Buffer (max ~60s of audio = ~1.9MB — bounded by PTT release).
 *   2. Wrap the raw PCM in a minimal WAV header, write to a tempfile.
 *   3. Spawn `whisper-cli -m <model> -f <wav> -nt -np` and parse stdout
 *      (no timestamps, no progress).
 *   4. Yield ONE final TranscriptDelta with the joined text.
 *
 * There's no partials path: upstream whisper-cli has a streaming mode
 * (`stream`) but it's a separate binary requiring SDL2 and platform mic
 * access; not worth the install burden for a fallback. Users who want
 * live partials should configure Cartesia.
 *
 * isAvailable() returns true when both the binary AND a model file are
 * present. The model path is configurable (`voice.stt.local.modelPath`)
 * and defaults to `~/.mercury/whisper/ggml-base.en.bin`.
 */
import { spawn } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BaseSTTProvider, type STTCapabilities } from './base.js';
import { registerSTTProvider } from './registry.js';
import type { AudioChunk, STTOptions, TranscriptDelta } from '../types.js';
import { loadConfig } from '../../utils/config.js';
import { findBinary, defaultWhisperModelPath } from '../audio/system.js';
import { logger } from '../../utils/logger.js';

const REQUIRED_SAMPLE_RATE = 16000;
const REQUIRED_CHANNELS = 1;
/** Cap audio buffering at 5 minutes — anything longer is almost certainly a stuck mic. */
const MAX_AUDIO_BYTES = REQUIRED_SAMPLE_RATE * 2 * 60 * 5;

class LocalSTT extends BaseSTTProvider {
  readonly name = 'local';
  readonly capabilities: STTCapabilities = {
    streaming: false,
    requiredSampleRate: REQUIRED_SAMPLE_RATE,
    requiredChannels: REQUIRED_CHANNELS,
  };

  isAvailable(): Promise<boolean> {
    const bin = this.resolveBinary();
    if (!bin) return Promise.resolve(false);
    const model = this.resolveModelPath();
    return Promise.resolve(Boolean(model) && existsSync(model!));
  }

  private resolveBinary(): string | null {
    const cfg = loadConfig().voice?.stt?.local;
    if (cfg?.binaryPath && existsSync(cfg.binaryPath)) return cfg.binaryPath;
    // Homebrew installs `whisper-cli`; older builds called it `whisper`
    // or `main`. Try in that order.
    return findBinary('whisper-cli').path
        ?? findBinary('whisper').path
        ?? findBinary('main').path
        ?? null;
  }

  private resolveModelPath(): string | null {
    const cfg = loadConfig().voice?.stt?.local;
    return (cfg?.modelPath && cfg.modelPath.length > 0)
      ? cfg.modelPath
      : defaultWhisperModelPath();
  }

  async *transcribe(
    frames: AsyncIterable<AudioChunk>,
    opts: STTOptions,
  ): AsyncIterable<TranscriptDelta> {
    const bin = this.resolveBinary();
    if (!bin) throw new Error('Local STT: whisper-cli not found. brew install whisper-cpp');
    const model = this.resolveModelPath();
    if (!model || !existsSync(model)) {
      throw new Error(`Local STT: model file not found at ${model}. Download a ggml model from https://huggingface.co/ggerganov/whisper.cpp`);
    }

    // 1) Drain frames into a single buffer (bounded).
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const frame of frames) {
      if (opts.signal?.aborted) return;
      if (frame.sampleRate !== REQUIRED_SAMPLE_RATE || frame.channels !== REQUIRED_CHANNELS) {
        // Manager guarantees a resampled stream, but be defensive.
        logger.warn({ sr: frame.sampleRate, ch: frame.channels }, 'voice.stt.local got non-16kHz mono frame');
      }
      chunks.push(frame.pcm);
      bytes += frame.pcm.length;
      if (bytes >= MAX_AUDIO_BYTES) {
        logger.warn({ bytes }, 'voice.stt.local cap reached, cutting recording');
        break;
      }
    }
    if (bytes === 0) {
      yield { text: '', isFinal: true };
      return;
    }

    const pcm = Buffer.concat(chunks, bytes);

    // 2) Write a WAV file.
    const wavPath = join(tmpdir(), `mercury-stt-${randomUUID()}.wav`);
    await fs.writeFile(wavPath, wrapWav(pcm, REQUIRED_SAMPLE_RATE, REQUIRED_CHANNELS));

    // 3) Spawn whisper-cli.
    const cfg = loadConfig().voice?.stt?.local;
    const lang = opts.language ?? cfg?.language ?? 'en';
    const args = [
      '-m', model,
      '-f', wavPath,
      '-l', lang === 'auto' ? 'auto' : lang,
      '-nt',           // no timestamps
      '-np',           // no progress bar
      '-t', String(Math.max(1, Math.min(8, cpus().length - 1))),
    ];

    let stdout = '';
    let stderr = '';
    try {
      const text = await new Promise<string>((resolve, reject) => {
        const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        proc.stdout.on('data', (d) => { stdout += d.toString(); });
        proc.stderr.on('data', (d) => { stderr += d.toString(); });
        proc.on('exit', (code) => {
          if (code === 0) resolve(stdout);
          else {
            logger.warn({ code, stderr: stderr.slice(0, 300) }, 'voice.stt.local whisper-cli failed');
            reject(new Error(`whisper-cli exited ${code}: ${stderr.trim().split('\n').slice(-2).join(' | ')}`));
          }
        });
        proc.on('error', reject);
        opts.signal?.addEventListener('abort', () => {
          try { proc.kill('SIGTERM'); } catch { /* ignore */ }
        }, { once: true });
      });

      // whisper-cli with -nt prints lines like:  "  hello world"
      // Strip leading/trailing whitespace, drop blank lines, join.
      const cleaned = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith('['))
        .join(' ')
        .trim();

      yield { text: cleaned, isFinal: true };
    } finally {
      fs.unlink(wavPath).catch(() => { /* best effort */ });
    }
  }
}

/**
 * Build a minimal canonical PCM WAV header for the given raw s16le buffer.
 * Layout: RIFF(WAVE) + 'fmt '(PCM) + 'data'.
 */
function wrapWav(pcm: Buffer, sampleRate: number, channels: number): Buffer {
  const byteRate = sampleRate * channels * 2;
  const blockAlign = channels * 2;
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);                  // PCM fmt chunk size
  header.writeUInt16LE(1, 20);                   // audio format = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);                  // bits/sample
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm], 44 + dataSize);
}

registerSTTProvider('local', async () => new LocalSTT());

export { LocalSTT };
