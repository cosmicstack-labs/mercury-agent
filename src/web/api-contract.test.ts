import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono, type Context } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWebAuth, createSession } from './auth.js';
import { authGuard } from './middleware.js';
import { createDevice, _resetDeviceState } from './devices.js';
import { apiCors, allowedOrigins, normalizeOrigin } from './cors.js';
import { API_VERSION, API_FEATURES } from './api-contract.js';

/**
 * The contract a remote client (Mercury Desktop, phones) relies on:
 *  - a device token opens /api/* from any address;
 *  - /api/health answers an authenticated remote peer with apiVersion;
 *  - POST /api/auth/token turns a password into a device token, once;
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

  it('POST /api/auth/token exchanges the password for a device token, then lists and revokes it', async () => {
    const { default: authRoutes } = await import('./api/auth.js');
    const { username, password } = initWebAuth();
    expect(password).not.toBe('');

    const bad = await authRoutes.request('http://127.0.0.1:6174/api/auth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'wrong', deviceName: 'Desktop' }),
    }, REMOTE);
    expect(bad.status).toBe(401);

    const res = await authRoutes.request('http://127.0.0.1:6174/api/auth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, deviceName: 'Desktop', platform: 'macos' }),
    }, REMOTE);
    expect(res.status).toBe(200);
    const body = await res.json() as { token: string; device: { id: string; name: string }; apiVersion: number; features: string[] };
    expect(body.token).toMatch(/^mdt_/);
    expect(body.device.name).toBe('Desktop');
    expect(body.apiVersion).toBe(API_VERSION);
    expect(Array.isArray(body.features)).toBe(true);

    const list = await authRoutes.request('http://127.0.0.1:6174/api/auth/devices', { headers: { Authorization: `Bearer ${body.token}` } }, REMOTE);
    const listed = await list.json() as { devices: Array<{ id: string }>; current: string };
    expect(listed.devices.map((d) => d.id)).toContain(body.device.id);
    expect(listed.current).toBe(body.device.id);

    const revoke = await authRoutes.request('http://127.0.0.1:6174/api/auth/token/revoke', { method: 'POST', headers: { Authorization: `Bearer ${body.token}` } }, REMOTE);
    expect(revoke.status).toBe(200);
    let nextCalled = false;
    await authGuard(makeContext('/api/chat/models', body.token, '10.0.0.7'), async () => { nextCalled = true; });
    expect(nextCalled).toBe(false);
  });

  it('locks an address out after repeated failures', async () => {
    const { default: authRoutes } = await import('./api/auth.js');
    const { username } = initWebAuth();
    const attacker = { incoming: { socket: { remoteAddress: '203.0.113.9' } } };
    let last = 0;
    for (let i = 0; i < 12; i++) {
      const r = await authRoutes.request('http://127.0.0.1:6174/api/auth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: `guess-${i}` }),
      }, attacker);
      last = r.status;
      if (last === 429) {
        expect(r.headers.get('Retry-After')).toBeTruthy();
        break;
      }
    }
    expect(last).toBe(429);
    // Another address is unaffected.
    const other = await authRoutes.request('http://127.0.0.1:6174/api/auth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'guess' }),
    }, REMOTE);
    expect(other.status).toBe(401);
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
