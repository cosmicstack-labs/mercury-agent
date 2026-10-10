import { describe, expect, it, vi } from 'vitest';

// Ink skips frame writes when it detects CI (`is-in-ci`); '0' is the one
// value it treats as false. Must run before ink loads.
vi.hoisted(() => {
  process.env.CI = '0';
});

import React from 'react';
import { render, Box, Text, Static } from 'ink';
import { EventEmitter } from 'node:events';
import { CursorCell, hardwareCursorEnabled, configureHardwareCursor } from './cursor-anchor.js';
import { MercuryCodeView, TuiApp } from './App.js';
import { CLIChannel } from '../channels/cli.js';
import type { TuiState } from '../channels/cli.js';
import { VtScreen } from './vt-screen.js';

/**
 * Hardware cursor positioning (#41, #66) against the REAL vendored ink:
 * after every frame the terminal cursor must be shown exactly on the input's
 * fake-cursor cell, so IME preedit/candidate windows anchor there, and stay
 * hidden while no input owns the keyboard.
 *
 * Ink 8 owns the cursor plumbing (setCursorPosition); Mercury's patch only
 * resolves the `internal_cursor` cell from the layout. So these tests check
 * the RESULT on an emulated terminal — where the cursor ends up and whether
 * it is visible — not the escape sequences used to get there.
 */

const SHOW = '\x1b[?25h';
// Synchronized output (DEC 2026) brackets every frame on ink 8.
const BSU = '\x1b[?2026h';
const ESU = '\x1b[?2026l';
/** Glyph for the fake cursor cell in the fixtures, so it is easy to find. */
const MARK = '▮';

class FakeStdout extends EventEmitter {
  chunks: string[] = [];
  raw: string[] = [];
  isTTY = true;
  screen: VtScreen;
  constructor(public columns = 80, public rows = 30) {
    super();
    this.screen = new VtScreen(columns, rows);
  }
  write(chunk: string): boolean {
    this.raw.push(chunk);
    this.screen.write(chunk);
    const content = chunk.split(BSU).join('').split(ESU).join('');
    if (content) this.chunks.push(content);
    return true;
  }
  get output(): string {
    return this.chunks.join('');
  }
  resize(columns: number, rows = this.rows): void {
    this.columns = columns;
    this.rows = rows;
    this.screen.columns = columns;
    this.screen.rows = rows;
    this.emit('resize');
  }
}

async function waitFor(pred: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !pred()) await new Promise((r) => setTimeout(r, 20));
  if (!pred()) throw new Error('condition not met in time');
}

/** Last cell on the emulated screen holding `ch`, as { row, col }. */
function cellOf(screen: VtScreen, ch: string): { row: number; col: number } | null {
  for (let row = screen.lines.length - 1; row >= 0; row--) {
    const col = screen.lines[row].lastIndexOf(ch);
    if (col >= 0) return { row, col };
  }
  return null;
}

/** Where the real cursor is, when it is shown. */
const cursorAt = (screen: VtScreen) => (screen.cursorVisible ? { row: screen.row, col: screen.col } : null);

/** True once the shown cursor sits on the cell holding `ch`. */
function cursorOn(stdout: FakeStdout, ch = MARK): boolean {
  const target = cellOf(stdout.screen, ch);
  const at = cursorAt(stdout.screen);
  return !!target && !!at && at.row === target.row && at.col === target.col;
}

