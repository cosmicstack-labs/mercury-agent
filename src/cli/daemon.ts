import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import chalk from 'chalk';
import { getMercuryHome } from '../utils/config.js';
import { killStaleSignalCliProcesses } from '../signal/jsonrpc.js';
import { getWebPort, readAttachToken } from '../web/auth.js';

/**
 * Detect whether Mercury is running from a standalone, single-file binary
 * (produced by `bun build --compile`). In that case `process.execPath` IS
 * the Mercury binary and `process.argv[1]` is a bun-virtual path (e.g.
 * `/$bunfs/root/...`) that must NOT be forwarded to a child process.
 */
export function isStandaloneBinary(): boolean {
  // Bun sets this flag whenever the runtime is bun (including --compile output).
  const isBunRuntime = typeof (process.versions as any).bun === 'string';
  if (!isBunRuntime) return false;

  const arg1 = process.argv[1];
  if (!arg1) return true;
  // Bun's embedded fs path markers (POSIX `$bunfs`, Windows `B:/~BUN/`).
  if (arg1.includes('$bunfs') || arg1.includes('/~BUN/') || arg1.includes('\\~BUN\\')) return true;
  // Heuristic: standalone binary's execPath is not `node`/`bun` (it's the app name).
  const execName = (process.execPath.split(/[\\/]/).pop() || '').toLowerCase();
  if (!execName.startsWith('node') && !execName.startsWith('bun')) return true;
  return false;
}

/**
 * Build the argv used to respawn Mercury as a detached daemon.
 * For standalone binaries we invoke the binary directly (no script path),
 * because Commander treats the bun-virtual path as an unknown subcommand.
 */
export function buildDaemonSpawnArgs(): { command: string; args: string[] } {
  if (isStandaloneBinary()) {
    return { command: process.execPath, args: ['start', '--daemon'] };
  }
  const script = process.argv[1];
  if (!script) {
    // Last-resort guard — caller will surface the error via ensureDaemonRunning().
    throw new Error('Cannot determine Mercury entry script for daemon spawn');
  }
  return { command: process.execPath, args: [script, 'start', '--daemon'] };
}

const PID_FILE = 'daemon.pid';
const FOREGROUND_PID_FILE = 'foreground.pid';
const LOG_FILE = 'daemon.log';

function pidPath(): string {
  return join(getMercuryHome(), PID_FILE);
}

function foregroundPidPath(): string {
  return join(getMercuryHome(), FOREGROUND_PID_FILE);
}

function logPath(): string {
  return join(getMercuryHome(), LOG_FILE);
}

export function registerRuntimeProcess(mode: 'daemon' | 'foreground'): void {
  const path = mode === 'daemon' ? pidPath() : foregroundPidPath();
  const existing = readTrackedPid(path);
  if (existing && existing !== process.pid && isProcessRunning(existing)) {
    throw new Error(`Mercury ${mode} runtime is already running (PID: ${existing})`);
  }
  const home = getMercuryHome();
  if (!existsSync(home)) mkdirSync(home, { recursive: true });
  writeFileSync(path, String(process.pid));
}

export function releaseRuntimeProcess(mode: 'daemon' | 'foreground'): void {
  const path = mode === 'daemon' ? pidPath() : foregroundPidPath();
  if (readTrackedPid(path) !== process.pid) return;
  try { unlinkSync(path); } catch {}
}

export function readPid(): number | null {
  return readTrackedPid(pidPath());
}

function readTrackedPid(path: string): number | null {
  if (!existsSync(path)) return null;
  try {
    const pid = parseInt(readFileSync(path, 'utf-8').trim(), 10);
    if (isNaN(pid)) return null;
    return pid;
  } catch {
    return null;
  }
}

export function getForegroundRuntimeStatus(): { running: boolean; pid: number | null } {
  const path = foregroundPidPath();
  const pid = readTrackedPid(path);
  if (!pid) return { running: false, pid: null };
  if (!isProcessRunning(pid)) {
    try { unlinkSync(path); } catch {}
    return { running: false, pid: null };
  }
  return { running: true, pid };
}

export async function stopForegroundRuntime(): Promise<boolean> {
  const status = getForegroundRuntimeStatus();
  if (!status.running || !status.pid) return true;

  // Graceful first (the foreground runtime also serves the local API when
  // the web dashboard is enabled); signal / TerminateProcess as fallback.
  const graceful = await requestGracefulShutdown(status.pid);
  if (!graceful) {
    try {
      process.kill(status.pid, process.platform === 'win32' ? undefined : 'SIGTERM');
    } catch {
      return false;
    }
  }

  if (!await waitForExit(status.pid, graceful ? 10_000 : 5_000)) {
    try { process.kill(status.pid, 'SIGKILL'); } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (isProcessRunning(status.pid)) return false;
  if (readTrackedPid(foregroundPidPath()) === status.pid) {
    try { unlinkSync(foregroundPidPath()); } catch {}
  }
  console.log(chalk.green(`  Stopped foreground Mercury (PID: ${status.pid})`));
  return true;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) return true;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return !isProcessRunning(pid);
}

/**
 * Ask the runtime to run its own `shutdown()` over the local web API
 * (`POST /api/shutdown`, attach-token auth, loopback only). Returns true
 * when the runtime acknowledged — the caller then waits for the pid to
 * exit. False when there is no token, no listener, the port belongs to
 * another runtime, or the request times out; the caller falls back to
 * signals / TerminateProcess.
 *
 * This is the only graceful path on Windows: `process.kill(pid)` there is
 * TerminateProcess, which never runs the runtime's shutdown hooks.
 */
