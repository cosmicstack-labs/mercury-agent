import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { createPrompter, InputClosedError } from './ask.js';

/**
 * Wizard input contract (#64): a closed stdin must fail the pending
 * question loudly — never hang, never let the process exit 0 as if setup
 * had completed — and the shared interface must not pin stdin open once
 * no question is waiting.
 */

function io() {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (chunk) => { written += String(chunk); });
  return { input, output, prompter: createPrompter({ input, output }), written: () => written };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('ask()', () => {
  it('answers consecutive questions from one input stream and trims the answers', async () => {
    const { input, prompter, written } = io();
    const first = prompter.ask('Name: ');
    input.write('  Jane \n');
    expect(await first).toBe('Jane');
    const second = prompter.ask('Agent: ');
    input.write('Mercury\n');
    expect(await second).toBe('Mercury');
    expect(written()).toContain('Name: ');
    expect(written()).toContain('Agent: ');
    prompter.close();
  });

  it('rejects the pending question with InputClosedError when stdin hits EOF', async () => {
    const { input, prompter } = io();
    const pending = prompter.ask('Token: ');
    input.end(); // EOF with no answer — the silent-exit case
    await expect(pending).rejects.toBeInstanceOf(InputClosedError);
    await expect(pending).rejects.toThrow(/stdin reached EOF/);
  });

  it('rejects every later question immediately once input has ended (no hang)', async () => {
    const { input, prompter } = io();
    const pending = prompter.ask('A: ');
    input.end();
    await expect(pending).rejects.toBeInstanceOf(InputClosedError);
    // A fresh interface on an ended stream would wait forever; we must not.
    await expect(prompter.ask('B: ')).rejects.toBeInstanceOf(InputClosedError);
  });

  it('rejects when input ended before the first question', async () => {
    const { input, prompter } = io();
    input.end();
    await expect(prompter.ask('A: ')).rejects.toBeInstanceOf(InputClosedError);
  });

  it('releases the readline interface when no question is pending, so the process can exit', async () => {
    const { input, prompter } = io();
    const q = prompter.ask('A: ');
    expect(input.listenerCount('data')).toBeGreaterThan(0);
    input.write('x\n');
    await q;
    await tick();
    await tick();
    // readline detached its data listener; only our own `end` hook remains.
    expect(input.listenerCount('data')).toBe(0);
    expect(input.listenerCount('keypress')).toBe(0);
    // Reuse after release still works.
    const q2 = prompter.ask('B: ');
    input.write('y\n');
    expect(await q2).toBe('y');
    prompter.close();
  });

  it('refuses overlapping questions instead of silently queueing them', async () => {
    const { input, prompter } = io();
    const q = prompter.ask('A: ');
    await expect(prompter.ask('B: ')).rejects.toThrow(/still waiting/);
    input.write('a\n');
    expect(await q).toBe('a');
    prompter.close();
  });
});
