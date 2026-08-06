import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import chalk from 'chalk';
import { getMercuryHome } from '../utils/config.js';
import { killStaleSignalCliProcesses } from '../signal/jsonrpc.js';

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
const LOG_FILE = 'daemon.log';

function pidPath(): string {
  return join(getMercuryHome(), PID_FILE);
}

function logPath(): string {
  return join(getMercuryHome(), LOG_FILE);
}

export function readPid(): number | null {
  const path = pidPath();
  if (!existsSync(path)) return null;
  try {
    const pid = parseInt(readFileSync(path, 'utf-8').trim(), 10);
    if (isNaN(pid)) return null;
    return pid;
  } catch {
    return null;
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
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

export async function stopDaemon(): Promise<void> {
  const status = getDaemonStatus();

  if (!status.pid) {
    console.log(chalk.yellow('  Mercury is not running as a daemon.'));
    killStaleSignalCliProcesses();
    console.log('');
    return;
  }

  if (!status.running) {
    console.log(chalk.yellow(`  Stale PID file found (PID: ${status.pid} is not running). Cleaning up.`));
    try { unlinkSync(pidPath()); } catch {}
    killStaleSignalCliProcesses();
    console.log('');
    return;
  }

  try {
    if (process.platform === 'win32') {
      process.kill(status.pid);
    } else {
      process.kill(status.pid, 'SIGTERM');
    }
  } catch {
    console.log(chalk.red(`  Failed to stop PID ${status.pid}. You may need to kill it manually.`));
    try { unlinkSync(pidPath()); } catch {}
    killStaleSignalCliProcesses();
    console.log('');
    return;
  }

  console.log(chalk.dim(`  Stopping Mercury (PID: ${status.pid})...`));

  // Wait up to 5 seconds for the process to exit
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!isProcessRunning(status.pid)) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  if (isProcessRunning(status.pid)) {
    console.log(chalk.yellow('  Mercury did not exit gracefully, forcing...'));
    try {
      process.kill(status.pid, 'SIGKILL');
    } catch { /* already dead */ }
    // Wait briefly for SIGKILL to take effect
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  try { unlinkSync(pidPath()); } catch {}

  killStaleSignalCliProcesses();

  console.log(chalk.green(`  Mercury stopped (PID: ${status.pid})`));
  console.log('');
}

export async function restartDaemon(): Promise<void> {
  if (getDaemonStatus().running) {
    await stopDaemon();
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