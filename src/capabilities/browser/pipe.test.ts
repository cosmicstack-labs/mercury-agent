import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { BrowserPipe } from './pipe.js';

function connection<T extends Writable = PassThrough>(input: T = new PassThrough() as unknown as T) {
  const output = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdio: [null, null, null, input, output] });
  const pipe = new BrowserPipe(child as unknown as ChildProcess);
  return { child, input, output, pipe };
}

class SlowInput extends Writable {
  frames: Buffer[] = [];
  callbacks: Array<(error?: Error | null) => void> = [];
  constructor() { super({ highWaterMark: 1 }); }
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.frames.push(chunk);
    this.callbacks.push(callback);
  }
  async release(): Promise<void> {
    this.callbacks.shift()?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

afterEach(() => vi.useRealTimers());

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

  it('discards partial and late browser output once the transport is closed', async () => {
    const { pipe, output } = connection();
    const event = vi.fn();
    pipe.onEvent = event;
    const pending = expect(pipe.send('Page.enable')).rejects.toThrow('closed');
    output.write('{"id":1,"res');
    pipe.fail();
    await pending;
    const buffered = () => (pipe as unknown as { buffer: string }).buffer;
    expect(buffered()).toBe('');
    output.write('{"method":"Fetch.requestPaused","params":{}}\0');
    output.write('x'.repeat(8_000_001));
    output.write('y'.repeat(8_000_001));
    expect(event).not.toHaveBeenCalled();
    expect(buffered()).toBe('');
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

  it('honors pipe backpressure while transporting a full bounded page of base64 bodies', async () => {
    const input = new SlowInput();
    const { pipe, output } = connection(input);
    const body = Buffer.alloc(2_000_000).toString('base64');
    const requests = Array.from({ length: 4 }, () => pipe.send('Fetch.fulfillRequest', { body }));
    expect(input.frames).toHaveLength(1);
    expect(input.writableLength).toBeLessThan(2_700_000);
    for (let i = 1; i <= 4; i++) {
      output.write(JSON.stringify({ id: i, result: {} }) + '\0');
      await input.release();
      expect(input.frames).toHaveLength(Math.min(i + 1, 4));
    }
    await expect(Promise.all(requests)).resolves.toHaveLength(4);
    pipe.fail();
  });

  it('bounds queued wire bytes while the browser is not draining its input', async () => {
    const { pipe } = connection(new SlowInput());
    const body = Buffer.alloc(2_000_000).toString('base64');
    const requests = Array.from({ length: 5 }, () => pipe.send('Fetch.fulfillRequest', { body }).catch((error: Error) => error.message));
    expect((await Promise.all(requests)).every((value) => /closed|budget/.test(String(value)))).toBe(true);
  });

  it.each(['cancel', 'error', 'close'])('releases every queued command on %s without writing after cleanup', async (reason) => {
    const input = new SlowInput();
    const { pipe } = connection(input);
    const requests = [pipe.send('Page.enable'), pipe.send('Page.enable')].map((p) => p.catch((error: Error) => error.message));
    expect(input.frames).toHaveLength(1);
    if (reason === 'cancel') pipe.fail();
    else if (reason === 'error') input.emit('error', new Error('fixture pipe broke'));
    else input.emit('close');
    expect((await Promise.all(requests)).every((value) => /closed/.test(String(value)))).toBe(true);
    await input.release();
    expect(input.frames).toHaveLength(1);
  });

  it.each([undefined, 30_000])('keeps a finite deadline for timeout %s, including blocked writes', async (timeoutMs) => {
    vi.useFakeTimers();
    const { pipe } = connection(new SlowInput());
    const settled = vi.fn();
    const pending = pipe.send('Target.getTargets', {}, undefined, timeoutMs).catch((error: Error) => { settled(); return error.message; });
    await vi.advanceTimersByTimeAsync((timeoutMs ?? 10_000) - 1);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toContain('timed out');
    expect(settled).toHaveBeenCalledOnce();
  });
});
