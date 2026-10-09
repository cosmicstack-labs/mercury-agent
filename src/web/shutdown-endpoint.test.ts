import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import lifecycle, { setShutdownHandler } from './api/lifecycle.js';
import { readAttachToken, writeAttachToken, createSession } from './auth.js';

/**
 * POST /api/shutdown: the graceful stop path `mercury stop`/`restart`/
 * `upgrade` try before killing (the only way shutdown() runs on Windows).
 * Loopback-only and attach-token-only — a web session must not be enough.
 */
describe('POST /api/shutdown', () => {
  let home: string;
  const previousHome = process.env.MERCURY_HOME;
  const app = new Hono().route('/', lifecycle);

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mercury-shutdown-'));
    process.env.MERCURY_HOME = home;
    writeAttachToken();
  });

  afterEach(() => {
    setShutdownHandler(null);
    if (previousHome === undefined) delete process.env.MERCURY_HOME;
    else process.env.MERCURY_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  function post(token: string | null, remoteAddress = '127.0.0.1') {
    return app.request(
      '/api/shutdown',
      { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {} },
      { incoming: { socket: { remoteAddress } } },
    );
  }

  it('acknowledges with 202 + its pid and then runs the registered shutdown', async () => {
    const handler = vi.fn();
    setShutdownHandler(handler);
    const res = await post(readAttachToken());
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, pid: process.pid });
    expect(handler).not.toHaveBeenCalled(); // reply first
    await new Promise((r) => setTimeout(r, 50));
    expect(handler).toHaveBeenCalledOnce();
  });

  it('refuses non-loopback peers even with the right token', async () => {
    setShutdownHandler(vi.fn());
    const res = await post(readAttachToken(), '10.0.0.7');
    expect(res.status).toBe(403);
  });

  it('refuses a web session token and a missing/wrong token', async () => {
    const handler = vi.fn();
    setShutdownHandler(handler);
    expect((await post(createSession())).status).toBe(403);
    expect((await post(null)).status).toBe(403);
    expect((await post('deadbeef'.repeat(8))).status).toBe(403);
    await new Promise((r) => setTimeout(r, 50));
    expect(handler).not.toHaveBeenCalled();
  });

  it('answers 503 until the runtime has registered its shutdown', async () => {
    const res = await post(readAttachToken());
    expect(res.status).toBe(503);
  });
});