export async function requestGracefulShutdown(
  pid: number,
  timeoutMs = 2_000,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const token = readAttachToken();
  if (!token) return false;
  try {
    const res = await fetchImpl(`http://127.0.0.1:${getWebPort()}/api/shutdown`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return false;
    const body = await res.json().catch(() => ({})) as { ok?: boolean; pid?: number };
    if (body?.ok !== true) return false;
    // A different process answering on the port must not make us believe
    // *this* pid is going away.
    return typeof body.pid !== 'number' || body.pid === pid;
  } catch {
    return false;
  }
}

export function getDaemonStatus(): { running: boolean; pid: number | null; logPath: string } {
  const pid = readPid();
  if (!pid) return { running: false, pid: null, logPath: logPath() };
  const running = isProcessRunning(pid);
  if (!running) {
    try { unlinkSync(pidPath()); } catch {}
    return { running: false, pid: null, logPath: logPath() };
  }
  return { running, pid, logPath: logPath() };
}

export function ensureDaemonRunning(): { pid: number; fresh: boolean } {
  const status = getDaemonStatus();
  if (status.running && status.pid) {
    return { pid: status.pid, fresh: false };
  }

  const home = getMercuryHome();
  if (!existsSync(home)) {
    mkdirSync(home, { recursive: true });
  }

  const logFile = logPath();
  const isWin = process.platform === 'win32';
  const outFd = openSync(logFile, 'a');

  const { command, args } = buildDaemonSpawnArgs();
  const child = spawn(command, args, {
    detached: true,
    stdio: ['ignore', outFd, outFd],
    env: { ...process.env },
    windowsHide: isWin,
  });

  child.unref();

  if (!child.pid) {
    throw new Error('Failed to spawn daemon process');
  }

  writeFileSync(pidPath(), String(child.pid));
  return { pid: child.pid, fresh: true };
}

export function startBackground(): void {
  try {
    const result = ensureDaemonRunning();
    console.log('');
    console.log(chalk.green(`  Mercury started in background (PID: ${result.pid})`));
    console.log(chalk.dim(`  Logs: ${logPath()}`));
    console.log(chalk.dim(`  Use \`mercury stop\` to stop.`));
    console.log(chalk.dim(`  Use \`mercury logs\` to view logs.`));
    console.log('');
  } catch (err: any) {
    console.log(chalk.red(`  Failed to start: ${err.message}`));
    process.exit(1);
  }
}

export async function stopDaemon(): Promise<boolean> {
  const status = getDaemonStatus();

  if (!status.pid) {
    console.log(chalk.yellow('  Mercury is not running as a daemon.'));
    killStaleSignalCliProcesses();
    console.log('');
    return true;
  }

  if (!status.running) {
    console.log(chalk.yellow(`  Stale PID file found (PID: ${status.pid} is not running). Cleaning up.`));
    try { unlinkSync(pidPath()); } catch {}
    killStaleSignalCliProcesses();
    console.log('');
    return true;
  }

  console.log(chalk.dim(`  Stopping Mercury (PID: ${status.pid})...`));

  // 1. Ask the runtime to shut itself down over the local API — the only
  //    path that runs shutdown() on Windows. 2. Otherwise SIGTERM (POSIX)
  //    or TerminateProcess (Windows). 3. SIGKILL as the last resort.
  const graceful = await requestGracefulShutdown(status.pid);
  if (!graceful) {
    try {
      if (process.platform === 'win32') {
        process.kill(status.pid);
      } else {
        process.kill(status.pid, 'SIGTERM');
      }
    } catch {
      console.log(chalk.red(`  Failed to stop PID ${status.pid}. You may need to kill it manually.`));
      killStaleSignalCliProcesses();
      console.log('');
      return false;
    }
  }

  // A graceful shutdown notifies channels and consolidates memory first —
  // give it longer than a plain signal before forcing.
  await waitForExit(status.pid, graceful ? 10_000 : 5_000);

  if (isProcessRunning(status.pid)) {
    console.log(chalk.yellow('  Mercury did not exit gracefully, forcing...'));
    try {
      process.kill(status.pid, 'SIGKILL');
    } catch { /* already dead */ }
    // Wait briefly for SIGKILL to take effect
    await new Promise(resolve => setTimeout(resolve, 500));
    if (isProcessRunning(status.pid)) {
      console.log(chalk.red(`  Failed to stop PID ${status.pid}. Cloud disconnect aborted.`));
      return false;
    }
  }

  try { unlinkSync(pidPath()); } catch {}

  killStaleSignalCliProcesses();

  console.log(chalk.green(`  Mercury stopped (PID: ${status.pid})`));
  console.log('');
  return true;
}

export async function restartDaemon(): Promise<void> {
  if (getDaemonStatus().running) {
    if (!await stopDaemon()) return;
  }

  console.log(chalk.yellow('  Starting Mercury...'));
  startBackground();
}

export function showLogs(): void {
  const logFile = logPath();
  if (!existsSync(logFile)) {
    console.log(chalk.dim('  No daemon log file found.'));
    console.log('');
    return;
  }
  const content = readFileSync(logFile, 'utf-8');
  const lines = content.split(/\r?\n/).slice(-100);
  console.log(lines.join('\n'));
}

export function tryAutoDaemonize(): boolean {
  try {
    const result = ensureDaemonRunning();
    return result.pid > 0;
  } catch {
    return false;
  }
}
