import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.CI = '0';
});

import React from 'react';
import { render } from 'ink';
import { EventEmitter } from 'node:events';
import stringWidth from 'string-width';
import { TuiApp, MercuryCodeView } from './App.js';
import { CLIChannel, type TuiState } from '../channels/cli.js';
import { hintColumns, isNarrow, ruleWidth, sidePanelWidth, fitTail } from './layout.js';

/**
 * Narrow terminals (ROADMAP §3B / P2.8 — Termux portrait, split panes).
 * At 50 columns nothing may wrap into a second live-region row: every chrome
 * row (rules, input header, hint row, status bar) is fitted to `cols`, the
 * splash collapses to one column and the coding sidebar disappears.
 */

const COLS = 50;
const ESC = String.fromCharCode(27);
const stripAnsi = (s: string) => s.replace(new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, 'g'), '');

class FakeStdout extends EventEmitter {
  chunks: string[] = [];
  columns = COLS;
  rows = 40;
  isTTY = true;
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
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  read(): null { return null; }
}

async function waitFor(pred: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !pred()) await new Promise((r) => setTimeout(r, 20));
  if (!pred()) throw new Error('condition not met in time');
}

/** Visible rows of the last chunk that contains `marker` (a full frame). */
function frameRows(stdout: FakeStdout, marker: string): string[] {
  const chunk = [...stdout.chunks].reverse().find((c) => stripAnsi(c).includes(marker))!;
  return stripAnsi(chunk).split('\n').map((r) => r.replace(/\s+$/, '')).filter((r, i, all) => i < all.length - 1 || r !== '');
}

async function renderApp(state: TuiState, marker: string): Promise<{ rows: string[]; unmount: () => void }> {
  const channel = { getTuiStateSnapshot: () => state, subscribeToTuiState: () => () => {} };
  const stdout = new FakeStdout();
  const { unmount } = render(
    <TuiApp channel={channel} onInput={() => {}} onPermissionResolve={() => {}} onExit={() => {}} />,
    { stdout: stdout as any, stdin: new FakeStdin() as any, exitOnCtrlC: false, patchConsole: false },
  );
  await waitFor(() => stripAnsi(stdout.output).includes(marker));
  await new Promise((r) => setTimeout(r, 60));
  return { rows: frameRows(stdout, marker), unmount };
}

const LONG_CONTEXT = '/home/user/projects/very/deeply/nested/workspace/mercury-agent';

function state(patch: Record<string, unknown>): TuiState {
  return {
    ...new CLIChannel().getTuiStateSnapshot(),
    version: '1.3.1',
    provider: { name: 'deepseek', model: 'deepseek-chat' },
    tokenInfo: { used: 1200, budget: 100000, percentage: 1 },
    projectContext: LONG_CONTEXT,
    ...patch,
  } as unknown as TuiState;
}

function expectFits(rows: string[]): void {
  for (const row of rows) expect(stringWidth(row), `row wider than ${COLS}: "${row}"`).toBeLessThanOrEqual(COLS);
}

describe('layout rules', () => {
  it('derive every width from cols', () => {
    expect(isNarrow(59)).toBe(true);
    expect(isNarrow(60)).toBe(false);
    expect(ruleWidth(50, 60, 0)).toBe(50);
    expect(ruleWidth(200, 50)).toBe(50);
    expect(ruleWidth(1, 50)).toBe(1);
    expect(sidePanelWidth(50, 26)).toBe(0);
    expect(sidePanelWidth(80, 26)).toBe(26);
    expect(fitTail(LONG_CONTEXT, 12)).toBe('...ury-agent');
    expect(fitTail(LONG_CONTEXT, 12)).toHaveLength(12);
    expect(hintColumns(120, 13, 40, 7)).toEqual({ desc: true, key: true });
    expect(hintColumns(50, 13, 40, 7)).toEqual({ desc: false, key: true });
    expect(hintColumns(16, 13, 40, 7)).toEqual({ desc: false, key: false });
  });
});

