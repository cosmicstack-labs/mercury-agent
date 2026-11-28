import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono, type Context } from 'hono';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from './auth.js';
import { authGuard } from './middleware.js';
import { createDevice, _resetDeviceState } from './devices.js';
import { apiCors, allowedOrigins, normalizeOrigin } from './cors.js';
import { API_VERSION, API_FEATURES } from './api-contract.js';

/**
 * The contract a remote client (Mercury Desktop, phones) relies on:
 *  - a device token opens /api/* from any address;
 *  - /api/health answers an authenticated remote peer with apiVersion;
 *  - there is no password: the old password endpoints answer 410, a browser
 *    signs in with a device token or a one-time link made on this computer;
 *  - CORS lets the desktop origin in and nobody else.
 */

const REMOTE = { incoming: { socket: { remoteAddress: '10.0.0.7' } } };
const LOOPBACK = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };

describe('api contract', () => {
  let home: string;
  const previousHome = process.env.MERCURY_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mercury-contract-'));
    process.env.MERCURY_HOME = home;
    _resetDeviceState();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.MERCURY_HOME;
    else process.env.MERCURY_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('a device token passes the guard from a non-loopback peer; a revoked one does not', async () => {
    const { token } = createDevice('Desktop', 'macos');
    let nextCalled = false;
    const ok = await authGuard(makeContext('/api/chat/models', token, '10.0.0.7'), async () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    expect(ok).toBeUndefined();

    const { revokeDevice, listDevices } = await import('./devices.js');
    revokeDevice(listDevices()[0].id);
    nextCalled = false;
    const denied = await authGuard(makeContext('/api/chat/models', token, '10.0.0.7'), async () => { nextCalled = true; }) as { status?: number };
    expect(nextCalled).toBe(false);
    expect(denied?.status).toBe(401);
  });

  it('/api/health carries the contract for loopback and for an authenticated remote peer only', async () => {
    const { default: statusRoutes } = await import('./api/status.js');
    const { token } = createDevice('Desktop', 'macos');

    const loopback = await statusRoutes.request('http://127.0.0.1:6174/api/health', {}, LOOPBACK);
    expect(loopback.status).toBe(200);
    const body = await loopback.json() as { apiVersion: number; features: string[]; version: string };
    expect(body.apiVersion).toBe(API_VERSION);
    expect(body.features).toEqual([...API_FEATURES]);

    const anonymous = await statusRoutes.request('http://127.0.0.1:6174/api/health', {}, REMOTE);
    expect(anonymous.status).toBe(404);

    const withDevice = await statusRoutes.request('http://127.0.0.1:6174/api/health', { headers: { Authorization: `Bearer ${token}` } }, REMOTE);
    expect(withDevice.status).toBe(200);
    expect(((await withDevice.json()) as { apiVersion: number }).apiVersion).toBe(API_VERSION);

    const session = createSession();
    const withSession = await statusRoutes.request('http://127.0.0.1:6174/api/health', { headers: { Authorization: `Bearer ${session}` } }, REMOTE);
    expect(withSession.status).toBe(200);
  });

  it('the password endpoints are gone, from anywhere (ADR-050)', async () => {
    const { default: authRoutes } = await import('./api/auth.js');
    const json = { 'Content-Type': 'application/json' };
    for (const path of ['/api/auth/token', '/api/auth/token/pending', '/api/auth/password', '/api/auth/username']) {
      for (const peer of [REMOTE, LOOPBACK]) {
        const r = await authRoutes.request(`http://127.0.0.1:6174${path}`, { method: 'POST', headers: json, body: JSON.stringify({ username: 'mercury', password: 'Mercury@123', deviceName: 'Phone' }) }, peer);
        expect(r.status).toBe(410);
        expect(((await r.json()) as { code: string }).code).toBe('password_removed');
      }
    }
  });

  /** What the sign-in page sends: JSON from its own origin. */
  const SAME_SITE = { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:6174', Host: '127.0.0.1:6174' };

  it('refuses a sign-in posted from another site', async () => {
    const app = await guarded();
    const { token } = createDevice('Laptop browser', 'web');
    const forged = await app.request('http://127.0.0.1:6174/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', Host: '127.0.0.1:6174' }, body: JSON.stringify({ token }) }, REMOTE);
    expect(forged.status).toBe(403);
  });

  /** The guard in front of one API route, as the real server mounts it. */
  async function guarded() {
    const { default: authRoutes } = await import('./api/auth.js');
    const app = new Hono();
    app.use('*', authGuard);
    app.route('/', authRoutes);
    app.get('/api/x', (c) => c.text('ok'));
    return app;
  }

  it('a browser signs in with a device token; revoking the device signs it out', async () => {
    const app = await guarded();
    const { token, device } = createDevice('Laptop browser', 'web');
    const login = await app.request('http://127.0.0.1:6174/api/auth/login', { method: 'POST', headers: SAME_SITE, body: JSON.stringify({ token }) }, REMOTE);
    expect(login.status).toBe(200);
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
    expect(cookie).toBe(`mercury_device=${token}`);
    expect((login.headers.get('set-cookie') ?? '').toLowerCase()).toContain('httponly');

    expect((await app.request('http://127.0.0.1:6174/api/x', { headers: { Cookie: cookie } }, REMOTE)).status).toBe(200);
    const { revokeDevice } = await import('./devices.js');
    revokeDevice(device.id);
    expect((await app.request('http://127.0.0.1:6174/api/x', { headers: { Cookie: cookie } }, REMOTE)).status).toBe(401);
  });

  it('wrong device tokens lock an address out; another address is unaffected', async () => {
    const app = await guarded();
    const attacker = { incoming: { socket: { remoteAddress: '203.0.113.9' } } };
    let last = 0;
    for (let i = 0; i < 12; i++) {
      const r = await app.request('http://127.0.0.1:6174/api/auth/login', { method: 'POST', headers: SAME_SITE, body: JSON.stringify({ token: `mdt_deadbeef_${'0'.repeat(63)}${i % 10}` }) }, attacker);
      last = r.status;
      if (last === 429) { expect(r.headers.get('Retry-After')).toBeTruthy(); break; }
      expect(last).toBe(401);
    }
    expect(last).toBe(429);
    const other = await app.request('http://127.0.0.1:6174/api/auth/login', { method: 'POST', headers: SAME_SITE, body: JSON.stringify({ token: 'not-a-token' }) }, REMOTE);
    expect(other.status).toBe(401);
  });

  it('a one-time link signs in a browser on this computer, once, and never from elsewhere', async () => {
    const app = await guarded();
    const { browserLinks } = await import('../security/browser-links.js');
    const { code } = browserLinks().create();
    const remote = await app.request(`http://127.0.0.1:6174/login/once?c=${code}`, {}, REMOTE);
    expect(remote.status).toBe(403);
    const here = await app.request(`http://127.0.0.1:6174/login/once?c=${code}`, {}, LOOPBACK);
    expect(here.status).toBe(302);
    const cookie = (here.headers.get('set-cookie') ?? '').split(';')[0];
    expect(cookie).toMatch(/^mercury_session=/);
    expect((await app.request('http://127.0.0.1:6174/api/x', { headers: { Cookie: cookie } }, REMOTE)).status).toBe(200);
    const again = await app.request(`http://127.0.0.1:6174/login/once?c=${code}`, {}, LOOPBACK);
    expect(again.status).toBe(401);
  });

  it('CORS admits the desktop origins and configured extras, never a wildcard or a stranger', async () => {
    const app = new Hono();
    app.use('/api/*', apiCors(['https://dashboard.example.com', '*', 'not a url', 'https://x.example/path']));
    app.get('/api/ping', (c) => c.json({ ok: true }));

    const desktop = await app.request('http://127.0.0.1:6174/api/ping', { headers: { Origin: 'tauri://localhost' } });
    expect(desktop.headers.get('Access-Control-Allow-Origin')).toBe('tauri://localhost');
    expect(desktop.headers.get('Access-Control-Allow-Credentials')).toBeNull();

    const windows = await app.request('http://127.0.0.1:6174/api/ping', { headers: { Origin: 'http://tauri.localhost' } });
    expect(windows.headers.get('Access-Control-Allow-Origin')).toBe('http://tauri.localhost');

    const extra = await app.request('http://127.0.0.1:6174/api/ping', { headers: { Origin: 'https://dashboard.example.com' } });
    expect(extra.headers.get('Access-Control-Allow-Origin')).toBe('https://dashboard.example.com');

    const stranger = await app.request('http://127.0.0.1:6174/api/ping', { headers: { Origin: 'https://evil.example' } });
    expect(stranger.headers.get('Access-Control-Allow-Origin')).toBeNull();

    const preflight = await app.request('http://127.0.0.1:6174/api/ping', {
      method: 'OPTIONS',
      headers: { Origin: 'tauri://localhost', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Headers')).toMatch(/Authorization/);

    const set = allowedOrigins(['https://a.example'], {} as NodeJS.ProcessEnv);
    expect(set.has('https://a.example')).toBe(true);
    expect(set.has('http://localhost:1420')).toBe(false);
    expect(allowedOrigins([], { MERCURY_DESKTOP_DEV: '1' } as NodeJS.ProcessEnv).has('http://localhost:1420')).toBe(true);
    expect(normalizeOrigin('https://A.example:8443/')).toBe('https://a.example:8443');
    expect(normalizeOrigin('*')).toBeNull();
  });
});

function makeContext(path: string, token: string, remoteAddress: string): Context {
  const fake = {
    req: {
      url: `http://127.0.0.1:6174${path}`,
      raw: new Request(`http://127.0.0.1:6174${path}`),
      headers: new Headers(),
      header: (name: string) => name.toLowerCase() === 'authorization' && token ? `Bearer ${token}` : undefined,
    },
    env: { incoming: { socket: { remoteAddress } } },
    json: (body: unknown, status = 200) => ({ body, status }),
  };
  return fake as unknown as Context;
}
