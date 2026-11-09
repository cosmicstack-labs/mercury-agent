import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import type { RequestOptions } from 'node:https';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BrowserByteBudget, requestPublicResource, MAX_RESOURCE_BYTES } from './public-request.js';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));
vi.mock('node:https', () => ({ request: vi.fn() }));

function respond(body: Buffer, statusCode = 200, headers = { 'content-type': 'text/html' }) {
  const client = Object.assign(new EventEmitter(), { setTimeout: vi.fn(), end: vi.fn(), destroy: vi.fn() });
  vi.mocked(request).mockImplementation(((url: URL, options: RequestOptions, callback: (res: unknown) => void) => {
    client.end.mockImplementation(() => {
      const response = Object.assign(Readable.from([body]), { statusCode, headers });
      callback(response);
    });
    return client;
  }) as never);
  return client;
}

beforeEach(() => vi.resetAllMocks());

describe('public resource connection pinning and bounds', () => {
  it('pins the verified IP at connection time without a second DNS lookup, proxy, cookies or authorization', async () => {
    vi.mocked(lookup).mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }] as never)
      .mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as never);
    respond(Buffer.from('safe'));
    const result = await requestPublicResource(new URL('https://public.example/'), new AbortController().signal);
    expect(result.body.toString()).toBe('safe');
    const options = vi.mocked(request).mock.calls[0]![1] as RequestOptions;
    const address = vi.fn();
    options.lookup!('public.example', { all: true }, address);
    expect(address).toHaveBeenCalledWith(null, [{ address: '93.184.216.34', family: 4 }]);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(options.agent).toBe(false);
    expect(options.method).toBe('GET');
    expect(options.headers).toEqual({ 'User-Agent': 'Mercury-Isolated-Reader/1.0', Accept: '*/*', 'Accept-Encoding': 'identity' });
  });

  it('never connects when DNS changes to private or when the operation was cancelled', async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as never);
    await expect(requestPublicResource(new URL('https://public.example/'), new AbortController().signal)).rejects.toThrow('Browser blocked DNS');
    vi.mocked(lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
    await expect(requestPublicResource(new URL('https://public.example/'), AbortSignal.abort())).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it('does not follow redirects or relay credentials/active response headers', async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
    respond(Buffer.from(''), 302, { 'content-type': 'text/html', location: 'http://127.0.0.1/', 'set-cookie': 'secret', refresh: '0;url=file:///secret', 'alt-svc': 'h3=":443"' } as { 'content-type': string });
    const result = await requestPublicResource(new URL('https://public.example/'), new AbortController().signal);
    expect(result.status).toBe(302);
    expect(result.headers).toEqual({ 'content-type': 'text/html', location: 'http://127.0.0.1/' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('destroys a response stream as soon as it exceeds the resource byte cap', async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
    respond(Buffer.alloc(MAX_RESOURCE_BYTES + 1));
    await expect(requestPublicResource(new URL('https://public.example/'), new AbortController().signal)).rejects.toThrow('exceeds 2 MB');
  });

  it('cancels every concurrent response on shared budget exhaustion before buffering another chunk', async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
    const streams: PassThrough[] = [];
    const signals: AbortSignal[] = [];
    vi.mocked(request).mockImplementation(((_url: URL, options: RequestOptions, callback: (res: unknown) => void) => {
      const response = Object.assign(new PassThrough(), { statusCode: 200, headers: { 'content-type': 'text/html' } });
      const signal = options.signal!;
      const client = Object.assign(new EventEmitter(), {
        setTimeout: vi.fn(), destroy: vi.fn(), end: () => callback(response),
      });
      signal.addEventListener('abort', () => { response.destroy(signal.reason); client.emit('error', signal.reason); }, { once: true });
      streams.push(response);
      signals.push(signal);
      return client;
    }) as never);
    const budget = new BrowserByteBudget();
    const requests = Promise.allSettled(Array.from({ length: 8 }, (_, i) => requestPublicResource(new URL(`https://public.example/${i}`), new AbortController().signal, budget)));
    await expect.poll(() => streams.length).toBe(8);
    for (const stream of streams) stream.write(Buffer.alloc(1_000_000));
    expect(budget.signal.aborted).toBe(false);
    streams[0]!.write(Buffer.alloc(1));
    expect(budget.signal.aborted).toBe(true);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(streams.every((stream) => stream.destroyed)).toBe(true);
    expect((await requests).every((result) => result.status === 'rejected')).toBe(true);
    await expect(requestPublicResource(new URL('https://public.example/late'), new AbortController().signal, budget)).rejects.toThrow('download budget');
    expect(request).toHaveBeenCalledTimes(8);
  });

  it('counts bytes from failed resource transfers toward the same navigation budget', async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
    const budget = new BrowserByteBudget();
    respond(Buffer.alloc(MAX_RESOURCE_BYTES + 1));
    for (let i = 0; i < 3; i++) {
      await expect(requestPublicResource(new URL('https://public.example/'), new AbortController().signal, budget)).rejects.toThrow('exceeds 2 MB');
    }
    await expect(requestPublicResource(new URL('https://public.example/'), new AbortController().signal, budget)).rejects.toThrow('download budget');
    expect(budget.signal.aborted).toBe(true);
  });
});
