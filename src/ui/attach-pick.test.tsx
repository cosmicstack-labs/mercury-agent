process.env.CI = '0';
import { describe, expect, it } from 'vitest';
import React from 'react';
import { EventEmitter } from 'node:events';
import { VtScreen } from './vt-screen.js';

class FakeStdout extends EventEmitter { isTTY = true; constructor(public screen: VtScreen) { super(); } get columns() { return this.screen.columns; } get rows() { return this.screen.rows; } write(c: string) { this.screen.write(c); return true; } }
class FakeStdin extends EventEmitter { isTTY = true; private q: string[] = []; setEncoding() {} setRawMode() {} resume() {} pause() {} ref() {} unref() {} read() { return this.q.shift() ?? null; } push(c: string) { this.q.push(c); this.emit('readable'); } }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const threads = Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, shortId: `0000000${i}`, alias: `alias-${i}`, title: `title ${i}` }));

async function renderPick(cols: number, rows: number) {
  const { render } = await import('ink');
  const { AttachTui } = await import('./attach-tui.js');
  const client = {
    getBaseUrl: () => 'http://127.0.0.1:6174',
    listThreads: async () => threads,
    listSkills: async () => [], listBots: async () => [],
    currentModel: async () => ({ name: 'anthropic', model: 'claude-haiku-4-5' }),
    budget: async () => null,
    permissionMode: async () => 'ask-me',
    createThread: async () => ({ id: 'new', shortId: 'new', alias: 'new-one', title: 'New' }),
    streamEvents: async () => { await new Promise(() => {}); },
    send: async () => ({ ok: true }), resolvePermission: async () => true,
  } as never;
  const screen = new VtScreen(cols, rows);
  const app = render(<AttachTui client={client} pid={1} version="1.4.0" onExit={() => {}} />, { stdout: new FakeStdout(screen) as never, stdin: new FakeStdin() as never, exitOnCtrlC: false, patchConsole: false } as never);
  await sleep(400);
  const lines = screen.text();
  app.unmount();
  return lines;
}

/**
 * The session picker is the first thing `mercury` shows. Ink drops rows off
 * the top when the output is taller than the terminal, and what went first
 * was the wordmark. The list is budgeted to the height, and "Start a new
 * session" is the first, default row.
 */
describe('attach TUI session picker', () => {
  // Imported inside the tests, after CI=0 is set: a static import would load
  // Ink first, and Ink in CI mode only draws the final frame (an empty screen).
  it('counts the launch pad rows the way it renders them', async () => {
    const { LAUNCH_WORDMARK, LAUNCH_WORDMARK_WIDTH, launchPadRows } = await import('./launch-pad.js');
    expect(launchPadRows(100, 'a tip')).toBe(1 + LAUNCH_WORDMARK.length + 1 + 1 + 5 + 1 + 1 + 1 + 2);
    expect(launchPadRows(100, null)).toBe(launchPadRows(100, 'a tip') - 2);
    // Below the wordmark's width the header is two plain lines.
    expect(launchPadRows(LAUNCH_WORDMARK_WIDTH + 3, null)).toBe(2 + 1 + 5 + 1 + 1 + 1);
  });

  it('on a short terminal keeps the wordmark and folds the sessions it cannot show into one line', async () => {
    const lines = await renderPick(100, 24);
    const text = lines.join('\n');
    expect(lines.some((l) => l.includes('█'))).toBe(true); // the wordmark survived
    expect(text).toContain('Your soul-driven AI agent');
    expect(text).toContain('› Start a new session'); // first and selected
    expect(text).toMatch(/… \d+ more · \/sessions in the chat/);
    expect(text).toContain('↑↓ select · Enter attach');
    expect(text.indexOf('Start a new session')).toBeLessThan(text.indexOf('alias-0'));
  });

  it('on a tall terminal lists every session, new-session row first', async () => {
    const text = (await renderPick(100, 45)).join('\n');
    for (const t of threads) expect(text).toContain(`${t.alias} [${t.shortId}]`);
    expect(text).not.toContain('more · /sessions');
    expect(text).toContain('› Start a new session');
  });
});
