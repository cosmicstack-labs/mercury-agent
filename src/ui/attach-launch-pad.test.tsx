// Ink prints only the final frame when it believes it runs in CI (is-in-ci
// reads CI at import). Opt out before ink loads, like live-region-residue.
process.env.CI = '0';

import { describe, expect, it } from 'vitest';
import React from 'react';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { VtScreen } from './vt-screen.js';

class FakeStdout extends EventEmitter { isTTY = true; constructor(public screen: VtScreen) { super(); } get columns() { return this.screen.columns; } get rows() { return this.screen.rows; } write(c: string) { this.screen.write(c); return true; } }
class FakeStdin extends EventEmitter { isTTY = true; setEncoding() {} setRawMode() {} resume() {} pause() {} ref() {} unref() {} read() { return null; } }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const fakeClient = {
  getBaseUrl: () => 'http://127.0.0.1:6174',
  listThreads: async () => [],
  listSkills: async () => [{ name: 'deploy', description: 'ship it' }],
  listBots: async () => [],
  currentModel: async () => ({ name: 'anthropic', model: 'claude-opus-5-5' }),
  budget: async () => ({ used: 1200, budget: 1_000_000 }),
} as never;

describe('attach TUI opens with the launch pad', () => {
  it('shows the wordmark and the real status rows before the session picker', async () => {
    const { render } = await import('ink');
    const { AttachTui } = await import('./attach-tui.js');
    const screen = new VtScreen(100, 36);
    const app = render(<AttachTui client={fakeClient} pid={4242} version="1.3.3" onExit={() => {}} />, { stdout: new FakeStdout(screen) as never, stdin: new FakeStdin() as never, exitOnCtrlC: false, patchConsole: false } as never);
    await sleep(400);
    const text = screen.text().join('\n');
    app.unmount();
    expect(text).toContain('Provider');
    expect(text).toContain('anthropic · claude-opus-5-5');
    expect(text).toContain('1 ready');
    expect(text).toContain('127.0.0.1:6174');
    expect(text).toContain('v1.3.3');
    expect(text).toContain('Attached to the running Mercury');
  });

  it('a slash command typed while /stop is unwinding waits for idle instead of "busy"', () => {
    const agent = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'core', 'agent.ts'), 'utf8').replace(/\r\n/g, '\n');
    // Per-session: the wait is scoped to the command's own session key, so one
    // chat's /stop never parks another chat's message.
    expect(agent).toContain('stopTurn?.processing && stopTurn?.abortReason && !msg.metadata?.waitedForStop');
    expect(agent).toContain('waitUntilIdle(5000, stopKey)');
    expect(agent).toContain('private waitUntilIdle(maxMs: number, sessionKey?: string): Promise<void>');
  });
});
