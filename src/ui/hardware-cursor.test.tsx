import { describe, expect, it, vi } from 'vitest';

// Ink skips frame writes when it detects CI (`is-in-ci`); '0' is the one
// value it treats as false. Must run before ink loads.
// FORCE_COLOR: the fake cell's inverse SGR is how these tests locate it.
vi.hoisted(() => {
  process.env.CI = '0';
  process.env.FORCE_COLOR = '1';
});

import React from 'react';
import { render, Box, Text, Static } from 'ink';
import { EventEmitter } from 'node:events';
import stringWidth from 'string-width';
import { CursorCell, hardwareCursorEnabled, configureHardwareCursor } from './cursor-anchor.js';
import { MercuryCodeView, TuiApp } from './App.js';
import { CLIChannel } from '../channels/cli.js';
import type { TuiState } from '../channels/cli.js';

/**
 * Hardware cursor positioning (#41, #66) against the REAL vendored ink:
 * after every frame the terminal cursor must be parked — shown — exactly on
 * the input's fake-cursor cell, so IME preedit/candidate windows anchor
 * there; it must be hidden and moved back below the live region before the
 * next frame is written (the diff-render erase arithmetic depends on it),
 * and stay hidden while no input owns the keyboard.
 */

const SHOW = '\x1b[?25h';
const HIDE = '\x1b[?25l';
const INVERSE = '\x1b[7m';
const ESC = String.fromCharCode(27);
// CUU n, CHA col, DECTCEM show — exactly what log-update's park() writes.
const PARK_RE = new RegExp(`${ESC}\\[(\\d+)A${ESC}\\[(\\d+)G${ESC}\\[\\?25h$`);
const stripAnsi = (s: string) => s.replace(new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, 'g'), '');

class FakeStdout extends EventEmitter {
  chunks: string[] = [];
  columns = 80;
  rows = 30;
  isTTY = true;
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
  get output(): string {
    return this.chunks.join('');
  }
}

async function waitFor(pred: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !pred()) await new Promise((r) => setTimeout(r, 20));
  if (!pred()) throw new Error('condition not met in time');
}

/** Last chunk ending in a park sequence. */
const lastParkChunk = (stdout: FakeStdout) => [...stdout.chunks].reverse().find((c) => PARK_RE.test(c));

/**
 * For a FULL-frame write (first frame, or a repaint after resize), derive
 * where the inverse cell sits from the frame text itself and compare it with
 * the park sequence that followed. Returns both for assertions.
 */
function analyse(chunk: string): { parked: { up: number; col: number }; expected: { up: number; col: number }; rows: string[] } {
  const m = PARK_RE.exec(chunk)!;
  const parked = { up: Number(m[1]), col: Number(m[2]) - 1 };
  const frameEnd = chunk.length - m[0].length;
  // eraseLines(n) ends with a bare CHA (`ESC[G`); the frame text follows it.
  const eraseEnd = chunk.lastIndexOf(`${ESC}[G`, frameEnd);
  const frame = chunk.slice(eraseEnd < 0 ? 0 : eraseEnd + 3, frameEnd);
  const rows = frame.split('\n').slice(0, -1); // trailing '\n' after the last row
  const rowIdx = rows.findIndex((r) => r.includes(INVERSE));
  expect(rowIdx).toBeGreaterThanOrEqual(0);
  const col = stringWidth(stripAnsi(rows[rowIdx].slice(0, rows[rowIdx].indexOf(INVERSE))));
  return { parked, expected: { up: rows.length - rowIdx, col }, rows };
}

function Prompt({ before, glyph, after = '', active = true, lead = 0 }: { before: string; glyph: string; after?: string; active?: boolean; lead?: number }) {
  return (
    <Box flexDirection="column">
      {Array.from({ length: lead }, (_, i) => <Text key={i}>transcript row {i}</Text>)}
      <Text>header</Text>
      <Box paddingX={1} borderStyle="round" flexDirection="column">
        <Box>
          <Text>{'> '}</Text>
          <Text>{before}</Text>
          <CursorCell glyph={glyph} active={active} />
          <Text>{after}</Text>
        </Box>
      </Box>
      <Text>status bar</Text>
    </Box>
  );
}