describe(`TUI at ${COLS} columns`, () => {
  it('splash collapses to one column with no logo art', async () => {
    const { rows, unmount } = await renderApp(state({ mode: 'splash' }), 'Core');
    expectFits(rows);
    expect(rows.join('\n')).not.toContain('╭─╮'); // the 26-col mark is gone
    expect(rows[0]).toContain('MERCURY');
    expect(rows.some((r) => r.includes('Provider: deepseek · deepseek-chat'))).toBe(true);
    // snapshot-ish: the whole collapsed splash, row by row
    expect(rows.map((r) => r.trimStart())).toEqual([
      '☿ MERCURY',
      'Your soul-driven AI agent',
      '─'.repeat(48),
      '● Core booting',
      '● Provider ready',
      '● Skills 0/0',
      '─'.repeat(48),
      'Version: 1.3.1',
      'Provider: deepseek · deepseek-chat',
      '─'.repeat(48),
      'Initializing Mercury...',
    ]);
    unmount();
  });

  it('chat: input chrome is exactly four rows and the sidebar collapses', async () => {
    const { rows, unmount } = await renderApp(state({
      mode: 'chat',
      sidebarSections: [{ title: 'Files', items: [{ icon: '•', label: 'src/index.ts' }] }],
    }), '[CHAT]');
    expectFits(rows);
    expect(rows.join('\n')).not.toContain('src/index.ts'); // sidebar collapsed
    const header = rows.findIndex((r) => r.includes('[CHAT]'));
    expect(header).toBeGreaterThan(0);
    // rule · header · prompt · hint — no wrapped continuation rows between.
    expect(rows[header - 1]).toBe('─'.repeat(COLS));
    expect(rows[header]).toBe(' [CHAT] ...ed/workspace/mercury-agent mode=OFF');
    expect(rows[header + 1]).toBe(' >');
    expect(rows[header + 2]).toBe(' Enter send · /help keys');
    expect(rows[header + 3]).toMatch(/^ ─+$/); // token bar rule follows directly
    unmount();
  });

  it('coding: no fixed 26-column sidebar, shortcuts row fits', async () => {
    const { rows, unmount } = await renderApp(state({
      mode: 'coding',
      subAgents: [{ id: 'a1', status: 'running', task: 'Investigate the flaky test in the scheduler module', startedAt: Date.now() }],
    }), '[CODING]');
    expectFits(rows);
    expect(rows.join('\n')).not.toContain('Workspace'); // sidebar collapsed
    expect(rows.some((r) => r.trim() === 'Ctrl+P Plan · Ctrl+X Execute')).toBe(true);
    const header = rows.findIndex((r) => r.includes('[CODING]'));
    expect(rows[header + 1]).toBe(' >');
    expect(rows[header + 2]).toBe(' Ctrl+P Plan · Ctrl+X Exec');
    unmount();
  });

  it('Mercury Code: hint table drops the description column instead of wrapping', async () => {
    const stdout = new FakeStdout();
    const s = state({
      mode: 'mercury-code',
      chatMessages: [],
      mercuryCode: { cwd: '/tmp/proj', dirName: 'proj', git: { branch: 'main', ahead: 0, behind: 0, dirty: 0 }, scrollOffset: 0, exitConfirm: false },
    });
    const { unmount } = render(<MercuryCodeView state={s} cols={COLS} rows={40} input="" cursorPos={0} />, { stdout: stdout as any, exitOnCtrlC: false, patchConsole: false });
    await waitFor(() => stripAnsi(stdout.output).includes('/code plan'));
    await new Promise((r) => setTimeout(r, 60));
    const rows = frameRows(stdout, '/code plan');
    expectFits(rows);
    const plan = rows.find((r) => r.includes('/code plan'))!;
    expect(plan).not.toContain('analyze & propose');
    expect(plan).toMatch(/\/code plan\s+ctrl\+p$/);
    // input box spans the terminal minus the 2+2 gutter
    expect(rows.some((r) => r.trim().startsWith('╭') && stringWidth(r.trim()) === COLS - 4)).toBe(true);
    unmount();
  });
});
