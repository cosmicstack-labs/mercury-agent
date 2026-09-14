import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

// Ink skips ALL frame writes when it detects CI (`is-in-ci` → process.env.CI).
// Setting CI to '0' (the one value is-in-ci treats as false) BEFORE the ink
// module loads restores normal rendering.
vi.hoisted(() => {
  process.env.CI = '0';
});

import React from 'react';
import { render, Box, Text, Static } from 'ink';
import { EventEmitter } from 'node:events';
import { MercuryCodeView } from './App.js';
import type { TuiState } from '../channels/cli.js';

class FakeStdout extends EventEmitter {
  chunks: string[] = [];
  columns = 80;
  rows = 12;
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
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  isTTY = true;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Live-region overflow guard, against the REAL patched ink.
 *
 * Stock ink's fallback for a live frame as tall as (or taller than) the
 * terminal is `clearTerminal + fullStaticOutput + output` — it erases the
 * ENTIRE scrollback buffer (`\x1b[3J`) and re-dumps every static byte ever
 * printed, on EVERY frame. In Mercury Code with a long conversation that is
 * megabytes per frame: the scrollbar jumps to the top, the UI flickers, and
 * native scrolling becomes impossible. The patched ink must instead trim the
 * live frame to what fits (bottom-anchored, so the input + status bar
 * survive) and write it through the normal diff path — scrollback is never
 * cleared and the transcript is never re-dumped.
 */
// The overflow-guard tests assert PATCHED ink behavior (no clearTerminal /
// scrollback wipe on an oversized live frame). On an unpatched install —
// e.g. a container where the appliers couldn't run — stock ink legitimately
// takes its clearTerminal fallback, so these tests are meaningless there:
// skip instead of failing the platform job red.
const inkPatchApplied = (() => {
  try {
    return createRequire(import.meta.url)('../../scripts/apply-ink-patch.cjs').isPatched();
  } catch {
    return false;
  }
})();
const guard = inkPatchApplied ? describe : describe.skip;

guard('ink live-region overflow guard', () => {
  it('never clears scrollback or re-dumps static output when the live frame exceeds the terminal', async () => {
    const stdout = new FakeStdout() as any;

    const liveRegion = (suffix: string) =>
      React.createElement(
        Box,
        { flexDirection: 'column' },
        Array.from({ length: 40 }, (_, i) =>
          React.createElement(Text, { key: i }, `live row ${i}${suffix}`),
        ),
      );

    // Static transcript first: finalized content that lives in scrollback.
    // (createElement's Static typing expects a children-as-function signature
    // TS can't express generically here — cast through `never`.)
    const staticBlock = React.createElement(
      Static,
      { items: ['static message one', 'static message two'] } as never,
      ((item: string) => React.createElement(Text, { key: item }, item)) as never,
    );

    const { rerender, unmount } = render(
      React.createElement(
        Box,
        { flexDirection: 'column' },
        staticBlock,
        liveRegion(''),
      ),
      { stdout, exitOnCtrlC: false, patchConsole: false },
    );
    await sleep(300);

    const firstFrame = stdout.output;
    expect(firstFrame).toContain('static message one');
    expect(firstFrame).toContain('live row 39');

    // The overflow path must not fire — not even once.
    expect(stdout.output).not.toContain('\x1b[3J');

    // The static transcript must never be re-dumped: a clearTerminal pass
    // would print 'static message one' a second time in the byte stream.
    const dumpCount = firstFrame.split('static message one').length - 1;
    rerender(
      React.createElement(
        Box,
        { flexDirection: 'column' },
        staticBlock,
        liveRegion(' tick'),
      ),
    );
    await sleep(300);
    expect(stdout.output.split('static message one').length - 1).toBe(dumpCount);
    expect(stdout.output).not.toContain('\x1b[3J');

    // The bottom of the live region must stay visible (bottom-anchored trim):
    // the newest rows — what the user is reading — survive the trim.
    const lastChunk = stdout.chunks[stdout.chunks.length - 1];
    expect(lastChunk).toContain('live row 39 tick');

    unmount();
  }, 10_000);

  it('Mercury Code never trips the clearTerminal path at worst-case live chrome (24-row terminal)', async () => {
    // Every live block stacked at once on the smallest common macOS terminal
    // (24 rows): full streaming tail, a running tool, a swarm, a plan
    // checklist, a permission prompt, and a multi-line input. Before the
    // guard, any frame this tall erased scrollback and re-dumped the whole
    // transcript per frame — the long-conversation rerender storm.
    const longContent = Array.from({ length: 200 }, (_, i) => `Line ${i}: streaming content`).join('\n');
    const state = {
      mode: 'mercury-code',
      version: '1.2.5',
      agentName: 'Mercury',
      programmingMode: 'execute',
      projectContext: '/tmp/proj',
      permissionMode: 'allow-all',
      chatMessages: [
        { id: 'u1', role: 'user', content: 'refactor the auth module', timestamp: 1 },
        { id: 'a1', role: 'agent', content: longContent, timestamp: 2, streaming: true },
      ],
      toolSteps: [
        { id: 't1', label: 'Running tests', status: 'running', startedAt: 1, outputPreview: '' },
        { id: 't2', label: 'Edited file', status: 'done', outputPreview: '' },
      ],
      subAgents: Array.from({ length: 4 }, (_, i) => ({
        id: `agent-${i}`, status: 'running', task: `Investigate module ${i}`,
      })),
      planProgress: [
        { label: 'Read auth module', status: 'done' },
        { label: 'Refactor login flow', status: 'active' },
        { label: 'Update tests', status: 'pending' },
        { label: 'Update docs', status: 'pending' },
      ],
      permissionPrompt: {
        type: 'choice' as const, message: 'Proceed?', options: [{ value: 'y', label: 'Yes' }],
        resolve: () => {},
      },
      liveActivity: { phase: 'Implementing', startedAt: 1, stepsDone: 3 },
      backgroundTasks: [],
      skills: [],
      sidebarSections: [],
      mercuryCode: {
        cwd: '/tmp/proj', dirName: 'proj', git: { branch: 'main', ahead: 0, behind: 0, dirty: 2 },
        scrollOffset: 0, exitConfirm: false,
      },
      tuiFrozen: false,
      isThinking: false,
    } as unknown as TuiState;

    const stdout = new FakeStdout() as any;
    stdout.rows = 24;
    const { unmount } = render(
      React.createElement(MercuryCodeView, { state, cols: 100, rows: 24 }),
      { stdout, exitOnCtrlC: false, patchConsole: false },
    );
    await sleep(300);

    expect(stdout.output).not.toContain('\x1b[3J');
    // Bottom-anchored trim keeps the newest rows visible: the status bar and
    // input box (the last rows of the live region) must survive.
    expect(stdout.output).toContain('proj');

    unmount();
  }, 10_000);
});