describe('hardware cursor positioning (vendored ink)', () => {
  it('parks the real cursor exactly on the fake cursor cell, including after wide (CJK) text', async () => {
    const stdout = new FakeStdout();
    const { unmount } = render(<Prompt before="日本語 ok" glyph="x" after="yz" />, { stdout: stdout as any, exitOnCtrlC: false, patchConsole: false });
    await waitFor(() => !!lastParkChunk(stdout));
    const { parked, expected, rows } = analyse(lastParkChunk(stdout)!);
    expect(parked).toEqual(expected);
    // header, border, input row, border, status → input row is 3rd of 5;
    // col = border(1) + padding(1) + "> "(2) + width("日本語 ok")(9) = 13.
    expect(rows).toHaveLength(5);
    expect(expected).toEqual({ up: 3, col: 13 });
    unmount();
  });

  it('unparks (hide + move back below the frame) before every later write', async () => {
    const stdout = new FakeStdout();
    const { rerender, unmount } = render(<Prompt before="ab" glyph=" " />, { stdout: stdout as any, exitOnCtrlC: false, patchConsole: false });
    await waitFor(() => !!lastParkChunk(stdout));
    const first = analyse(lastParkChunk(stdout)!);
    const mark = stdout.chunks.length;
    rerender(<Prompt before="abc" glyph=" " />);
    await waitFor(() => stdout.chunks.slice(mark).some((c) => PARK_RE.test(c)));
    const next = stdout.chunks.slice(mark).find((c) => PARK_RE.test(c))!;
    // Unpark first — the erase arithmetic assumes the cursor sits below the
    // last row at column 0 — then the diff-rendered row, then re-park.
    expect(next.startsWith(`${HIDE}${ESC}[${first.parked.up}B${ESC}[G`)).toBe(true);
    const m = PARK_RE.exec(next)!;
    expect(Number(m[1])).toBe(first.parked.up);
    expect(Number(m[2]) - 1).toBe(first.parked.col + 1); // one more char typed
    unmount();
  });

  it('re-parks without repainting when only the cursor moves', async () => {
    const stdout = new FakeStdout();
    const { rerender, unmount } = render(<Prompt before="abc" glyph="d" after="" />, { stdout: stdout as any, exitOnCtrlC: false, patchConsole: false });
    await waitFor(() => !!lastParkChunk(stdout));
    const mark = stdout.chunks.length;
    // Same text, cursor one cell left: identical bytes except the inverse cell
    // moved, so rows differ; then a pure cursor toggle with identical rows.
    rerender(<Prompt before="abc" glyph="d" after="" active={false} />);
    await waitFor(() => stdout.chunks.slice(mark).some((c) => c.includes(HIDE)));
    const hideChunk = stdout.chunks.slice(mark).find((c) => c.includes(HIDE))!;
    // Rows are byte-identical (the attribute is not rendered): the only write
    // is the unpark — no erase, no frame text, and no show.
    expect(hideChunk).toMatch(new RegExp(`^${ESC}\\[\\?25l${ESC}\\[\\d+B${ESC}\\[G$`));
    expect(stdout.chunks.slice(mark).join('')).not.toContain(SHOW);
    unmount();
  });

  it('keeps the cursor hidden while no input owns the keyboard', async () => {
    const stdout = new FakeStdout();
    const { unmount } = render(<Prompt before="abc" glyph=" " active={false} />, { stdout: stdout as any, exitOnCtrlC: false, patchConsole: false });
    await waitFor(() => stdout.output.includes('status bar'));
    await new Promise((r) => setTimeout(r, 80));
    expect(stdout.output).not.toContain(SHOW);
    unmount();
  });

  it('accounts for rows trimmed by the live-region guard', async () => {
    const stdout = new FakeStdout();
    stdout.rows = 10; // frame is 5 + 20 rows → trimmed to the newest 9
    const { unmount } = render(<Prompt before="hi" glyph=" " lead={20} />, { stdout: stdout as any, exitOnCtrlC: false, patchConsole: false });
    await waitFor(() => !!lastParkChunk(stdout));
    const { parked, expected, rows } = analyse(lastParkChunk(stdout)!);
    expect(rows).toHaveLength(9);
    expect(parked).toEqual(expected);
    unmount();
  });

  it('repaints and re-parks correctly after a resize, and after <Static> output', async () => {
    const stdout = new FakeStdout();
    const items = ['first static line'];
    const tree = (its: string[]) => (
      <>
        <Static items={its}>{(item) => <Text key={item}>{item}</Text>}</Static>
        <Prompt before="résumé" glyph=" " />
      </>
    );
    const { rerender, unmount } = render(tree(items), { stdout: stdout as any, exitOnCtrlC: false, patchConsole: false });
    await waitFor(() => !!lastParkChunk(stdout));

    // New static item: ink clears the live region (unpark first), writes the
    // static line, then the full live frame + park.
    let mark = stdout.chunks.length;
    rerender(tree([...items, 'second static line']));
    await waitFor(() => stdout.chunks.slice(mark).some((c) => PARK_RE.test(c)));
    const afterStatic = stdout.chunks.slice(mark);
    expect(afterStatic.join('')).toContain('second static line');
    const s = analyse(afterStatic.find((c) => PARK_RE.test(c))!);
    expect(s.parked).toEqual(s.expected);

    // Resize: baseline invalidated, whole frame rewritten, cursor re-parked.
    mark = stdout.chunks.length;
    stdout.columns = 40;
    stdout.emit('resize');
    await waitFor(() => stdout.chunks.slice(mark).some((c) => PARK_RE.test(c)));
    const resized = stdout.chunks.slice(mark).find((c) => PARK_RE.test(c))!;
    expect(resized.startsWith(HIDE)).toBe(true);
    const r = analyse(resized);
    expect(r.parked).toEqual(r.expected);
    unmount();
  });

  it('restores the cursor below the frame on unmount', async () => {
    const stdout = new FakeStdout();
    const { unmount } = render(<Prompt before="x" glyph=" " />, { stdout: stdout as any, exitOnCtrlC: false, patchConsole: false });
    await waitFor(() => !!lastParkChunk(stdout));
    const { parked } = analyse(lastParkChunk(stdout)!);
    const mark = stdout.chunks.length;
    unmount();
    expect(stdout.chunks.slice(mark).join('')).toContain(`${HIDE}${ESC}[${parked.up}B${ESC}[G`);
  });

  it('honours MERCURY_HW_CURSOR=0 (global toggle on the vendored ink)', async () => {
    expect(hardwareCursorEnabled({ MERCURY_HW_CURSOR: '0' })).toBe(false);
    expect(hardwareCursorEnabled({})).toBe(true);
    configureHardwareCursor({ MERCURY_HW_CURSOR: 'off' });
    try {
      const stdout = new FakeStdout();
      const { unmount } = render(<Prompt before="x" glyph=" " />, { stdout: stdout as any, exitOnCtrlC: false, patchConsole: false });
      await waitFor(() => stdout.output.includes('status bar'));
      await new Promise((r) => setTimeout(r, 80));
      expect(stdout.output).not.toContain(SHOW);
      unmount();
    } finally {
      configureHardwareCursor({});
    }
  });
});

