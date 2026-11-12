import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeCommand } from './run-command.js';

/**
 * ADR-038: a stop ends the whole command, not just its shell. `npm run build`
 * or `python train.py` used to keep running after Stop because only `sh`
 * was killed; and the SIGKILL escalation was cleared before it could fire.
 */

const posix = process.platform !== 'win32';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function pidFrom(file: string): Promise<number> {
  for (let i = 0; i < 200; i++) {
    if (existsSync(file)) {
      const text = readFileSync(file, 'utf8').trim();
      if (text) return Number(text);
    }
    await tick(10);
  }
  throw new Error('grandchild never started');
}

describe.runIf(posix)('stopping a command ends its whole process tree', () => {
  it('a background grandchild dies with the command', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mercury-tree-'));
    dirs.push(dir);
    const pidFile = join(dir, 'pid');
    const controller = new AbortController();
    const run = executeCommand(`sleep 60 & echo $! > "${pidFile}"; wait`, dir, 60_000, { signal: controller.signal });
    const grandchild = await pidFrom(pidFile);
    expect(alive(grandchild)).toBe(true);
    controller.abort();
    const result = await run;
    expect(result.aborted).toBe(true);
    for (let i = 0; i < 100 && alive(grandchild); i++) await tick(20);
    expect(alive(grandchild)).toBe(false);
  });

  it('a grandchild that ignores SIGTERM is killed after the grace period', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mercury-tree-'));
    dirs.push(dir);
    const pidFile = join(dir, 'pid');
    const controller = new AbortController();
    const run = executeCommand(`trap '' TERM; sleep 60 & echo $! > "${pidFile}"; wait`, dir, 60_000, { signal: controller.signal });
    const grandchild = await pidFrom(pidFile);
    controller.abort();
    await run;
    await tick(500);
    expect(alive(grandchild)).toBe(true); // ignored SIGTERM...
    for (let i = 0; i < 80 && alive(grandchild); i++) await tick(100);
    expect(alive(grandchild)).toBe(false); // ...but not SIGKILL
  }, 15_000);

  it('a command that finishes normally is untouched', async () => {
    const result = await executeCommand('echo done', tmpdir(), 10_000);
    expect(result).toMatchObject({ exitCode: 0, aborted: false, timedOut: false });
    expect(result.stdout.trim()).toBe('done');
  });
});
