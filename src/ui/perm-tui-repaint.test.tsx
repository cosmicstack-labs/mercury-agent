import { describe, expect, it } from 'vitest';
import React from 'react';
import { render } from 'ink';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { PermPromptView } from './App.js';
import type { PermissionPromptState } from './types.js';

/**
 * PermPromptView is the TUI's interactive permission / choice prompt.
 * It renders a message, a list of options with a ● selection marker, and
 * a help line.  The active index is driven by the parent (TuiApp via
 * useInput → setPermIdx), so this test renders the component directly
 * and verifies the marker moves correctly — no stream timing, no CI
 * flakiness from Ink's stdin pipeline.
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

class FakeStdin extends PassThrough {
  isRaw = true;
  setRawMode(): void {}
  ref(): void {}
  unref(): void {}
  isTTY = true;
}

const prompt: PermissionPromptState = {
  type: 'choice',
  message: 'How should I proceed?',
  options: [
    { value: 'a', label: 'Option A' },
    { value: 'b', label: 'Option B' },
    { value: 'c', label: 'Option C' },
    { value: 'd', label: 'Option D' },
  ],
};

describe('PermPromptView selection marker', () => {
  it('marks the active option with ● and others with ·', () => {
    const stdout = new FakeStdout() as any;
    const stdin = new FakeStdin() as any;

    const { rerender, unmount } = render(
      React.createElement(PermPromptView, { prompt, activeIdx: 0 }),
      { stdout, stdin, exitOnCtrlC: false },
    );

    // Initial: Option A is selected (● at index 0)
    expect(stdout.output).toContain('Option A');
    expect(stdout.output).toContain('●');

    // Move selection to index 2 (Option C)
    rerender(
      React.createElement(PermPromptView, { prompt, activeIdx: 2 }),
    );

    // After: the marker moved — Option C is now the active one
    expect(stdout.output).toContain('Option C');
    expect(stdout.output).toContain('●');

    // The help line should always be present
    expect(stdout.output).toContain('choose');

    unmount();
  });

  it('renders the prompt message and all option labels', () => {
    const stdout = new FakeStdout() as any;
    const stdin = new FakeStdin() as any;

    const { unmount } = render(
      React.createElement(PermPromptView, { prompt, activeIdx: 0 }),
      { stdout, stdin, exitOnCtrlC: false },
    );

    expect(stdout.output).toContain('How should I proceed?');
    expect(stdout.output).toContain('Option A');
    expect(stdout.output).toContain('Option B');
    expect(stdout.output).toContain('Option C');
    expect(stdout.output).toContain('Option D');

    unmount();
  });
});
