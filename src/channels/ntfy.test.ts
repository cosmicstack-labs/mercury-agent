import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { NtfyChannel } from './ntfy.js';
import type { MercuryConfig } from '../utils/config.js';

const dir = mkdtempSync(join(tmpdir(), 'mercury-ntfy-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.unstubAllGlobals());

const config = (over: Partial<{ url: string; topic: string; token: string; priority: string; tags: string }> = {}): MercuryConfig =>
  ({
    channels: {
      ntfy: {
        enabled: true,
        url: 'https://ntfy.example',
        topic: 'mercury-alerts',
        token: '',
        priority: 'high',
        tags: 'warning',
        ...over,
      },
    },
  }) as unknown as MercuryConfig;

describe('ntfy — alerts become phone notifications', () => {
  it('is not ready without a topic, and stays silent instead of throwing', async () => {
    const channel = new NtfyChannel(config({ topic: '' }));
    await channel.start();
    expect(channel.isReady()).toBe(false);
    await expect(channel.send('hello')).resolves.toBeUndefined();
  });

  it('refuses a topic that would escape the path', async () => {
    for (const topic of ['a/b', '../other', 'with space', 'q?x=1']) {
      const channel = new NtfyChannel(config({ topic }));
      await channel.start();
      expect(channel.isReady(), topic).toBe(false);
    }
  });

  it('refuses a non-http URL', async () => {
    const channel = new NtfyChannel(config({ url: 'file:///etc/passwd' }));
    await channel.start();
    expect(channel.isReady()).toBe(false);
  });

  it('posts plain text to <url>/<topic> with the ntfy headers', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const channel = new NtfyChannel(config({ url: 'https://ntfy.example/', token: 'tk_abc' }));
    await channel.start();

    await channel.send('❌ **CEO** failed permanently');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    // Trailing slash in NTFY_URL must not become a double slash.
    expect(url).toBe('https://ntfy.example/mercury-alerts');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Title).toBe('Mercury');
    expect(headers.Priority).toBe('high');
    expect(headers.Tags).toBe('warning');
    expect(headers.Authorization).toBe('Bearer tk_abc');
    expect(String(init.body)).toBe('❌ **CEO** failed permanently');
  });

  it('sends no Authorization header and no Tags when they are not configured', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const channel = new NtfyChannel(config({ tags: '' }));
    await channel.start();
    await channel.send('hi');
    const headers = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers.Tags).toBeUndefined();
  });

  it('passes the configured priority through untouched (ntfy names or 1-5)', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const channel = new NtfyChannel(config({ priority: '1' }));
    await channel.start();
    await channel.send('low');
    const headers = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers.Priority).toBe('1');
  });

  it('surfaces a failing server so the caller logs it, never pretends', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 429 })));
    const channel = new NtfyChannel(config());
    await channel.start();
    await expect(channel.send('hi')).rejects.toThrow('HTTP 429');
  });

  it('uploads a file as a real ntfy attachment', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const channel = new NtfyChannel(config({ token: 'tk_x' }));
    await channel.start();
    const file = join(dir, 'report.pdf');
    writeFileSync(file, 'x'.repeat(1000));

    await channel.sendFile(file);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://ntfy.example/mercury-alerts');
    expect(init.method).toBe('PUT');
    const headers = init.headers as Record<string, string>;
    expect(headers.Filename).toBe('report.pdf');
    expect(headers.Authorization).toBe('Bearer tk_x');
    expect((init.body as Uint8Array).byteLength).toBe(1000);
  });

  it('names the file when the server refuses the attachment', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'PUT' ? new Response('too large', { status: 413 }) : new Response('{}', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const channel = new NtfyChannel(config());
    await channel.start();
    const file = join(dir, 'big.png');
    writeFileSync(file, 'x'.repeat(4096));

    await channel.sendFile(file);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const fallbackBody = String((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body);
    expect(fallbackBody).toContain('big.png');
    expect(fallbackBody).toContain('refusée');
  });

  it('coalesces a stream into one notification', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const channel = new NtfyChannel(config());
    await channel.start();

    async function* chunks() {
      yield 'one ';
      yield 'two';
    }
    expect(await channel.stream(chunks())).toBe('one two');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('is a doorbell, not a chat', async () => {
    const channel = new NtfyChannel(config());
    expect(channel.noBroadcast).toBe(true);
    expect(channel.type).toBe('ntfy');
    expect(await channel.askToContinue()).toBe(false);
    await expect(channel.typing()).resolves.toBeUndefined();
  });
});
