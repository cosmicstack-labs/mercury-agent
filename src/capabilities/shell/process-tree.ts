/**
 * Stopping a command means stopping everything it started (ADR-038).
 *
 * A shell command (`npm run build`, `python train.py`, `a && b`) is a tree:
 * the shell, and the processes it runs, and theirs. Killing only the shell
 * left the real work running after the owner pressed Stop. So on POSIX each
 * command starts in its own process group (`detached`) and is signalled as
 * a group; on Windows the tree is ended with `taskkill /T /F`.
 *
 * Groups still alive when Mercury exits are terminated too, since a detached
 * group no longer receives the terminal's Ctrl+C.
 */
import { spawn, type ChildProcess } from 'node:child_process';

const IS_WINDOWS = process.platform === 'win32';
const liveGroups = new Set<number>();
let exitHookInstalled = false;

/** Spawn options that give the command its own process group (POSIX). */
export function processTreeSpawnOptions(): { detached: boolean } {
  return { detached: !IS_WINDOWS };
}

/** Remember a started command so Mercury's exit can end it. */
export function trackProcessTree(child: ChildProcess): void {
  if (IS_WINDOWS || !child.pid) return;
  liveGroups.add(child.pid);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on('exit', () => {
      for (const pgid of liveGroups) {
        try { process.kill(-pgid, 'SIGTERM'); } catch { /* already gone */ }
      }
    });
  }
}

/** The command is over and nothing of it needs ending at exit. */
export function untrackProcessTree(child: ChildProcess): void {
  if (child.pid) liveGroups.delete(child.pid);
}

/** Is any process of this command's group still alive? */
export function processTreeAlive(child: ChildProcess): boolean {
  if (!child.pid) return false;
  if (IS_WINDOWS) return child.exitCode === null && child.signalCode === null;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Signal the whole tree. POSIX: the process group (falls back to the child
 * alone if it has no group). Windows: `taskkill /T /F` (no graceful step
 * exists for console trees there, so both signals end it).
 */
export function killProcessTree(child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL'): void {
  const pid = child.pid;
  if (!pid) return;
  if (IS_WINDOWS) {
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => { try { child.kill(signal); } catch { /* gone */ } });
    } catch {
      try { child.kill(signal); } catch { /* gone */ }
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* gone */ }
  }
}
