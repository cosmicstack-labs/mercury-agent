/**
 * Regression: the transient "Processing" block (ThinkingIndicator) must never
 * survive into the transcript. Reported on the first message of a session:
 * after the reply arrived, "⠦ Processing · 0s / Starting task" stayed frozen
 * between the user's message and Mercury's reply.
 *
 * The test replays every byte the TUI writes through a small VT screen
 * (vt-screen.ts) and checks the final screen + scrollback.
 */
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.CI = '0';
});

import React from 'react';
import { render } from 'ink';
import { EventEmitter } from 'node:events';
import { TuiApp } from './App.js';
import { CLIChannel, type TuiState } from '../channels/cli.js';
import { VtScreen } from './vt-screen.js';

class FakeStdout extends EventEmitter {
  chunks: string[] = [];
  isTTY = true;
  constructor(public screen: VtScreen) { super(); }
  get columns(): number { return this.screen.columns; }
  get rows(): number { return this.screen.rows; }
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    this.screen.write(chunk);
    return true;
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

/** Ink render options over the fake terminal. */
const io = (stdout: unknown) => ({
  stdout: stdout as NodeJS.WriteStream,
  stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
  exitOnCtrlC: false,
  patchConsole: false,
});

/** Test-only access to CLIChannel's private state update. */
const updateChannel = (channel: CLIChannel, patch: Record<string, unknown>) =>
  (channel as unknown as { update(p: Record<string, unknown>): void }).update(patch);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fixture messages are plain objects; the TUI only reads the fields they set. */
type StatePatch = Record<string, unknown>;

function mount(initial: TuiState, cols = 100, rows = 40) {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  const channel = {
    getTuiStateSnapshot: () => snapshot,
    subscribeToTuiState: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
  };
  const screen = new VtScreen(cols, rows);
  const stdout = new FakeStdout(screen);
  const app = render(
    <TuiApp channel={channel} onInput={() => {}} onPermissionResolve={() => {}} onExit={() => {}} />,
    io(stdout),
  );
  const setState = (patch: StatePatch) => {
    snapshot = { ...snapshot, ...patch } as unknown as TuiState;
    for (const l of listeners) l();
  };
  return { screen, stdout, setState, unmount: app.unmount };
}

const base = (patch: Record<string, unknown> = {}): TuiState => ({
  ...new CLIChannel().getTuiStateSnapshot(),
  mode: 'chat',
  version: '1.3.1',
  agentName: 'Mercury',
  provider: { name: 'anthropic', model: 'claude-opus-5-5' },
  ...patch,
} as unknown as TuiState);

const userMsg = { id: 'u1', role: 'user', content: 'so sup', timestamp: Date.now() };
const agentMsg = {
  id: 'a1', role: 'agent', timestamp: Date.now(),
  content: 'Hey Salman. Not much — just standing by.\n\nWhat\'s on your mind tonight?',
};

describe('live region residue', () => {
  it.each([[100, 40], [100, 12]])('Processing block disappears when the reply lands (%i×%i)', async (cols, rows) => {
    const { screen, setState, unmount } = mount(base(), cols, rows);
    await sleep(80);
    setState({ chatMessages: [userMsg], isThinking: true, liveActivity: { phase: 'Starting task', stepsDone: 0, startedAt: Date.now() } });
    await sleep(250); // a few spinner ticks
    expect(screen.text().join('\n')).toContain('Processing');
    // The reply lands and the turn ends in one state update, as in the agent.
    setState({ chatMessages: [userMsg, agentMsg], isThinking: false, liveActivity: null });
    await sleep(250);
    const text = screen.text().join('\n');
    unmount();
    if (process.env.DUMP_SCREEN) process.stderr.write(`\n----- ${cols}x${rows} -----\n` + screen.text().map((l) => '|' + l).join('\n') + '\n');
    expect(text).toContain('Hey Salman');
    expect(text).not.toContain('Processing');
    expect(text).not.toContain('Starting task');
  });

  it('Processing block disappears when the turn ends before the reply is added', async () => {
    const { screen, setState, unmount } = mount(base());
    await sleep(80);
    setState({ chatMessages: [userMsg], isThinking: true, liveActivity: { phase: 'Starting task', stepsDone: 0, startedAt: Date.now() } });
    await sleep(250);
    setState({ isThinking: false, liveActivity: null });
    await sleep(60);
    setState({ chatMessages: [userMsg, agentMsg] });
    await sleep(250);
    const text = screen.text().join('\n');
    unmount();
    expect(text).toContain('Hey Salman');
    expect(text).not.toContain('Processing');
  });
});

describe('live region residue — streamed reply', () => {
  const longReply = Array.from({ length: 14 }, (_, i) => `Line ${i + 1} of a streamed reply that is long enough to matter.`).join('\n');
  it.each([[100, 40], [100, 24], [100, 16], [60, 24]])('Processing never survives a streamed reply (%i×%i)', async (cols, rows) => {
    const { screen, setState, unmount } = mount(base(), cols, rows);
    await sleep(80);
    const live = { phase: 'Starting task', stepsDone: 0, startedAt: Date.now() };
    setState({ chatMessages: [userMsg], isThinking: true, liveActivity: live });
    await sleep(200);
    // Stream the reply in chunks while the turn is still thinking.
    for (let n = 1; n <= 6; n++) {
      const partial = longReply.split('\n').slice(0, n * 2).join('\n');
      setState({ chatMessages: [userMsg, { id: 'a1', role: 'agent', content: partial, timestamp: Date.now(), streaming: true }], isThinking: true, liveActivity: { ...live, phase: 'Composing response' } });
      await sleep(90);
    }
    setState({ chatMessages: [userMsg, { id: 'a1', role: 'agent', content: longReply, timestamp: Date.now() }], isThinking: false, liveActivity: null });
    await sleep(300);
    const text = screen.text().join('\n');
    unmount();
    if (process.env.DUMP_SCREEN) process.stderr.write(`\n----- streamed ${cols}x${rows} -----\n` + screen.text().map((l) => '|' + l).join('\n') + '\n');
    expect(text).toContain('Line 14 of a streamed reply');
    expect(text).not.toContain('Processing');
    expect(text).not.toContain('Starting task');
    expect(text).not.toContain('Composing response');
  });
});

describe('live region residue — real CLIChannel turn', () => {
  async function* chunks(text: string) {
    for (const piece of text.match(/.{1,12}/gs) ?? []) {
      await sleep(15);
      yield piece;
    }
  }
  it.each([
    ['from splash, first message', true, 100, 40],
    ['from chat', false, 100, 40],
    ['from splash, short terminal', true, 100, 18],
  ] as const)('%s: Processing does not survive', async (_label, fromSplash, cols, rows) => {
    const channel = new CLIChannel();
    channel.initSplash('Mercury', '1.3.1');
    updateChannel(channel, { provider: { name: 'anthropic', model: 'claude-opus-5-5' } });
    if (!fromSplash) updateChannel(channel, { mode: 'chat' });
    const screen = new VtScreen(cols, rows);
    const stdout = new FakeStdout(screen);
    const app = render(
      <TuiApp channel={channel} onInput={() => {}} onPermissionResolve={() => {}} onExit={() => {}} />,
      io(stdout),
    );
    await sleep(500); // launch pad draw-in
    if (fromSplash) updateChannel(channel, { mode: 'chat' });
    await sleep(50);
    channel.sendUserMessage('so sup');
    channel.setLiveActivity('Starting task');
    await sleep(300);
    await channel.stream(chunks('Hey Salman. Not much — just standing by.\n\nBots are quiet on the surface.\n\nWhat\'s on your mind tonight?'));
    channel.clearHeartbeat();
    await sleep(300);
    app.unmount();
    const text = screen.text();
    if (process.env.DUMP_SCREEN) process.stderr.write(`\n----- real ${_label} ${cols}x${rows} -----\n` + text.map((l) => '|' + l).join('\n') + '\n');
    expect(text.join('\n')).toContain('on your mind tonight');
    expect(text.join('\n')).not.toContain('Processing');
    expect(text.join('\n')).not.toContain('Starting task');
  });
});

import { ResilientTuiOutput } from './resilient-output.js';

describe('live region residue — terminal backpressure', () => {
  /** A TTY whose buffer reports "full" for a window of writes, like a busy macOS tty. */
  class BackpressureStdout extends FakeStdout {
    needDrainFor = 0;
    get writableNeedDrain(): boolean { return this.needDrainFor > 0; }
    write(chunk: string): boolean {
      super.write(chunk);
      if (this.needDrainFor > 0) this.needDrainFor -= 1;
      return true;
    }
  }

  it('a full terminal buffer during the first reply leaves no Processing block behind', async () => {
    let snapshot = base();
    const listeners = new Set<() => void>();
    const channel = { getTuiStateSnapshot: () => snapshot, subscribeToTuiState: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; } };
    const setState = (patch: StatePatch) => { snapshot = { ...snapshot, ...patch } as unknown as TuiState; for (const l of listeners) l(); };
    const screen = new VtScreen(100, 40);
    const tty = new BackpressureStdout(screen);
    const out = new ResilientTuiOutput(tty as unknown as NodeJS.WriteStream, new FakeStdout(new VtScreen(100, 40)) as unknown as NodeJS.WriteStream);
    const app = render(
      <TuiApp channel={channel} onInput={() => {}} onPermissionResolve={() => {}} onExit={() => {}} />,
      io(out),
    );
    await sleep(80);
    setState({ chatMessages: [userMsg], isThinking: true, liveActivity: { phase: 'Starting task', stepsDone: 0, startedAt: Date.now() } });
    await sleep(120);
    // The buffer is momentarily full while the reply lands.
    tty.needDrainFor = 2;
    setState({ chatMessages: [userMsg, agentMsg], isThinking: false, liveActivity: null });
    await sleep(250);
    setState({ chatMessages: [userMsg, agentMsg, { id: 'u2', role: 'user', content: 'next', timestamp: Date.now() }] });
    await sleep(250);
    app.unmount();
    out.dispose();
    const text = screen.text().join('\n');
    if (process.env.DUMP_SCREEN) process.stderr.write('\n----- backpressure -----\n' + screen.text().map((l) => '|' + l).join('\n') + '\n');
    expect(text).toContain('Hey Salman');
    expect(text).not.toContain('Processing');
    expect(text).not.toContain('Starting task');
  });
});
