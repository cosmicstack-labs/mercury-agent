import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestGracefulShutdown } from './daemon.js';
import { readAttachToken, writeAttachToken } from './../web/auth.js';

/** `mercury stop` asks the runtime first; only an ack for THIS pid counts. */
describe('requestGracefulShutdown', () => {
  let home: string;
  const previousHome = process.env.MERCURY_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mercury-graceful-'));
    process.env.MERCURY_HOME = home;
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.MERCURY_HOME;
    else process.env.MERCURY_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

  it('posts the attach token to the loopback API and accepts an ack for the pid', async () => {
    writeAttachToken();
    const f = reply(202, { ok: true, pid: 4242 });
    expect(await requestGracefulShutdown(4242, 500, f as unknown as typeof fetch)).toBe(true);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/shutdown$/);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${readAttachToken()}`);
  });

  it('is false (→ kill fallback) when another runtime answers, on 4xx/5xx, on network error, or with no token', async () => {
    writeAttachToken();
    expect(await requestGracefulShutdown(4242, 500, reply(202, { ok: true, pid: 1 }) as unknown as typeof fetch)).toBe(false);
    expect(await requestGracefulShutdown(4242, 500, reply(503, { error: 'not ready' }) as unknown as typeof fetch)).toBe(false);
    const failing = vi.fn(async () => { throw new TypeError('ECONNREFUSED'); });
    expect(await requestGracefulShutdown(4242, 500, failing as unknown as typeof fetch)).toBe(false);
    rmSync(join(home, 'attach-token'));
    const f = reply(202, { ok: true, pid: 4242 });
    expect(await requestGracefulShutdown(4242, 500, f as unknown as typeof fetch)).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });
});