function mercuryState(overrides: Partial<Record<string, unknown>> = {}): TuiState {
  return {
    mode: 'mercury-code',
    version: '1.3.1',
    agentName: 'Mercury',
    programmingMode: 'auto',
    projectContext: '/tmp/proj',
    permissionMode: 'ask-me',
    chatMessages: [{ id: 'u1', role: 'user', content: 'hello', timestamp: 1 }],
    toolSteps: [],
    subAgents: [],
    planProgress: null,
    permissionPrompt: null,
    liveActivity: null,
    backgroundTasks: [],
    skills: [],
    sidebarSections: [],
    mercuryCode: { cwd: '/tmp/proj', dirName: 'proj', git: { branch: 'main', ahead: 0, behind: 0, dirty: 0 }, scrollOffset: 0, exitConfirm: false },
    tuiFrozen: false,
    isThinking: false,
    ...overrides,
  } as unknown as TuiState;
}

describe('hardware cursor in the Mercury Code view', () => {
  it('parks on the input cell of a real TUI frame, and the anchor never leaks into the terminal', async () => {
    const stdout = new FakeStdout();
    const input = 'fix 漢字 bug';
    const cursorPos = 'fix 漢字'.length; // on the space before "bug"
    const { unmount } = render(
      <MercuryCodeView state={mercuryState()} cols={80} rows={30} input={input} cursorPos={cursorPos} />,
      { stdout: stdout as any, exitOnCtrlC: false, patchConsole: false },
    );
    await waitFor(() => !!lastParkChunk(stdout));
    const { parked, expected, rows } = analyse(lastParkChunk(stdout)!);
    expect(parked).toEqual(expected);
    // The cell sits inside the bordered input box: "│ > fix 漢字" → paddingX 2,
    // border 1, padding 1, "> " 2, "fix " 4, 漢字 4 = col 14.
    expect(expected.col).toBe(14);
    expect(stripAnsi(rows[rows.length - expected.up])).toContain('> fix 漢字 bug');
    expect(stdout.output).not.toContain('internal_cursor');
    expect(stdout.output).not.toContain('true');
    unmount();
  });

  it('hides the cursor while a permission prompt owns the keyboard', async () => {
    const stdout = new FakeStdout();
    const state = mercuryState({
      permissionPrompt: { type: 'choice', message: 'Proceed?', options: [{ value: 'y', label: 'Yes' }], resolve: () => {} },
    });
    const { unmount } = render(
      <MercuryCodeView state={state} cols={80} rows={30} input="abc" cursorPos={3} />,
      { stdout: stdout as any, exitOnCtrlC: false, patchConsole: false },
    );
    await waitFor(() => stdout.output.includes('Proceed?'));
    await new Promise((r) => setTimeout(r, 80));
    expect(stdout.output).not.toContain(SHOW);
    unmount();
  });
});

