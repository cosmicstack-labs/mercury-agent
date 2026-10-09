import { describe, expect, it } from 'vitest';
import { executeCommand } from './run-command.js';

// Portable long-running child: Node itself, printing a line every 200 ms.
const TICKER = `${JSON.stringify(process.execPath)} -e "let n=0;setInterval(()=>{console.log('tick',++n);},200)"`;
const QUIET = `${JSON.stringify(process.execPath)} -e "setTimeout(()=>{},5000)"`;

describe('run_command executor (ROADMAP P1.8)', () => {
  it('pulses on output so a streaming build counts as progress', async () => {
    let pulses = 0;
    const controller = new AbortController();
    const run = executeCommand(TICKER, process.cwd(), 10_000, { signal: controller.signal, onActivity: () => { pulses++; } });
    await new Promise((r) => setTimeout(r, 900));
    controller.abort();
    const result = await run;
    expect(pulses).toBeGreaterThanOrEqual(3);
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toContain('tick');
  });

  it('terminates the child promptly when the agent loop aborts', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const run = executeCommand(QUIET, process.cwd(), 30_000, { signal: controller.signal });
    setTimeout(() => controller.abort(), 150);
    const result = await run;
    expect(result.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('returns aborted immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await executeCommand(QUIET, process.cwd(), 30_000, { signal: controller.signal });
    expect(result.aborted).toBe(true);
  });

  it('still reports a timeout as timed out, not aborted', async () => {
    const result = await executeCommand(QUIET, process.cwd(), 300);
    expect(result.timedOut).toBe(true);
    expect(result.aborted).toBe(false);
  });

  it('reports exit codes for normal completion', async () => {
    const ok = await executeCommand(`${JSON.stringify(process.execPath)} -e "console.log('hi')"`, process.cwd(), 5_000);
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout.trim()).toBe('hi');
    const bad = await executeCommand(`${JSON.stringify(process.execPath)} -e "process.exit(3)"`, process.cwd(), 5_000);
    expect(bad.exitCode).toBe(3);
  });
});
