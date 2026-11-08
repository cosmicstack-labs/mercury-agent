import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { BrowserPipe } from './pipe.js';

function connection() {
  const input = new PassThrough();
  const output = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdio: [null, null, null, input, output] });
  const pipe = new BrowserPipe(child as unknown as ChildProcess);
  return { child, input, output, pipe };
}

describe('private CDP pipe bounds and failure handling', () => {
  it('handles partial frames and routes protocol events separately from command replies', async () => {
    const { pipe, input, output } = connection();
    const event = vi.fn();
    pipe.onEvent = event;
    const pending = pipe.send('Page.enable', {}, 'owned-session');
    expect(input.read().toString()).toContain('"sessionId":"owned-session"');
    output.write('{"id":1,"res');
    output.write('ult":{"ready":true}}\0{"method":"Page.loadEventFired","params":{}}\0');
    expect(await pending).toEqual({ ready: true });
    expect(event).toHaveBeenCalledWith({ method: 'Page.loadEventFired', params: {} });
    pipe.fail();
  });

  it('fails closed on excessive pending commands and releases every pending promise', async () => {
    const { pipe } = connection();
    const failure = vi.fn();
    pipe.onFailure = failure;
    const pending = Array.from({ length: 129 }, () => pipe.send('Page.enable').catch((error: Error) => error.message));
    const results = await Promise.all(pending);
    expect(results.every((value) => typeof value === 'string' && /closed|budget/.test(value))).toBe(true);
    expect(failure).toHaveBeenCalledOnce();
  });

  it('rejects oversized or malformed messages and process exit while a command is pending', async () => {
    for (const fail of [(c: ReturnType<typeof connection>) => c.output.write('x'.repeat(8_000_001)),
      (c: ReturnType<typeof connection>) => c.output.write('invalid-json\0'),
      (c: ReturnType<typeof connection>) => c.child.emit('exit', 1)]) {
      const c = connection();
      const pending = expect(c.pipe.send('Page.enable')).rejects.toThrow('closed');
      fail(c);
      await pending;
    }
  });
});
