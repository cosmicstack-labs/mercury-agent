import { describe, expect, it, vi } from 'vitest';

// These tests assert on the frames ink writes to a fake stdout. Ink skips
// ALL frame writes when it detects CI (`is-in-ci` → process.env.CI), which
// GitHub Actions sets. Setting CI to '0' (the one value is-in-ci treats as
// false) BEFORE the ink module loads restores normal rendering.
vi.hoisted(() => {
  process.env.CI = '0';
});

import React from 'react';
import { render, Text, Box } from 'ink';
import { EventEmitter } from 'node:events';
import { MercuryCodeView } from './App.js';
import type { TuiState } from '../channels/cli.js';

type FrameGate = { frozen: boolean; armed: boolean; marker: string };

const getGate = (): FrameGate | undefined => (globalThis as any).__mercuryFrameGate;

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
  get bytesSince(): (t: number) => number {
    return (t: number) => this.chunks.length - t;
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
 * Scroll-lock (freeze) frame-level regression guards, against the REAL
 * patched ink. The ink patch's freeze gate must guarantee ZERO stdout bytes
 * while frozen — and crucially must NOT advance log-update's baseline
 * (previousOutput/previousLineCount), so the resume frame diffs against the
 * freeze frame instead of erasing the wrong rows.
 */
describe('ink freeze gate (scroll lock)', () => {
  it('writes zero bytes while frozen and one clean frame on resume', async () => {
    if (!getGate()) {
      throw new Error('ink frame gate missing — the ink patch is not applied');
    }
    const stdout = new FakeStdout() as any;
    const gate = getGate()!;

    const { rerender, unmount } = render(
      React.createElement(Box, null, React.createElement(Text, null, 'frame A')),
      { stdout, exitOnCtrlC: false, patchConsole: false },
    );
    await sleep(120);
    const baseline = stdout.output;
    expect(baseline).toContain('frame A');

    gate.frozen = true;
    gate.armed = false;
    gate.marker = '';

    // Several re-renders while frozen: NOT ONE byte may reach the terminal.
    rerender(React.createElement(Box, null, React.createElement(Text, null, 'frame B')));
    rerender(React.createElement(Box, null, React.createElement(Text, null, 'frame C')));
    await sleep(150);
    expect(stdout.output).toBe(baseline); // zero bytes while frozen

    // Resume: the frame goes out and diffs against the freeze frame.
    gate.frozen = false;
    rerender(React.createElement(Box, null, React.createElement(Text, null, 'frame C')));
    await sleep(120);
    expect(stdout.output).toContain('frame C');
    unmount();
  }, 10_000);

  it('the armed window lets exactly the marker frame through', async () => {
    if (!getGate()) {
      throw new Error('ink frame gate missing — the ink patch is not applied');
    }
    const stdout = new FakeStdout() as any;
    const gate = getGate()!;
    gate.frozen = true;
    gate.armed = true;
    gate.marker = '⏸ frozen';

    const { rerender, unmount } = render(
      React.createElement(Box, null, React.createElement(Text, null, 'base')),
      { stdout, exitOnCtrlC: false, patchConsole: false },
    );
    await sleep(80);
    // Once the marker frame arrives, armed clears; later plain frames drop.
    rerender(React.createElement(Box, null, React.createElement(Text, null, 'base with ⏸ frozen hint')));
    await sleep(150);
    expect(stdout.output).toContain('⏸ frozen');
    const writesAfterHint = stdout.output.length;
    rerender(React.createElement(Box, null, React.createElement(Text, null, 'suppressed')));
    await sleep(100);
    expect(stdout.output.length).toBe(writesAfterHint); // armed window consumed

    gate.frozen = false;
    gate.armed = false;
    gate.marker = '';
    unmount();
  }, 10_000);
});

/**
 * Part A: full streaming preview + height-stable live region. The tail block
 * renders the streaming message up to a row cap derived from the terminal
 * height (the old 12-row cap hid the last block; a cap >= terminal rows
 * would make ink clear the whole terminal every frame) and is PADDED to the
 * cap with spacer rows so the live region's height never churns mid-stream.
 */
describe('Mercury Code streaming tail: full preview + padded height', () => {
  it('renders the tail to the row cap and pads it to a constant height', () => {
    const longContent = Array.from({ length: 200 }, (_, i) => `Line ${i}: some streaming content here`).join('\n');
    const state = {
      mode: 'mercury-code',
      version: '1.2.5',
      agentName: 'Mercury',
      programmingMode: 'auto',
      projectContext: '/tmp/proj',
      permissionMode: 'allow-all',
      chatMessages: [
        { id: 'u1', role: 'user', content: 'explain git branching', timestamp: 1 },
        { id: 'a1', role: 'agent', content: longContent, timestamp: 2, streaming: true },
      ],
      toolSteps: [],
      subAgents: [],
      sidebarSections: [],
      backgroundTasks: [],
      skills: [],
      mercuryCode: {
        cwd: '/tmp/proj', dirName: 'proj', git: { branch: 'main', ahead: 0, behind: 0, dirty: 0 },
        scrollOffset: 0, exitConfirm: false,
      },
      tuiFrozen: false,
      isThinking: false,
    } as unknown as TuiState;

    const stdout = new FakeStdout() as any;
    const { unmount, rerender } = render(
      React.createElement(MercuryCodeView, { state, cols: 100, rows: 45 }),
      { stdout, exitOnCtrlC: false, patchConsole: false },
    );
    void rerender;
    const cap = Math.max(6, Math.min(48, 45 - 14)); // streamTailRowCap(45)
    // The 200-line message must render MANY more rows live than the old
    // 12-row cap — full preview of the streaming block — while staying
    // bounded by the cap.
    const stripped = stdout.output.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
    const contentRows = stripped.split('\n').filter((l: string) => l.includes('some streaming content'));
    const uniqueRows = new Set(contentRows.map((r: string) => r.trim()));
    expect(uniqueRows.size).toBeGreaterThan(12); // far beyond the old 12-row cap
    expect(uniqueRows.size).toBeLessThanOrEqual(cap);
    unmount();
  }, 10_000);

  it('streamTailRowCap derives from the terminal rows (never >= rows)', () => {
    // 24-row terminal: 10 tail rows; 30 rows: 16; 60+: capped at 48 —
    // always rows - 14 at minimum 6, so ink's clearTerminal path
    // (outputHeight >= rows) can never trip.
    const cap = (rows: number) => Math.max(6, Math.min(48, rows - 14));
    expect(cap(24)).toBe(10);
    expect(cap(30)).toBe(16);
    expect(cap(45)).toBe(31);
    expect(cap(120)).toBe(48);
    expect(cap(10)).toBe(6); // tiny terminal: floor, never negative
  });
});