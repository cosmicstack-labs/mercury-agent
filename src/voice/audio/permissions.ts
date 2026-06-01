/**
 * Microphone permission detection.
 *
 * Strategy: test-capture probe. We attempt a 100 ms ffmpeg recording with
 * stderr captured; the resulting status + error text tells us whether the
 * device is accessible. This works identically under Node, Bun, and
 * Bun-compiled binaries — no native modules required.
 *
 * The probe is called from four places:
 *   1. Onboarding (configure() voice step)
 *   2. `mercury doctor --voice`
 *   3. VoiceManager.enable() at startup
 *   4. First push-to-talk press (revoke detection)
 *
 * Result interpretation:
 *   - exit 0                  → 'authorized'
 *   - exit non-zero + "permission denied" in stderr → 'denied'
 *   - exit non-zero + "no such device" in stderr   → 'unavailable'
 *   - exit non-zero, other    → 'not-determined' (likely will prompt on retry)
 *
 * On macOS the very first probe triggers the system TCC prompt for the host
 * terminal app (Terminal.app, iTerm2, Ghostty, etc.) — exactly the behavior
 * we want. After that, status is sticky until the user changes it in
 * System Settings.
 */
import { spawn } from 'node:child_process';
import { runtime } from '../runtime.js';
import { findBinary } from './system.js';
import type { MicPermissionStatus } from '../types.js';
import { logger } from '../../utils/logger.js';

export interface MicPermission {
  status: MicPermissionStatus;
  canPrompt: boolean;
  request(): Promise<MicPermissionStatus>;
  hint(): string;
}

const PROBE_DURATION_MS = 200;

export async function detectMicPermission(): Promise<MicPermission> {
  if (runtime.isSSH) {
    return makePerm('unavailable', false,
      'No microphone in SSH session — voice STT requires a local terminal.');
  }
  if (runtime.isCI) {
    return makePerm('unavailable', false,
      'No microphone in CI environment.');
  }

  switch (runtime.os) {
    case 'macos':   return await probeViaFfmpeg('macos');
    case 'linux':   return await probeViaFfmpeg('linux');
    case 'windows': return await probeViaFfmpeg('windows');
    case 'android': return await probeTermux();
    default:
      return makePerm('unavailable', false,
        `Microphone permission probing is not supported on ${runtime.os}.`);
  }
}

/* ── Generic ffmpeg test-capture probe ────────────────────────────────── */

async function probeViaFfmpeg(
  os: 'macos' | 'linux' | 'windows',
): Promise<MicPermission> {
  const ffmpeg = findBinary('ffmpeg');
  if (!ffmpeg.path) {
    // Without ffmpeg we can't probe; return 'not-determined' so doctor
    // surfaces the missing-binary hint rather than a misleading 'denied'.
    return makePerm('not-determined', false,
      `Install ffmpeg first to probe microphone access. ${ffmpeg.installHint}`);
  }

  const args = pickProbeArgs(os);
  const { exitCode, stderr } = await runProbe(ffmpeg.path, args);

  if (exitCode === 0) {
    return makePerm('authorized', false, 'Microphone is accessible.');
  }

  const text = stderr.toLowerCase();
  // macOS: TCC blocks input ops with various phrasings. Anything that
  // mentions permission/privacy/avfoundation is treated as denied.
  if (/permission denied|operation not permitted|privacy|tcc|avfoundation input device|not authorized/i.test(text)) {
    return makePerm('denied', os === 'macos',
      grantHint(os));
  }
  if (/no such device|cannot open|no audio device|requested input device/i.test(text)) {
    return makePerm('unavailable', false,
      `No microphone device found. Connect a mic and re-run.`);
  }
  // First-time macOS access may produce ambiguous failures because the
  // OS prompt is shown asynchronously and the probe terminates first.
  // Return 'not-determined' so onboarding can ask the user to retry.
  if (os === 'macos') {
    return makePerm('not-determined', true,
      'macOS may have just shown a permission dialog. Click Allow, then retry.');
  }
  return makePerm('not-determined', false,
    `Could not determine mic status (ffmpeg exit ${exitCode}). Re-run to retry.`);
}

