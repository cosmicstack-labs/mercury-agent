import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';

/**
 * Updating this Mercury from an app: anyone signed in sees the status; this
 * computer starts an update at once; another device waits for the owner.
 */

const status = {
  current: '1.4.2', channel: 'stable', install: 'binary', canSelfUpdate: true,
  latest: { version: '1.5.0', notes: 'New things' }, updateAvailable: true, required: null,
  manifestVerified: true, checkedAt: 1, job: null, blocked: null, justUpdated: null, messages: [],
};
const serverUpdateStatus = vi.fn(async (opts: unknown) => ({ ...status, ...(opts ? {} : {}) }));
vi.mock('../../updates/status.js', () => ({
  serverUpdateStatus: (o: unknown) => serverUpdateStatus(o),
  targetVersion: (s: typeof status) => (s.updateAvailable && s.latest ? s.latest.version : null),
}));
vi.mock('./status.js', () => ({ versionString: () => '1.4.2' }));
vi.mock('../../updates/install-kind.js', () => ({ detectInstall: () => ({ kind: 'binary', channel: 'stable', canSelfUpdate: true }) }));

const job = { id: 'j1', from: '1.4.2', to: '1.5.0', state: 'waiting-idle', percent: 0, message: 'Waiting', startedAt: 1, updatedAt: 1, log: [], attempt: 1, install: 'binary', channel: 'stable' };
const startServerUpdate = vi.fn();
const cancelServerUpdate = vi.fn();
vi.mock('../../updates/server-updater.js', () => ({
  startServerUpdate: (o: unknown) => startServerUpdate(o),
  cancelServerUpdate: () => cancelServerUpdate(),
}));

const LOCAL = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };
const LAN = { incoming: { socket: { remoteAddress: '192.168.1.20' } } };
let home = '';
const previous = process.env.MERCURY_HOME;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'mercury-upd-route-'));
  process.env.MERCURY_HOME = home;
  const { OwnerApprovals, _setOwnerApprovals } = await import('../../security/owner-approvals.js');
  _setOwnerApprovals(new OwnerApprovals());
  startServerUpdate.mockReset();
  startServerUpdate.mockReturnValue({ ok: true, job, done: Promise.resolve() });
  serverUpdateStatus.mockClear();
});
afterEach(() => {
  if (previous === undefined) delete process.env.MERCURY_HOME; else process.env.MERCURY_HOME = previous;
  rmSync(home, { recursive: true, force: true });
});

async function app() {
  const { authGuard } = await import('../middleware.js');
  const { default: updates } = await import('./updates.js');
  const a = new Hono();
  a.use('*', authGuard);
  a.route('/', updates);
  return a;
}

async function phone() {
  const { createDevice, _resetDeviceState } = await import('../devices.js');
  _resetDeviceState();
  return createDevice('Phone', 'ios');
}

describe('/api/updates', () => {
  it('a signed-in device sees the status; "seen" is passed on', async () => {
    const a = await app();
    const p = await phone();
    const res = await a.request('http://127.0.0.1/api/updates?seen=1', { headers: { Authorization: `Bearer ${p.token}` } }, LAN);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ current: '1.4.2', latest: { version: '1.5.0' } });
    expect(serverUpdateStatus).toHaveBeenCalledWith(expect.objectContaining({ seen: true }));
    expect((await a.request('http://127.0.0.1/api/updates', {}, LAN)).status).toBe(401);
  });

  it('this computer starts an update: 202 with the job', async () => {
    const a = await app();
    const { readAttachToken, writeAttachToken } = await import('../auth.js');
    writeAttachToken();
    const token = readAttachToken();
    const res = await a.request('http://127.0.0.1/api/updates/server', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ now: true }) }, LOCAL);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ job: { id: 'j1', to: '1.5.0' } });
    expect(startServerUpdate).toHaveBeenCalledWith(expect.objectContaining({ current: '1.4.2', to: '1.5.0', now: true, manual: true }));
  });

  it('another device waits for the owner (428), then may start it once', async () => {
    const a = await app();
    const p = await phone();
    const auth = { Authorization: `Bearer ${p.token}`, 'Content-Type': 'application/json' };
    const first = await a.request('http://127.0.0.1/api/updates/server', { method: 'POST', headers: auth, body: '{}' }, LAN);
    expect(first.status).toBe(428);
    const ask = (await first.json()) as { approvalId: string; code: string };
    expect(startServerUpdate).not.toHaveBeenCalled();
    const { ownerApprovals } = await import('../../security/owner-approvals.js');
    ownerApprovals().decide(ask.code, 'allow', 'telegram');
    const ok = await a.request('http://127.0.0.1/api/updates/server', { method: 'POST', headers: { ...auth, 'X-Mercury-Approval': ask.approvalId }, body: '{}' }, LAN);
    expect(ok.status).toBe(202);
  });

  it('409 while an update runs; 400 when already current or for another version', async () => {
    const a = await app();
    const { readAttachToken, writeAttachToken } = await import('../auth.js');
    writeAttachToken();
    const token = readAttachToken();
    const post = (body: unknown) => a.request('http://127.0.0.1/api/updates/server', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, LOCAL);
    startServerUpdate.mockReturnValue({ ok: false, status: 409, error: 'An update is already running.', job });
    const busy = await post({});
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ job: { id: 'j1' } });
    expect((await post({ version: '9.9.9' })).status).toBe(400);
    serverUpdateStatus.mockResolvedValueOnce({ ...status, updateAvailable: false });
    expect(await (await post({})).json()).toMatchObject({ upToDate: true });
  });
});
