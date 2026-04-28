import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLIChannel } from './cli.js';

const originalIsTTY = process.stdout.isTTY;
const originalColumns = process.stdout.columns;

function streamChunks(...chunks: string[]): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();

  Object.defineProperty(process.stdout, 'isTTY', {
    configurable: true,
    value: originalIsTTY,
  });

  Object.defineProperty(process.stdout, 'columns', {
    configurable: true,
    value: originalColumns,
  });
});

describe('CLIChannel.stream', () => {
  it('does not print the final streamed content twice in TTY mode', async () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: true,
    });

    Object.defineProperty(process.stdout, 'columns', {
      configurable: true,
      value: 80,
    });

    const writes: string[] = [];
    const logs: string[] = [];
    const channel = new CLIChannel('Mercury Sandbox');

    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    }) as typeof process.stdout.write);

    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(' '));
    });

    const full = await channel.stream(streamChunks('O', 'K'));

    expect(full).toBe('OK');
    expect(writes.join('')).toBe('  OK\n');
    expect(logs.join('\n')).toContain('Mercury Sandbox:');
    expect(logs.join('\n')).not.toContain('OK');
    expect(writes.join('')).not.toContain('\x1b[J');
    expect(writes.join('')).not.toMatch(/\x1b\[\d+A/);
  });
});
