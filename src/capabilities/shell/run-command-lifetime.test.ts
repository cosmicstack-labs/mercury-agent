import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeArgv, executeCommand } from './run-command.js';

const roots: string[] = [];
const pids = new Set<number>();
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
afterEach(() => {
  // Also clean up the broken implementation's escaped fixtures when a regression fails.
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ } }
  pids.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mercury-command-lifetime-'));
  roots.push(root);
  const script = join(root, 'worker.cjs');
  const output = join(root, 'writes.txt');
  const ready = join(root, 'ready.json');
  writeFileSync(script, `
    const fs = require('node:fs');
    const { spawn } = require('node:child_process');
    const [mode, output, ready] = process.argv.slice(2);
    if (mode === 'parent' || mode === 'redirected') {
      spawn(process.execPath, [__filename, 'writer', output, ready], { stdio: mode === 'redirected' ? 'ignore' : ['ignore', 'inherit', 'inherit'] });
      const readyPulse = setInterval(() => {
        if (fs.existsSync(ready)) { console.log('child ready'); clearInterval(readyPulse); }
      }, 10);
    } else {
      process.on('SIGTERM', () => { console.log('ignoring TERM'); });
      fs.writeFileSync(ready + '.tmp', JSON.stringify({ pid: process.pid }));
      fs.renameSync(ready + '.tmp', ready);
      console.log('writer ready');
      setInterval(() => fs.appendFileSync(output, 'tick\\n'), 25);
      setTimeout(() => process.exit(0), 15000);
    }
  `);
  return { root, script, output, ready };
}

// Windows does not offer catchable POSIX SIGTERM. Its taskkill tree behavior
// is exercised by the portable executor tests and the mocked lifetime tests.
describe.skipIf(process.platform === 'win32')('command termination lifetime', () => {
  it.each(['argv', 'shell descendant', 'redirected descendant'] as const)('waits for a TERM-ignoring %s to stop writing before settling', async (lane) => {
    const { root, script, output, ready } = fixture();
    const controller = new AbortController();
    let started = false;
    const onActivity = () => {
      if (started || !existsSync(ready)) return;
      started = true;
      pids.add(JSON.parse(readFileSync(ready, 'utf8')).pid);
      controller.abort();
    };
    const options = { signal: controller.signal, onActivity };
    // Abort happens first; a later timeout during the grace period must not
    // change the result to timedOut or cancel the scheduled SIGKILL.
    const result = lane === 'argv'
      ? await executeArgv(process.execPath, [script, 'writer', output, ready], root, 1000, options)
      : await executeCommand([process.execPath, script, lane === 'redirected descendant' ? 'redirected' : 'parent', output, ready].map((s) => `'${s.replaceAll("'", "'\\''")}'`).join(' '), root, 1000, options);
    expect(started).toBe(true);
    expect(result).toMatchObject({ aborted: true, timedOut: false, exitCode: null });
    const before = existsSync(output) ? readFileSync(output, 'utf8') : '';
    await delay(150);
    const after = existsSync(output) ? readFileSync(output, 'utf8') : '';
    expect(after).toBe(before);
    if (lane !== 'redirected descendant') expect(result.stdout).toContain('ignoring TERM');
  }, 12_000);

  it('collects descendant output after the direct child has exited', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mercury-command-drain-'));
    roots.push(root);
    const source = `require('node:child_process').spawn(process.execPath, ['-e', "setTimeout(() => console.log('tail after parent exit'), 150)"], { stdio: ['ignore', 'inherit', 'inherit'] }); process.exit(0);`;
    const result = await executeArgv(process.execPath, ['-e', source], root, 5000);
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, aborted: false });
    expect(result.stdout).toContain('tail after parent exit');
  });
});
