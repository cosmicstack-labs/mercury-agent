import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import chalk from 'chalk';
import { getMercuryHome } from '../utils/config.js';

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

  const child = spawn(process.execPath, [process.argv[1], 'start', '--daemon'], {
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

export function stopDaemon(): void {
  const status = getDaemonStatus();

  if (!status.pid) {
    console.log(chalk.yellow('  Mercury is not running as a daemon.'));
    console.log('');
    process.exit(0);
  }

  if (!status.running) {
    console.log(chalk.yellow(`  Stale PID file found (PID: ${status.pid} is not running). Cleaning up.`));
    try { unlinkSync(pidPath()); } catch {}
    console.log('');
    process.exit(0);
  }

  try {
    if (process.platform === 'win32') {
      process.kill(status.pid);
    } else {
      process.kill(status.pid, 'SIGTERM');
    }
    console.log(chalk.green(`  Mercury stopped (PID: ${status.pid})`));
  } catch {
    console.log(chalk.red(`  Failed to stop PID ${status.pid}. You may need to kill it manually.`));
  }

  try { unlinkSync(pidPath()); } catch {}
  console.log('');
}

export function restartDaemon(): void {
  const status = getDaemonStatus();

  if (status.running && status.pid) {
    console.log(chalk.yellow(`  Stopping Mercury (PID: ${status.pid})...`));
    try {
      if (process.platform === 'win32') {
        process.kill(status.pid);
      } else {
        process.kill(status.pid, 'SIGTERM');
      }
    } catch {
      // process may have already exited
    }
    try { unlinkSync(pidPath()); } catch {}
    console.log(chalk.green('  Mercury stopped.'));
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