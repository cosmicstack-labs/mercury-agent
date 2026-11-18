import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { PAIR_CODE_TTL_MS, PairCodes, _setPairCodes, pairCodes } from '../../security/pair-codes.js';
import { writeRemoteSettings } from '../../security/remote-settings.js';
import { auditPath, readAudit } from '../../security/audit.js';
import { API_FEATURES, API_VERSION } from '../api-contract.js';

const LOCAL = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };
const ADDRESS = 'https://mercury.tail1234.ts.net';

let home: string;
const previous = process.env.MERCURY_HOME;
let t = 5_000_000;
let ipSeq = 0;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'mercury-pair-route-'));
  process.env.MERCURY_HOME = home;
  t = 5_000_000;
  _setPairCodes(new PairCodes(() => t));
  const { _resetDeviceState } = await import('../devices.js');
  _resetDeviceState();
});

afterEach(() => {
  _setPairCodes(null);
  if (previous === undefined) delete process.env.MERCURY_HOME; else process.env.MERCURY_HOME = previous;
  rmSync(home, { recursive: true, force: true });
});

async function app() {
  const { authGuard } = await import('../middleware.js');
  const { default: auth } = await import('./auth.js');
  const a = new Hono();
  a.use('*', authGuard);
  a.route('/', auth);
  a.get('/api/ping', (c) => c.json({ ok: true }));
  return a;
}

function phoneAt(ip: string) {
  return (a: Hono, body: Record<string, unknown>) => a.request('http://127.0.0.1:6174/api/auth/pair', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip, Host: 'mercury.tail1234.ts.net' },
    body: JSON.stringify(body),
  }, LOCAL);
}

const newPhone = () => phoneAt(`100.101.102.${++ipSeq}`);

describe('POST /api/auth/pair', () => {
  it('turns a valid code into a device token that works from the tunnel', async () => {
    const a = await app();
    const shown = pairCodes().create(ADDRESS, 'cli');
    const phone = newPhone();
    const res = await phone(a, { code: shown.display.toLowerCase(), deviceName: 'Pixel 9', platform: 'android' });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(shown.code);
    const body = JSON.parse(text) as { token: string; device: { name: string; platform: string; approvedBy?: string }; apiVersion: number; features: string[] };
    expect(body.token).toMatch(/^mdt_[0-9a-f]{8}_[0-9a-f]{64}$/);
    expect(body.device).toMatchObject({ name: 'Pixel 9', platform: 'android', approvedBy: 'cli' });
    expect(body.apiVersion).toBe(API_VERSION);
    expect(body.features).toEqual([...API_FEATURES]);
    expect(body.features).toContain('auth.pairCode');
    const ping = await a.request('http://127.0.0.1:6174/api/ping', { headers: { Authorization: `Bearer ${body.token}`, 'X-Forwarded-For': '100.101.102.200', Host: 'mercury.tail1234.ts.net' } }, LOCAL);
    expect(ping.status).toBe(200);
    expect(await pairCodes().wait(shown.id)).toEqual({ status: 'paired', device: { name: 'Pixel 9', platform: 'android' } });
    expect(readFileSync(auditPath(), 'utf-8')).not.toContain(body.token);
  });

  it('refuses a used, wrong or expired code with the same message', async () => {
    const a = await app();
    const phone = newPhone();
    const shown = pairCodes().create(ADDRESS, 'cli');
    expect((await phone(a, { code: shown.code, deviceName: 'Pixel 9', platform: 'android' })).status).toBe(200);
    const used = await phone(a, { code: shown.code, deviceName: 'Pixel 9', platform: 'android' });
    const wrong = await phone(a, { code: 'ABCDE-FGHJK-MNPQR-STVWX-YZ012', deviceName: 'Pixel 9' });
    const late = pairCodes().create(ADDRESS, 'cli');
    t += PAIR_CODE_TTL_MS + 1;
    const expired = await phone(a, { code: late.code, deviceName: 'Pixel 9' });
    const answers = await Promise.all([used, wrong, expired].map(async (r) => [r.status, ((await r.json()) as { error: string }).error]));
    expect(answers[0][0]).toBe(401);
    expect(new Set(answers.map((x) => JSON.stringify(x))).size).toBe(1);
    expect(readAudit(20).filter((e) => e.kind === 'login.failed' && e.detail === 'wrong pairing code')).toHaveLength(3);
  });

  it('locks a client out after 10 wrong codes, even with the right one', async () => {
    const a = await app();
    const phone = newPhone();
    const shown = pairCodes().create(ADDRESS, 'cli');
    for (let i = 0; i < 10; i++) expect((await phone(a, { code: `WRONG${i}`, deviceName: 'Guesser' })).status).toBe(401);
    const locked = await phone(a, { code: shown.code, deviceName: 'Guesser' });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(readAudit(20).some((e) => e.kind === 'login.locked')).toBe(true);
    expect((await newPhone()(a, { code: shown.code, deviceName: 'Pixel 9' })).status).toBe(200);
  });

  it('only the newest code works', async () => {
    const a = await app();
    const phone = newPhone();
    const first = pairCodes().create(ADDRESS, 'cli');
    const second = pairCodes().create(ADDRESS, 'cli');
    expect((await phone(a, { code: first.code, deviceName: 'Pixel 9' })).status).toBe(401);
    expect((await phone(a, { code: second.code, deviceName: 'Pixel 9' })).status).toBe(200);
  });

  it('keeps the code when the device limit is reached, so it works once a device is revoked', async () => {
    const a = await app();
    const { createDevice, revokeDevice } = await import('../devices.js');
    writeRemoteSettings({ maxDevices: 1 });
    const old = createDevice('Old phone', 'ios');
    const phone = newPhone();
    const shown = pairCodes().create(ADDRESS, 'cli');
    const full = await phone(a, { code: shown.code, deviceName: 'Pixel 9', platform: 'android' });
    expect(full.status).toBe(409);
    expect(pairCodes().status(shown.id)).toBe('waiting');
    revokeDevice(old.device.id);
    expect((await phone(a, { code: shown.code, deviceName: 'Pixel 9', platform: 'android' })).status).toBe(200);
  });

  it('still needs remote access on and an allowed address', async () => {
    const a = await app();
    const shown = pairCodes().create(ADDRESS, 'cli');
    writeRemoteSettings({ enabled: false });
    const off = await newPhone()(a, { code: shown.code, deviceName: 'Pixel 9' });
    expect(off.status).toBe(403);
    expect(((await off.json()) as { remoteOff?: boolean }).remoteOff).toBe(true);
    writeRemoteSettings({ enabled: true, allowIps: ['203.0.113.0/24'] });
    const blocked = await newPhone()(a, { code: shown.code, deviceName: 'Pixel 9' });
    expect(blocked.status).toBe(403);
    expect(((await blocked.json()) as { addressBlocked?: boolean }).addressBlocked).toBe(true);
    expect(pairCodes().status(shown.id)).toBe('waiting');
    expect((await phoneAt('203.0.113.7')(a, { code: shown.code, deviceName: 'Pixel 9' })).status).toBe(200);
  });

  it('needs a JSON body with a code', async () => {
    const a = await app();
    const phone = newPhone();
    expect((await phone(a, {})).status).toBe(400);
    const notJson = await a.request('http://127.0.0.1:6174/api/auth/pair', { method: 'POST', headers: { 'X-Forwarded-For': '100.101.103.1', Host: 'mercury.tail1234.ts.net' }, body: 'code=X' }, LOCAL);
    expect(notJson.status).toBe(400);
  });
});