function Prompt({ before, glyph = MARK, after = '', active = true, lead = 0 }: { before: string; glyph?: string; after?: string; active?: boolean; lead?: number }) {
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

const opts = (stdout: FakeStdout) => ({ stdout: stdout as never, exitOnCtrlC: false, patchConsole: false });

describe('hardware cursor positioning (vendored ink)', () => {
  it('shows the real cursor exactly on the fake cursor cell, including after wide (CJK) text', async () => {
    const stdout = new FakeStdout();
    const { unmount } = render(<Prompt before="日本語 ok" after="yz" />, opts(stdout));
    await waitFor(() => cursorOn(stdout));
    // col = border(1) + padding(1) + "> "(2) + width("日本語 ok")(9) = 13.
    expect(cursorAt(stdout.screen)?.col).toBe(13);
    expect(stdout.screen.lines[stdout.screen.row].join('')).toContain('> 日本語 ok▮yz');
    unmount();
  });

  it('follows the cell as the user types', async () => {
    const stdout = new FakeStdout();
    const { rerender, unmount } = render(<Prompt before="ab" />, opts(stdout));
    await waitFor(() => cursorOn(stdout));
    const first = cursorAt(stdout.screen)!;
    rerender(<Prompt before="abc" />);
    await waitFor(() => cursorOn(stdout) && cursorAt(stdout.screen)!.col === first.col + 1);
    expect(cursorAt(stdout.screen)!.row).toBe(first.row);
    unmount();
  });

  it('hides the cursor without repainting the frame when only the cursor changes', async () => {
    const stdout = new FakeStdout();
    const { rerender, unmount } = render(<Prompt before="abc" glyph="d" />, opts(stdout));
    await waitFor(() => cursorOn(stdout, 'd'));
    const mark = stdout.chunks.length;
    // Same text: only the anchor attribute changes, which is not rendered.
    rerender(<Prompt before="abc" glyph="d" active={false} />);
    await waitFor(() => !stdout.screen.cursorVisible);
    const after = stdout.chunks.slice(mark).join('');
    expect(after).not.toContain('abc'); // no frame text rewritten
    expect(after).not.toContain(SHOW);
    unmount();
  });

  it('keeps the cursor hidden while no input owns the keyboard', async () => {
    const stdout = new FakeStdout();
    const { unmount } = render(<Prompt before="abc" active={false} />, opts(stdout));
    await waitFor(() => stdout.output.includes('status bar'));
    await new Promise((r) => setTimeout(r, 80));
    expect(stdout.output).not.toContain(SHOW);
    unmount();
  });

  it('accounts for rows trimmed by the live-region guard', async () => {
    const stdout = new FakeStdout(80, 10); // frame is 5 + 20 rows → trimmed to the newest 9
    const { unmount } = render(<Prompt before="hi" lead={20} />, opts(stdout));
    await waitFor(() => cursorOn(stdout));
    // The trimmed rows were never written, so the cursor's row is real.
    expect(stdout.screen.text().some((l) => l.includes('transcript row 0'))).toBe(false);
    unmount();
  });

  it('stays on the cell after <Static> output and after a resize', async () => {
    const stdout = new FakeStdout();
    const tree = (its: string[]) => (
      <>
        <Static items={its}>{(item) => <Text key={item}>{item}</Text>}</Static>
        <Prompt before="résumé" />
      </>
    );
    const { rerender, unmount } = render(tree(['first static line']), opts(stdout));
    await waitFor(() => cursorOn(stdout));

    rerender(tree(['first static line', 'second static line']));
    await waitFor(() => stdout.output.includes('second static line') && cursorOn(stdout));

    stdout.resize(40);
    await new Promise((r) => setTimeout(r, 120));
    await waitFor(() => cursorOn(stdout));
    unmount();
  });

  it('leaves the cursor below the frame on unmount', async () => {
    const stdout = new FakeStdout();
    const { unmount } = render(<Prompt before="x" />, opts(stdout));
    await waitFor(() => cursorOn(stdout));
    unmount();
    const status = stdout.screen.lines.findIndex((l) => l.join('').includes('status bar'));
    expect(status).toBeGreaterThanOrEqual(0);
    expect(stdout.screen.row).toBeGreaterThan(status);
    expect(stdout.screen.col).toBe(0);
  });

  it('honours MERCURY_HW_CURSOR=0 (global toggle on the vendored ink)', async () => {
    expect(hardwareCursorEnabled({ MERCURY_HW_CURSOR: '0' })).toBe(false);
    expect(hardwareCursorEnabled({})).toBe(true);
    configureHardwareCursor({ MERCURY_HW_CURSOR: 'off' });
    try {
      const stdout = new FakeStdout();
      const { unmount } = render(<Prompt before="x" />, opts(stdout));
      await waitFor(() => stdout.output.includes('status bar'));
      await new Promise((r) => setTimeout(r, 80));
      expect(stdout.output).not.toContain(SHOW);
      unmount();
    } finally {
      configureHardwareCursor({});
    }
  });
});

/**
 * Frame bytes written outside any BSU…ESU bracket (should be none while
 * mounted). Cursor show/hide toggles are mode switches, not frame content.
 */
function unbracketed(raw: string[]): string {
  let depth = 0;
  let outside = '';
  let rest = raw.join('');
  while (rest) {
    const open = rest.indexOf(BSU);
    const close = rest.indexOf(ESU);
    const next = [open, close].filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? rest.length;
    if (depth === 0) outside += rest.slice(0, next);
    if (next === rest.length) break;
    depth += next === open ? 1 : -1;
    rest = rest.slice(next + BSU.length);
  }
  return outside.split('\x1b[?25l').join('').split(SHOW).join('');
}

describe('synchronized output (ink 8, DEC 2026)', () => {
  function Transcript({ lines, live }: { lines: string[]; live: string }) {
    return (
      <>
        <Static items={lines}>{(l) => <Text key={l}>{l}</Text>}</Static>
        <Box><Text>{live}</Text></Box>
      </>
    );
  }

  it('brackets every frame write on a TTY, so the terminal paints it atomically', async () => {
    const stdout = new FakeStdout();
    const { rerender, unmount } = render(<Transcript lines={[]} live="tick 0" />, opts(stdout));
    for (let i = 1; i <= 5; i++) {
      rerender(<Transcript lines={[]} live={`tick ${i}`} />);
      await new Promise((r) => setTimeout(r, 40));
    }
    await waitFor(() => stdout.output.includes('tick 5'));
    expect(stdout.raw.join('')).toContain(BSU);
    expect(unbracketed(stdout.raw)).toBe('');
    unmount();
  });

  it('writes a new transcript line and the redrawn live region as ONE update', async () => {
    const stdout = new FakeStdout();
    const { rerender, unmount } = render(<Transcript lines={['first line']} live="working" />, opts(stdout));
    await waitFor(() => stdout.output.includes('working'));
    const mark = stdout.raw.length;
    rerender(<Transcript lines={['first line', 'second line']} live="done" />);
    await waitFor(() => stdout.output.includes('done'));
    const update = stdout.raw.slice(mark).join('');
    const open = update.indexOf(BSU);
    const inside = update.slice(open, update.indexOf(ESU, open));
    expect(open).toBeGreaterThanOrEqual(0);
    expect(inside).toContain('second line');
    expect(inside).toContain('done');
    expect(unbracketed(stdout.raw)).toBe('');
    unmount();
  });

  it('never emits mode 2026 when the output is not a TTY', async () => {
    const stdout = new FakeStdout();
    stdout.isTTY = false;
    const { rerender, unmount } = render(<Transcript lines={['a']} live="x" />, opts(stdout));
    rerender(<Transcript lines={['a', 'b']} live="y" />);
    await new Promise((r) => setTimeout(r, 120));
    unmount();
    expect(stdout.raw.join('')).toContain('b');
    expect(stdout.raw.join('')).not.toContain('2026');
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

/** The shown cursor sits right after `text` on a row that contains `line`. */
function cursorAfter(stdout: FakeStdout, line: string, text: string): boolean {
  const at = cursorAt(stdout.screen);
  if (!at) return false;
  const cells = stdout.screen.lines[at.row] ?? [];
  if (!cells.join('').includes(line)) return false;
  // Column just past `text`: find its last character's cell, then step over it.
  const lastChar = [...text].pop()!;
  const col = cells.lastIndexOf(lastChar, at.col - 1);
  return col >= 0 && at.col === col + (cells[col + 1] === '' ? 2 : 1);
}

describe('hardware cursor in the Mercury Code view', () => {
  it('sits on the input cell of a real TUI frame, and the anchor never leaks into the terminal', async () => {
    const stdout = new FakeStdout();
    const input = 'fix 漢字 bug';
    const cursorPos = 'fix 漢字'.length; // on the space before "bug"
    const { unmount } = render(
      <MercuryCodeView state={mercuryState()} cols={80} rows={30} input={input} cursorPos={cursorPos} />,
      opts(stdout),
    );
    await waitFor(() => cursorAfter(stdout, '> fix 漢字 bug', 'fix 漢字'));
    // "│ > fix 漢字": paddingX 2, border 1, padding 1, "> " 2, "fix " 4, 漢字 4 = col 14.
    expect(cursorAt(stdout.screen)?.col).toBe(14);
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
      opts(stdout),
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
    { stdout: stdout as never, stdin: stdin as never, exitOnCtrlC: false, patchConsole: false },
  );
  const setState = (patch: Record<string, unknown>) => {
    snapshot = { ...snapshot, ...patch } as unknown as TuiState;
    for (const l of listeners) l();
  };
  return { stdout, stdin, setState, unmount: app.unmount };
}

const baseState = (patch: Record<string, unknown>): TuiState => ({ ...new CLIChannel().getTuiStateSnapshot(), ...patch } as TuiState);

describe('hardware cursor in TuiApp', () => {
  it('chat: typed CJK input puts the cursor on the cell after it', async () => {
    const { stdout, stdin, unmount } = mountTuiApp(baseState({ mode: 'chat' }));
    await waitFor(() => stdout.output.includes('[CHAT]'));
    stdin.type('日本');
    await waitFor(() => cursorAfter(stdout, '> 日本', '日本'));
    // "> 日本" inside paddingX 1: 1 + 2 + 4 = column 7.
    expect(cursorAt(stdout.screen)?.col).toBe(7);
    unmount();
  });

  it('chat: a permission prompt hides the cursor; dismissing it brings it back', async () => {
    const { stdout, setState, unmount } = mountTuiApp(baseState({ mode: 'chat' }));
    await waitFor(() => stdout.screen.cursorVisible && stdout.output.includes(SHOW));
    setState({ permissionPrompt: { type: 'choice', message: 'Proceed?', options: [{ value: 'y', label: 'Yes' }], resolve: () => {} } });
    await waitFor(() => stdout.output.includes('Proceed?') && !stdout.screen.cursorVisible);
    await new Promise((r) => setTimeout(r, 80));
    expect(stdout.screen.cursorVisible).toBe(false);
    setState({ permissionPrompt: null });
    await waitFor(() => stdout.screen.cursorVisible);
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
    await waitFor(() => stdout.output.includes(SHOW) && stdout.screen.cursorVisible);
    unmount();
  });
});