class FakeStdin extends EventEmitter {
  isTTY = true;
  private queue: string[] = [];
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  read(): string | null {
    return this.queue.shift() ?? null;
  }
  type(text: string): void {
    this.queue.push(text);
    this.emit('readable');
  }
}

function mountTuiApp(state: TuiState) {
  let snapshot = state;
  const listeners = new Set<() => void>();
  const channel = {
    getTuiStateSnapshot: () => snapshot,
    subscribeToTuiState: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
  };
  const stdout = new FakeStdout();
  const stdin = new FakeStdin();
  const app = render(
    <TuiApp channel={channel} onInput={() => {}} onPermissionResolve={() => {}} onExit={() => {}} />,
    { stdout: stdout as any, stdin: stdin as any, exitOnCtrlC: false, patchConsole: false },
  );
  const setState = (patch: Partial<TuiState>) => {
    snapshot = { ...snapshot, ...patch } as TuiState;
    for (const l of listeners) l();
  };
  return { stdout, stdin, setState, unmount: app.unmount };
}

const baseState = (patch: Record<string, unknown>): TuiState => ({ ...new CLIChannel().getTuiStateSnapshot(), ...patch } as TuiState);

describe('hardware cursor in TuiApp', () => {
  it('chat: typed CJK input parks the cursor on the cell after it', async () => {
    const { stdout, stdin, unmount } = mountTuiApp(baseState({ mode: 'chat' }));
    await waitFor(() => stdout.output.includes('[CHAT]'));
    stdin.type('日本');
    await waitFor(() => stdout.output.includes('日本') && !!lastParkChunk(stdout));
    // Force one full repaint so the frame text can be analysed end to end.
    const mark = stdout.chunks.length;
    stdout.emit('resize');
    await waitFor(() => stdout.chunks.slice(mark).some((c) => PARK_RE.test(c)));
    const { parked, expected, rows } = analyse(stdout.chunks.slice(mark).find((c) => PARK_RE.test(c))!);
    expect(parked).toEqual(expected);
    // "> 日本" inside paddingX 1: 1 + 2 + 4 = column 7.
    expect(expected.col).toBe(7);
    expect(stripAnsi(rows[rows.length - expected.up])).toContain('> 日本');
    unmount();
  });

  it('chat: a permission prompt hides the cursor; dismissing it brings it back', async () => {
    const { stdout, setState, unmount } = mountTuiApp(baseState({ mode: 'chat' }));
    await waitFor(() => !!lastParkChunk(stdout));
    const mark = stdout.chunks.length;
    setState({ permissionPrompt: { type: 'choice', message: 'Proceed?', options: [{ value: 'y', label: 'Yes' }], resolve: () => {} } } as any);
    await waitFor(() => stdout.output.includes('Proceed?'));
    await new Promise((r) => setTimeout(r, 80));
    const during = stdout.chunks.slice(mark).join('');
    expect(during.startsWith(HIDE)).toBe(true);
    expect(during).not.toContain(SHOW);
    const mark2 = stdout.chunks.length;
    setState({ permissionPrompt: null } as any);
    await waitFor(() => stdout.chunks.slice(mark2).some((c) => PARK_RE.test(c)));
    unmount();
  });

  it('workspace: hidden while the explorer pane is focused, shown once the user types', async () => {
    const workspace = {
      active: true, rootPath: '/tmp/proj', nodes: [], selectedIndex: 0, selectedPath: null,
      openedFilePath: null, openedFilePreview: [], gitFiles: [], stagedCount: 0, unstagedCount: 0,
      branch: 'main', ahead: 0, behind: 0, lastAction: '', codeScrollOffset: 0, focusArea: 'explorer',
      chatCollapsed: false, chatScrollOffset: 0, rightPanel: 'chat',
    };
    const { stdout, stdin, unmount } = mountTuiApp(baseState({ mode: 'workspace', workspace }));
    await waitFor(() => stdout.output.includes('[IDE CHAT]'));
    await new Promise((r) => setTimeout(r, 80));
    expect(stdout.output).not.toContain(SHOW);
    stdin.type('q');
    await waitFor(() => !!lastParkChunk(stdout));
    unmount();
  });
});
