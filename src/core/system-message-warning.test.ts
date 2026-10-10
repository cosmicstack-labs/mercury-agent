/**
 * Regression: every model call printed "AI SDK Warning: System messages in the
 * prompt…" straight to the terminal. The raw console.warn landed inside the
 * TUI's live region, the renderer then erased the wrong rows, and a frozen
 * "Processing · 0s / Starting task" block stayed above every reply.
 */
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { streamText } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { CLIChannel } from '../channels/cli.js';
import './agent.js';

const AGENT_SRC = fs.readFileSync(path.join(__dirname, 'agent.ts'), 'utf8');

function mockModel() {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: new ReadableStream({
        start(c) {
          c.enqueue({ type: 'text-start', id: 't' });
          c.enqueue({ type: 'text-delta', id: 't', delta: 'hi' });
          c.enqueue({ type: 'text-end', id: 't' });
          c.enqueue({
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
          });
          c.close();
        },
      }),
    }),
  });
}

describe('AI SDK system-message warning', () => {
  it('every call that passes Mercury\'s own system message opts in', () => {
    const sites = AGENT_SRC.split('\n')
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => /messages: this\.withCachedSystem\(/.test(line));
    expect(sites.length).toBeGreaterThan(0);
    for (const { i } of sites) {
      const window = AGENT_SRC.split('\n').slice(Math.max(0, i - 4), i).join('\n');
      expect(window, `agent.ts:${i + 1}`).toContain('allowSystemInMessages: true');
    }
  });

  async function warningsFor(allowSystemInMessages: boolean | undefined): Promise<number> {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = streamText({
        model: mockModel(),
        allowSystemInMessages,
        messages: [{ role: 'system', content: 'You are Mercury.' }, { role: 'user', content: 'so sup' }],
      });
      await result.text;
      return warn.mock.calls.filter((c) => String(c[0]).includes('System messages')).length;
    } finally {
      warn.mockRestore();
    }
  }

  it('a cached system message with the opt-in prints nothing', async () => {
    expect(await warningsFor(undefined)).toBe(1); // control: the SDK does warn
    expect(await warningsFor(true)).toBe(0);
  });


  it('other SDK warnings go to the logger, not the console', () => {
    expect(typeof (globalThis as { AI_SDK_LOG_WARNINGS?: unknown }).AI_SDK_LOG_WARNINGS).toBe('function');
  });
});

describe('console while the TUI is mounted', () => {
  it('never reaches the terminal, and is restored on teardown', () => {
    const channel = new CLIChannel() as unknown as { captureConsole(): void; restoreConsole: (() => void) | null };
    const original = console.warn;
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const errWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      channel.captureConsole();
      expect(console.warn).not.toBe(original);
      console.warn('AI SDK Warning: stray');
      console.log('stray log');
      expect(write).not.toHaveBeenCalled();
      expect(errWrite).not.toHaveBeenCalled();
      channel.restoreConsole?.();
      expect(console.warn).toBe(original);
    } finally {
      write.mockRestore();
      errWrite.mockRestore();
      channel.restoreConsole?.();
    }
  });
});
