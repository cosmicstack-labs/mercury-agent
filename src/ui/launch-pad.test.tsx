import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.CI = '0';
});

import React from 'react';
import { render } from 'ink';
import { EventEmitter } from 'node:events';
import stringWidth from 'string-width';
import { TuiApp } from './App.js';
import { CLIChannel, type TuiState } from '../channels/cli.js';
import { launchPadChecks, tildify, isLaunchPadReady, LAUNCH_WORDMARK, LAUNCH_WORDMARK_WIDTH } from './launch-pad.js';
import { renderMercuryCodeParts } from './pixel-logo.js';

const ESC = String.fromCharCode(27);
const stripAnsi = (s: string) => s.replace(new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, 'g'), '');

class FakeStdout extends EventEmitter {
  chunks: string[] = [];
  rows = 40;
  isTTY = true;
  constructor(public columns: number) { super(); }
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
  get output(): string {
    return this.chunks.join('');
  }
}

class FakeStdin extends EventEmitter {
  isTTY = true;
  private queue: string[] = [];
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  read(): string | null { return this.queue.shift() ?? null; }
  type(text: string): void {
    this.queue.push(text);
    this.emit('readable');
  }
}

async function waitFor(pred: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !pred()) await new Promise((r) => setTimeout(r, 20));
  if (!pred()) throw new Error('condition not met in time');
}

// debug mode writes every frame in full (no diff-render), so the last chunk
// that contains the marker is a complete, settled frame.
function lastFrame(stdout: FakeStdout, marker: string): string[] {
  const chunk = [...stdout.chunks].reverse().find((c) => stripAnsi(c).includes(marker))!;
  return stripAnsi(chunk).split('\n').map((r) => r.replace(/\s+$/, '')).filter((r) => r.length > 0 || true);
}

function state(patch: Record<string, unknown> = {}): TuiState {
  return {
    ...new CLIChannel().getTuiStateSnapshot(),
    mode: 'splash',
    version: '1.3.1',
    provider: { name: 'anthropic', model: 'claude-opus-5-5' },
    tokenInfo: { used: 1204, budget: 200000, percentage: 1 },
    skills: [{ name: 'web-search', description: '', loaded: true }, { name: 'daily-digest', description: '', loaded: true }],
    web: { enabled: true, port: 3010 },
    ...patch,
  } as unknown as TuiState;
}

async function renderPad(s: TuiState, cols: number, onInput: (t: string) => void = () => {}) {
  const stdout = new FakeStdout(cols);
  const stdin = new FakeStdin();
  const channel = { getTuiStateSnapshot: () => s, subscribeToTuiState: () => () => {} };
  const { unmount } = render(
    <TuiApp channel={channel} onInput={onInput} onPermissionResolve={() => {}} onExit={() => {}} />,
    { stdout: stdout as any, stdin: stdin as any, exitOnCtrlC: false, patchConsole: false, debug: true },
  );
  // Wait for the full mark draw-in (13 rows × 24 ms) and a settled frame.
  await waitFor(() => stripAnsi(stdout.output).includes('Workspace'));
  await new Promise((r) => setTimeout(r, 450));
  return { stdout, stdin, unmount };
}

describe('launch wordmark', () => {
  it('is single-width block art sharing the Mercury Code header font', () => {
    expect(LAUNCH_WORDMARK).toHaveLength(5);
    for (const row of LAUNCH_WORDMARK) {
      expect(row).toMatch(/^[ █]*$/);
      expect(stringWidth(row)).toBeLessThanOrEqual(LAUNCH_WORDMARK_WIDTH);
    }
    // Same glyphs as the "MERCURY" half of the Mercury Code header.
    expect(LAUNCH_WORDMARK).toEqual(renderMercuryCodeParts().map((p) => p.left.replace(/\s+$/, '')));
  });
});

describe('launch pad checks', () => {
  it('derive only from real state: pending until the provider handshake', () => {
    const pending = launchPadChecks(state({ provider: null }), '/tmp/work');
    expect(pending[0]).toMatchObject({ label: 'Provider', status: 'pending' });
    expect(pending[1]).toMatchObject({ label: 'Skills', status: 'done' });
    expect(launchPadChecks(state({ skills: [] }), '/w')[1]).toMatchObject({ value: 'none installed', status: 'info' });
    expect(isLaunchPadReady(state({ provider: null }))).toBe(false);
    const ready = launchPadChecks(state(), '/tmp/work');
    expect(ready.map((c) => `${c.label}=${c.status}`)).toEqual([
      'Provider=done', 'Skills=done', 'Web=done', 'Budget=info', 'Workspace=info',
    ]);
    expect(launchPadChecks(state({ web: null, tokenInfo: null }), '/w').map((c) => c.label)).toEqual(['Provider', 'Skills', 'Web', 'Workspace']);
  });

  it('abbreviates the home directory', () => {
    expect(tildify('/Users/jane/code/app', '/Users/jane')).toBe('~/code/app');
    expect(tildify('/Users/jane', '/Users/jane')).toBe('~');
    expect(tildify('/Users/janet/x', '/Users/jane')).toBe('/Users/janet/x');
  });
});

describe('launch pad rendering', () => {
  it.each([100, 50, 30])('fits %i columns with no wrapped rows', async (cols) => {
    const { stdout, unmount } = await renderPad(state(), cols);
    const rows = lastFrame(stdout, 'Workspace');
    for (const row of rows) expect(stringWidth(row)).toBeLessThanOrEqual(cols);
    const text = rows.join('\n');
    expect(text).toMatch(/MERCURY|█   █/);
    expect(text).toContain(cols >= 50 ? 'anthropic · claude-opus-5-5' : 'anthropic');
    expect(text).toContain('Type to start chatting');
    // Wordmark when it fits (with padding); a one-line header otherwise.
    if (cols >= LAUNCH_WORDMARK_WIDTH + 4) expect(text).toContain(LAUNCH_WORDMARK[0]);
    else { expect(text).not.toContain('███'); expect(text).toContain('☿ MERCURY'); }
    unmount();
  });

  it('shows a pending provider with a spinner and keeps the same row count', async () => {
    const a = await renderPad(state({ provider: null }), 100);
    const pendingRows = lastFrame(a.stdout, 'Workspace');
    expect(pendingRows.join('\n')).toContain('connecting…');
    expect(pendingRows.join('\n')).toContain('Starting up — you can already type');
    a.unmount();
    const b = await renderPad(state(), 100);
    expect(lastFrame(b.stdout, 'Workspace').length).toBe(pendingRows.length);
    b.unmount();
  });

  it('typing starts chat and keeps the keystroke; Enter starts chat', async () => {
    const inputs: string[] = [];
    const { stdin, stdout, unmount } = await renderPad(state(), 100, (t) => inputs.push(t));
    stdin.type('h');
    await waitFor(() => inputs.includes('/chat'));
    expect(inputs).toEqual(['/chat']);
    unmount();

    const enter: string[] = [];
    const second = await renderPad(state(), 100, (t) => enter.push(t));
    second.stdin.type('\r');
    await waitFor(() => enter.includes('/chat'));
    second.unmount();
    expect(stripAnsi(stdout.output)).toContain('Type to start chatting');
  });
});
