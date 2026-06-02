/**
 * System binary detection for audio I/O.
 *
 * Mercury cannot bundle ffmpeg/sox — they are large (30–80 MB each per
 * platform) and have non-trivial licensing concerns. Instead we detect
 * what is present at runtime and report friendly install hints when
 * something is missing.
 *
 * Detection is cached for the lifetime of the process; the path to each
 * binary, if any, is also cached so callers don't have to re-resolve.
 *
 * Cross-platform: works under Node and Bun (including Bun-compiled
 * standalone binaries — `child_process.spawn` is fine in both).
 */
import { spawnSync } from 'node:child_process';
import { runtime } from '../runtime.js';

export interface BinaryInfo {
  /** Canonical name (e.g. 'ffmpeg'). */
  name: string;
  /** Absolute path when found, null when not. */
  path: string | null;
  /** Version string when easily parseable, undefined otherwise. */
  version?: string;
  /** OS-appropriate install hint. */
  installHint: string;
}

/* ── Install hint table per OS ────────────────────────────────────────── */

function installHint(name: 'ffmpeg' | 'sox' | 'espeak-ng' | 'whisper-cli'): string {
  switch (runtime.os) {
    case 'macos':
      if (name === 'whisper-cli') return 'brew install whisper-cpp';
      if (name === 'espeak-ng')   return 'brew install espeak-ng';
      return `brew install ${name}`;
    case 'linux':
      if (name === 'whisper-cli')
        return 'see https://github.com/ggml-org/whisper.cpp (build & install whisper-cli)';
      return `sudo apt install ${name}    # or: dnf install ${name} / pacman -S ${name}`;
    case 'windows':
      if (name === 'whisper-cli')
        return 'download whisper.cpp release from https://github.com/ggml-org/whisper.cpp/releases';
      if (name === 'espeak-ng')
        return 'winget install eSpeak-NG.eSpeak-NG  # or: choco install espeak';
      return name === 'ffmpeg'
        ? 'winget install Gyan.FFmpeg     # or: choco install ffmpeg'
        : 'choco install sox              # or: scoop install sox';
    case 'android':
      return `pkg install ${name}         # in Termux`;
    default:
      return `install ${name} via your platform's package manager`;
  }
}

/** Default location Mercury looks for a whisper.cpp ggml model file. */
export function defaultWhisperModelPath(): string {
  return `${process.env.HOME ?? process.env.USERPROFILE ?? '.'}/.mercury/whisper/ggml-base.en.bin`;
}

/* ── Locate a binary on PATH ──────────────────────────────────────────── */

function which(name: string): string | null {
  // Use the platform-appropriate command. We avoid relying on shell PATH
  // resolution inside spawn() so we can capture stderr cleanly.
  const cmd = runtime.os === 'windows' ? 'where' : 'command';
  const args = runtime.os === 'windows' ? [name] : ['-v', name];
  try {
    const result = spawnSync(cmd, args, {
      encoding: 'utf8',
      shell: runtime.os !== 'windows', // `command -v` is a shell builtin
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status !== 0 || !result.stdout) return null;
    // `where` can return multiple lines; take the first.
    const first = result.stdout.split(/\r?\n/).find((line) => line.trim().length > 0);
    return first ? first.trim() : null;
  } catch {
    return null;
  }
}

/* ── Version probe (best-effort) ──────────────────────────────────────── */

function probeVersion(path: string, args: string[]): string | undefined {
  try {
    const r = spawnSync(path, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const out = (r.stdout || '') + (r.stderr || ''); // ffmpeg prints to stderr
    const m = out.match(/version\s+(\S+)/i) || out.match(/(\d+\.\d+(\.\d+)?)/);
    return m ? m[1] : undefined;
  } catch {
    return undefined;
  }
}

/* ── Public API ───────────────────────────────────────────────────────── */

const cache = new Map<string, BinaryInfo>();

export function findBinary(name: 'ffmpeg' | 'ffplay' | 'sox' | 'rec' | 'afplay' | 'aplay' | 'paplay' | 'pw-play' | 'termux-microphone-record' | 'termux-tts-speak' | 'play-audio' | 'say' | 'espeak' | 'espeak-ng' | 'powershell' | 'pwsh' | 'whisper-cli' | 'whisper' | 'main'): BinaryInfo {
  const cached = cache.get(name);
  if (cached) return cached;

  const path = which(name);
  const info: BinaryInfo = {
    name,
    path,
    installHint:
      name === 'ffmpeg' || name === 'ffplay' ? installHint('ffmpeg')
      : name === 'sox' || name === 'rec' ? installHint('sox')
      : name === 'espeak' || name === 'espeak-ng' ? installHint('espeak-ng')
      : name === 'whisper-cli' || name === 'whisper' || name === 'main' ? installHint('whisper-cli')
      : '', // platform tools (afplay/aplay/say/powershell) ship with the OS
  };

  if (path && (name === 'ffmpeg' || name === 'ffplay' || name === 'sox')) {
    info.version = probeVersion(path, ['-version']);
  }

  cache.set(name, info);
  return info;
}

/** Reset cache; only used by tests. */
export function _resetBinaryCacheForTests(): void {
  cache.clear();
}

/**
 * Convenience: report all audio-relevant binaries for /voice status and
 * `mercury doctor --voice`.
 */
export function probeAllAudioBinaries(): BinaryInfo[] {
  const targets: Array<Parameters<typeof findBinary>[0]> = ['ffmpeg', 'ffplay', 'sox'];
  if (runtime.os === 'macos')   targets.push('afplay', 'say');
  if (runtime.os === 'linux')   targets.push('aplay', 'paplay', 'pw-play', 'espeak-ng', 'espeak');
  if (runtime.os === 'windows') targets.push('powershell');
  if (runtime.os === 'android') targets.push('termux-microphone-record', 'termux-tts-speak', 'play-audio');
  // Local STT (any OS — bring-your-own whisper.cpp).
  targets.push('whisper-cli');
  return targets.map((t) => findBinary(t));
}