function pickProbeArgs(os: 'macos' | 'linux' | 'windows'): string[] {
  // Read a tiny PCM clip to /dev/null (or NUL on Windows). Quiet log level
  // so success doesn't spam the terminal.
  const sink = os === 'windows' ? 'NUL' : '/dev/null';
  switch (os) {
    case 'macos':
      return ['-hide_banner', '-loglevel', 'error',
              '-f', 'avfoundation', '-i', ':default',
              '-t', '0.2', '-f', 'null', sink];
    case 'linux':
      return ['-hide_banner', '-loglevel', 'error',
              '-f', 'pulse', '-i', 'default',
              '-t', '0.2', '-f', 'null', sink];
    case 'windows':
      return ['-hide_banner', '-loglevel', 'error',
              '-f', 'dshow', '-i', 'audio=default',
              '-t', '0.2', '-f', 'null', sink];
  }
}

function runProbe(bin: string, args: string[]): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve) => {
    let stderr = '';
    let settled = false;
    const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });

    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      resolve({ exitCode: -1, stderr: err.message });
    });

    proc.on('exit', (code) => {
      if (settled) return;
      settled = true;
      resolve({ exitCode: code ?? -1, stderr });
    });

    // Hard timeout in case ffmpeg hangs (e.g. waiting on a permission dialog).
    setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      resolve({ exitCode: -1, stderr: stderr + '\nprobe timeout' });
    }, PROBE_DURATION_MS * 6);
  });
}

/* ── Termux probe ─────────────────────────────────────────────────────── */

async function probeTermux(): Promise<MicPermission> {
  const tool = findBinary('termux-microphone-record');
  if (!tool.path) {
    return makePerm('unavailable', false,
      'termux-api not installed. Run `pkg install termux-api` and install the Termux:API app from F-Droid.');
  }
  // `termux-microphone-record -i` returns recording info; it errors when
  // permission is denied. Cheap and side-effect-free.
  const result = await new Promise<{ exitCode: number; stderr: string }>((resolve) => {
    const proc = spawn(tool.path!, ['-i'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('exit', (code) => resolve({ exitCode: code ?? -1, stderr }));
    proc.on('error', (err) => resolve({ exitCode: -1, stderr: err.message }));
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } }, 2000);
  });

  if (result.exitCode === 0) {
    return makePerm('authorized', false, 'Termux microphone is accessible.');
  }
  if (/permission/i.test(result.stderr)) {
    return makePerm('denied', true,
      'Grant Termux:API microphone access in Android Settings → Apps → Termux:API → Permissions.');
  }
  return makePerm('not-determined', true,
    'First-time use will trigger an Android permission dialog. Press PTT to retry.');
}

/* ── Helpers ──────────────────────────────────────────────────────────── */

function grantHint(os: 'macos' | 'linux' | 'windows'): string {
  switch (os) {
    case 'macos':
      return 'Grant microphone access in System Settings → Privacy & Security → Microphone, then enable your terminal app.';
    case 'linux':
      return 'Ensure your user is in the `audio` group: `sudo usermod -a -G audio $USER` then log out and back in.';
    case 'windows':
      return 'Enable microphone access in Settings → Privacy & Security → Microphone, and allow desktop apps.';
  }
}

function makePerm(
  status: MicPermissionStatus,
  canPrompt: boolean,
  hintText: string,
): MicPermission {
  return {
    status,
    canPrompt,
    async request() {
      if (!canPrompt) return status;
      // Re-run the probe: on macOS this triggers the TCC dialog,
      // on Termux it triggers the Android permission sheet.
      try {
        const refreshed = await detectMicPermission();
        return refreshed.status;
      } catch (err) {
        logger.warn({ err }, 'voice.permission.request failed');
        return status;
      }
    },
    hint() { return hintText; },
  };
}
