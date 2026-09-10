import { describe, expect, it } from 'vitest';
import React from 'react';
import { render } from 'ink';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { TuiApp } from './App.js';
import type { TuiState } from '../channels/cli.js';

/**
 * Full-TUI reproduction: one ↑/↓ keypress on a 4-option prompt in Mercury
 * Code goes through TuiApp's useInput → setPermIdx → full re-render.
 * Whatever Ink writes between frames must be bounded to the live region
 * (prompt + input + status) — the finalized transcript must never be
 * rewritten (that was the full-UI flicker the user reported).
 */

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

// Ink consumes stdin through the stream pull API ('readable' + read()), so
// the fake must be a real stream.
class FakeStdin extends PassThrough {
  isRaw = true;
  setRawMode(): void {}
  ref(): void {}
  unref(): void {}
  isTTY = true;
}

function makeState(): TuiState {
  return {
    mode: 'mercury-code',
    version: '1.2.3',
    chatMessages: [
      { id: 'u1', role: 'user', content: 'fix the login bug', timestamp: 1 },
      { id: 'm1', role: 'agent', content: 'Done. Here is what changed:\n\n```ts\nconst x = 1;\n```\n\nMore prose follows.', timestamp: 2 },
    ],
    toolSteps: [],
    subAgents: [],
    backgroundTasks: [],
    skills: [],
    sidebarSections: [],
    isThinking: false,
    programmingMode: 'auto',
    mercuryCode: {
      cwd: '/tmp',
      dirName: 'proj',
      git: { branch: 'main', ahead: 0, behind: 0, dirty: 0 },
      mouse: false,
      scrollOffset: 0,
      exitConfirm: false,
    },
    permissionPrompt: {
      type: 'choice',
      message: 'How should I proceed?',
      options: [
        { value: 'a', label: 'Option A' },
        { value: 'b', label: 'Option B' },
        { value: 'c', label: 'Option C' },
        { value: 'd', label: 'Option D' },
      ],
    },
    agentName: 'Mercury',
  } as unknown as TuiState;
}

const noop = (): void => {};

describe('full-TUI prompt navigation repaint cost', () => {
  it('one ↓ keypress rewrites only the prompt rows, not the transcript', async () => {
    const stdout = new FakeStdout() as any;
    const stdin = new FakeStdin() as any;

    const channel = (() => {
      // Cached snapshot — the real channel returns the same immutable object
      // between updates; an uncached getter makes React loop forever.
      const state = makeState();
      return {
        getTuiStateSnapshot: () => state,
        subscribeToTuiState: () => () => {},
      };
    })();

    const instance = render(
      React.createElement(TuiApp, {
        channel,
        onInput: noop,
        onPermissionResolve: noop,
        onExit: noop,
      }),
      { stdout, stdin, exitOnCtrlC: false },
    );
    await new Promise((r) => setTimeout(r, 80));
    stdout.chunks.length = 0;

    // One ↓ keypress: the arrow sequence a terminal sends in raw mode, fed
    // through the stream the way a TTY would.
    stdin.write('\x1b[B');
    await new Promise((r) => setTimeout(r, 80));

    const after = stdout.output;
    // Finalized transcript (Static / scrollback) must not be rewritten.
    expect(after).not.toContain('fix the login bug');
    expect(after).not.toContain('Here is what changed');
    // The selection marker moved within the prompt.
    expect(after).toContain('Option');
    // The repaint is diffed: only the rows from the first change down are
    // rewritten (marker + rows below). A full-frame rewrite of this frame is
    // ~1KB+; a single changed marker row stays well under that.
    expect(after.length).toBeLessThan(800);
    instance.unmount();
  });
});