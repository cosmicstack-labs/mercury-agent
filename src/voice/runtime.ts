/**
 * Runtime detection for the voice subsystem.
 *
 * Mercury ships two artifacts:
 *   1. An npm package (Node ≥ 20) — native modules can load via `dlopen`.
 *   2. Bun-compiled standalone binaries — cannot load .node addons because
 *      they are bundled into a single executable with no on-disk module tree.
 *
 * We also support Termux on Android, which has neither /dev/snd nor
 * PulseAudio; audio I/O goes through `termux-api` CLI tools instead.
 *
 * Every voice-related code path consults `runtime` to decide whether to
 * attempt a native import or skip straight to the cross-platform fallback.
 * The rule is simple: native modules are a latency optimization, never a
 * correctness requirement. The Bun binary path must always work.
 */
import { platform as osPlatform } from 'node:os';
import process from 'node:process';

export type OSFamily = 'macos' | 'linux' | 'windows' | 'android' | 'unknown';
export type RuntimeKind = 'node' | 'bun' | 'unknown';

function detectOS(): OSFamily {
  // Termux exposes platform === 'android' on modern Node; older versions
  // report 'linux' with TERMUX_VERSION env set.
  if (process.env.TERMUX_VERSION || (process as any).platform === 'android') {
    return 'android';
  }
  switch (osPlatform()) {
    case 'darwin': return 'macos';
    case 'linux':  return 'linux';
    case 'win32':  return 'windows';
    default:       return 'unknown';
  }
}

function detectRuntime(): RuntimeKind {
  // `Bun` global is defined in both `bun run` and Bun-compiled binaries.
  if (typeof (globalThis as any).Bun !== 'undefined') return 'bun';
  if (typeof process !== 'undefined' && process.versions?.node) return 'node';
  return 'unknown';
}

function detectBunCompiled(): boolean {
  // Bun-compiled binaries don't have node_modules on disk and report a
  // mercury-* basename in process.execPath. We use the execPath heuristic
  // because Bun does not yet expose a definitive API for this.
  if (typeof (globalThis as any).Bun === 'undefined') return false;
  try {
    const exec = process.execPath || '';
    const base = exec.split(/[\\/]/).pop() || '';
    // `bun` itself is the dev path; anything else is a compiled binary.
    return base !== 'bun' && base !== 'bun.exe';
  } catch {
    return false;
  }
}

function detectSSH(): boolean {
  return !!(process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY);
}

function detectCI(): boolean {
  return !!(process.env.CI || process.env.CONTINUOUS_INTEGRATION || process.env.GITHUB_ACTIONS);
}

const _os = detectOS();
const _rt = detectRuntime();
const _bunCompiled = detectBunCompiled();

export const runtime = {
  os: _os,
  kind: _rt,
  isBun: _rt === 'bun',
  /** True when running from a Bun-compiled standalone binary (no .node loading). */
  isBunCompiled: _bunCompiled,
  isNode: _rt === 'node',
  isTermux: _os === 'android' || !!process.env.TERMUX_VERSION,
  isSSH: detectSSH(),
  isCI: detectCI(),
  /**
   * Whether native node addons (`.node` files) can be loaded.
   * False in Bun-compiled binaries; true otherwise.
   * Every `await import('speaker')`, etc. must guard on this.
   */
  canLoadNative: !_bunCompiled,
  /** Human-readable description, useful for status/doctor output. */
  describe(): string {
    const parts: string[] = [_os, _rt];
    if (_bunCompiled) parts.push('compiled');
    if (this.isTermux) parts.push('termux');
    if (this.isSSH) parts.push('ssh');
    return parts.join('/');
  },
} as const;

export type Runtime = typeof runtime;
