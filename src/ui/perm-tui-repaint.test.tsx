import { describe, expect, it } from 'vitest';
import React from 'react';
import { render } from 'ink';
import { Text, Box } from 'ink';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { PermPromptView } from './App.js';
import type { PermissionPromptState } from './types.js';

/**
 * Ink renders asynchronously — it writes the cursor-hide escape
 * (\x1b[?25l) synchronously but the actual component tree flushes through a
 * 32ms-throttled onRender. A fixed sleep (20ms) passes on a fast machine and
 * races on a loaded CI runner, where stdout contains only the escape code
 * when the assertion runs. Never sleep for a frame: poll for the expected
 * content, bounded.
 */
async function waitForFrame(stdout: { output: string }, expected: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !stdout.output.includes(expected)) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!stdout.output.includes(expected)) {
    throw new Error(`frame content never rendered within ${timeoutMs}ms: "${expected}"`);
  }
}

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

class FakeStdin extends EventEmitter {
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
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
  resolve: () => {},
};

describe('PermPromptView selection marker', () => {
  it('marks the active option with ● and others with ·', async () => {
    const stdout = new FakeStdout() as any;
    const stdin = new FakeStdin() as any;

    const { rerender, unmount } = render(
      React.createElement(PermPromptView, { prompt, activeIdx: 0 }),
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );

    // Wait for React to commit the initial render.
    await waitForFrame(stdout, 'Option A');

    // Initial: Option A is selected (● at index 0)
    expect(stdout.output).toContain('●');
    expect(stdout.output).toContain('Option D');

    // Move selection to index 2 (Option C)
    rerender(
      React.createElement(PermPromptView, { prompt, activeIdx: 2 }),
    );

    // Wait for React to commit the re-render.
    await waitForFrame(stdout, 'Option C');

    // After: the marker moved — Option C is now the active one
    expect(stdout.output).toContain('●');

    // The help line should always be present
    expect(stdout.output).toContain('choose');

    unmount();
  });

  it('renders the prompt message and all option labels', async () => {
    const stdout = new FakeStdout() as any;
    const stdin = new FakeStdin() as any;

    const { unmount } = render(
      React.createElement(PermPromptView, { prompt, activeIdx: 0 }),
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );

    // Wait for React to commit the initial render.
    await waitForFrame(stdout, 'Option D');

    expect(stdout.output).toContain('How should I proceed?');
    expect(stdout.output).toContain('Option A');
    expect(stdout.output).toContain('Option B');
    expect(stdout.output).toContain('Option C');
    expect(stdout.output).toContain('Option D');

    unmount();
  });
});
