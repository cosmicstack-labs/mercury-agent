process.env.CI = '0';
import { describe, expect, it } from 'vitest';
import React from 'react';
import { EventEmitter } from 'node:events';
import { VtScreen } from './vt-screen.js';

class FakeStdout extends EventEmitter { isTTY = true; constructor(public screen: VtScreen) { super(); } get columns() { return this.screen.columns; } get rows() { return this.screen.rows; } write(c: string) { this.screen.write(c); return true; } }
class FakeStdin extends EventEmitter { isTTY = true; private q: string[] = []; setEncoding() {} setRawMode() {} resume() {} pause() {} ref() {} unref() {} read() { return this.q.shift() ?? null; } push(c: string) { this.q.push(c); this.emit('readable'); } }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The attach TUI is the default launch (ADR-024). Its live reply used to be
 * drawn with a cyan "│" bar that vanished when the reply settled, and its
 * "working…" glyph never animated.
 */
describe('attach TUI live rendering', () => {
  it('streams a reply without a side bar, under a MERCURY header, with an animating spinner', async () => {
    const { render } = await import('ink');
    const { AttachTui } = await import('./attach-tui.js');
    let emit: ((e: { type: string; data: Record<string, unknown> }) => void) | null = null;
    const streamedIds: string[] = [];
    const client = {
      getBaseUrl: () => 'http://127.0.0.1:6174',
      listThreads: async () => [],
      listSkills: async () => [],
      listBots: async () => [],
      currentModel: async () => ({ name: 'anthropic', model: 'x' }),
      budget: async () => null,
      permissionMode: async () => 'ask-me',
      setPermissionMode: async () => true,
      createThread: async () => ({ id: 't1', shortId: 't1', alias: 'new', title: 'New' }),
      streamEvents: async (id: string, onEvent: (e: { type: string; data: Record<string, unknown> }) => void) => { streamedIds.push(id); emit = onEvent; await new Promise(() => {}); },
      send: async () => ({ ok: true }),
      resolvePermission: async () => true,
    } as never;
    const screen = new VtScreen(100, 30); const stdin = new FakeStdin();
    const app = render(<AttachTui client={client} pid={1} version="1.3.8" onExit={() => {}} />, { stdout: new FakeStdout(screen) as never, stdin: stdin as never, exitOnCtrlC: false, patchConsole: false } as never);
    await sleep(300);
    stdin.push('\r'); // "new session" is the only pick row
    await sleep(300);
    expect(emit).not.toBeNull();
    // A new session asks for its permission mode, the current one first so
    // Enter keeps it; no "—:" header rows anywhere.
    const entry = screen.text().join('\n');
    expect(entry).toContain('Permission mode for this session? (now: Ask Me — Enter keeps it)');
    expect(entry.indexOf('Ask Me: confirm')).toBeLessThan(entry.indexOf('Allow All: just do it'));
    expect(entry).not.toContain('—:');
    stdin.push('\r'); // keep Ask Me
    await sleep(200);
    expect(screen.text().join('\n')).not.toContain('Permission mode for this session?');
    emit!({ type: 'thinking', data: {} });
    await sleep(150);
    const a = screen.text().join('\n');
    // The live phase is said once, on the status row under the input; the
    // old "working…" line above the input is gone.
    expect(a).not.toContain('working…');
    expect(a).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Thinking · \d+s/);
    const glyphA = a.match(/([⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]) Thinking/)?.[1];
    await sleep(350);
    const glyphB = screen.text().join('\n').match(/([⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]) Thinking/)?.[1];
    expect(glyphA).toBeDefined();
    expect(glyphB).not.toBe(glyphA);
    emit!({ type: 'text_delta', data: { text: 'Here is the reply, still streaming.' } });
    await sleep(200);
    const b = screen.text().join('\n');
    expect(b).toContain('MERCURY:');
    expect(b).toContain('Here is the reply, still streaming.');
    expect(b).not.toContain('│ Here');
    // /new re-bound this screen: it follows the new session (status row shows
    // the new alias, the event stream re-subscribes to the new id) and the
    // spinner stops instead of waiting forever on the old session.
    emit!({ type: 'session_switched', data: { id: 't2', shortId: 't2', alias: 'obsidian-cedar', title: 'New session' } });
    await sleep(300);
    const c = screen.text().join('\n');
    expect(c).toContain('obsidian-cedar');
    expect(c).not.toMatch(/Thinking · \d+s/);
    expect(streamedIds).toEqual(['t1', 't2']);
    app.unmount();
  }, 20000);
});
