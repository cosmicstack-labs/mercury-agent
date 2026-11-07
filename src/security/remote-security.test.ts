import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ipAllowed, ipMatches, parseIpRule } from './ip-match.js';
import { OwnerApprovals, _setOwnerApprovals, ownerApprovals } from './owner-approvals.js';
import { closeStreams, trackStream } from './live-streams.js';
import { readRemoteSettings, writeRemoteSettings } from './remote-settings.js';
import { parseApprovalReply, isOwnerSender } from './approval-messages.js';
import { commandTouchesMercuryCredentials, isMercuryCredentialPath, protectedReason, realInside } from './protected-paths.js';

const LOCAL = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };
const LAN = { incoming: { socket: { remoteAddress: '192.168.1.20' } } };

let home: string;
const previous = process.env.MERCURY_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mercury-sec-'));
  process.env.MERCURY_HOME = home;
  _setOwnerApprovals(new OwnerApprovals());
});
afterEach(() => {
  if (previous === undefined) delete process.env.MERCURY_HOME; else process.env.MERCURY_HOME = previous;
  rmSync(home, { recursive: true, force: true });
});

async function app() {
  const { authGuard } = await import('../web/middleware.js');
  const { requireOwner } = await import('../web/owner-gate.js');
  const { default: security } = await import('../web/api/security.js');
  const a = new Hono();
  a.use('*', authGuard);
  a.route('/', security);
  a.get('/api/ping', (c) => c.json({ ok: true }));
  a.post('/api/danger', (c) => requireOwner(c, { id: 'test.danger', title: 'Do the dangerous thing' }) ?? c.json({ done: true }));
  return a;
}

async function device(name = 'Phone') {
  const { createDevice, _resetDeviceState } = await import('../web/devices.js');
  _resetDeviceState();
  return createDevice(name, 'ios');
}

const bearer = (token: string, extra: Record<string, string> = {}) => ({ headers: { Authorization: `Bearer ${token}`, ...extra } });

describe('where a request comes from', () => {
  it('a tunnel on this machine is remote, whatever the socket says', async () => {
    const a = await app();
    const { token } = await device();
    const { writeAttachToken, readAttachToken } = await import('../web/auth.js');
    writeAttachToken();
    const attach = readAttachToken()!;
    // Straight from this machine with the attach token: this computer.
    expect((await a.request('http://127.0.0.1:6174/api/security/status', bearer(attach), LOCAL)).status).toBe(200);
    // The same token through a tunnel (Tailscale Serve, cloudflared add these headers): not honoured.
    const tunneled = await a.request('http://127.0.0.1:6174/api/security/status', bearer(attach, { 'X-Forwarded-For': '203.0.113.9', Host: 'mercury.tail1234.ts.net' }), LOCAL);
    expect(tunneled.status).toBe(401);
    // A device through the tunnel is a remote device: the owner's settings are off limits.
    const remote = await a.request('http://127.0.0.1:6174/api/security/status', bearer(token, { 'X-Forwarded-For': '203.0.113.9' }), LOCAL);
    expect(remote.status).toBe(403);
    expect(((await remote.json()) as { thisComputerOnly: boolean }).thisComputerOnly).toBe(true);
  });

  it('refuses a page that reached this machine under another name (DNS rebinding)', async () => {
    const a = await app();
    const res = await a.request('http://evil.example:6174/api/ping', { headers: { Host: 'evil.example:6174' } }, LOCAL);
    expect(res.status).toBe(421);
  });
});

describe('remote access switch and allow-list', () => {
  it('turning remote access off shuts out devices, never this computer', async () => {
    const a = await app();
    const { token } = await device();
    expect((await a.request('http://127.0.0.1/api/ping', bearer(token), LAN)).status).toBe(200);
    writeRemoteSettings({ enabled: false });
    const off = await a.request('http://127.0.0.1/api/ping', bearer(token), LAN);
    expect(off.status).toBe(403);
    expect(((await off.json()) as { remoteOff: boolean }).remoteOff).toBe(true);
    // Sign-in from outside is closed too.
    expect((await a.request('http://127.0.0.1/api/auth/token', { method: 'POST' }, LAN)).status).toBe(403);
    const { writeAttachToken, readAttachToken } = await import('../web/auth.js');
    writeAttachToken();
    expect((await a.request('http://127.0.0.1/api/ping', bearer(readAttachToken()!), LOCAL)).status).toBe(200);
  });

  it('lets in only listed addresses, and fails closed when the tunnel hides the address', async () => {
    const a = await app();
    const { token } = await device();
    writeRemoteSettings({ allowIps: ['100.64.0.0/10'] });
    expect((await a.request('http://127.0.0.1/api/ping', bearer(token, { 'X-Forwarded-For': '100.101.2.3' }), LOCAL)).status).toBe(200);
    expect((await a.request('http://127.0.0.1/api/ping', bearer(token, { 'X-Forwarded-For': '203.0.113.9' }), LOCAL)).status).toBe(403);
    // Only the right-most X-Forwarded-For entry (the one this machine's proxy added) counts.
    expect((await a.request('http://127.0.0.1/api/ping', bearer(token, { 'X-Forwarded-For': '100.101.2.3, 203.0.113.9' }), LOCAL)).status).toBe(403);
    expect((await a.request('http://127.0.0.1/api/ping', bearer(token, { 'Tailscale-User-Login': 'someone@example.com' }), LOCAL)).status).toBe(403);
  });

  it('keeps settings sane whatever is in the file', () => {
    writeFileSync(join(home, 'remote.json'), JSON.stringify({ enabled: 'yes', allowIps: ['1.2.3.4', 'nonsense', '10.0.0.0/8'], maxDevices: 9999, idleDays: -5 }));
    expect(readRemoteSettings()).toEqual({ enabled: true, allowIps: ['1.2.3.4', '10.0.0.0/8'], allowShell: false, maxDevices: 200, idleDays: 0 });
    writeFileSync(join(home, 'remote.json'), '{ broken');
    expect(readRemoteSettings().enabled).toBe(true);
  });
});

describe('the owner approves sensitive actions from other devices', () => {
  it('428 with a code, then works once with the approval, for that device only', async () => {
    const a = await app();
    const phone = await device('Phone');
    const laptop = await device('Laptop');
    const first = await a.request('http://127.0.0.1/api/danger', { method: 'POST', ...bearer(phone.token) }, LAN);
    expect(first.status).toBe(428);
    const ask = (await first.json()) as { approvalId: string; code: string };
    // The asking device can't answer its own question.
    const self = await a.request(`http://127.0.0.1/api/security/approvals/${ask.approvalId}`, { method: 'POST', ...bearer(phone.token), body: JSON.stringify({ decision: 'allow' }) }, LAN);
    expect(self.status).toBe(403);
    // It can see how its question stands.
    const st = await a.request(`http://127.0.0.1/api/security/approvals/${ask.approvalId}/status`, bearer(phone.token), LAN);
    expect(((await st.json()) as { status: string }).status).toBe('pending');
    // Another device can't use it.
    expect((await a.request(`http://127.0.0.1/api/security/approvals/${ask.approvalId}/status`, bearer(laptop.token), LAN)).status).toBe(404);
    ownerApprovals().decide(ask.code, 'allow', 'telegram');
    expect((await a.request('http://127.0.0.1/api/danger', { method: 'POST', ...bearer(laptop.token, { 'X-Mercury-Approval': ask.approvalId }) }, LAN)).status).toBe(428);
    const ok = await a.request('http://127.0.0.1/api/danger', { method: 'POST', ...bearer(phone.token, { 'X-Mercury-Approval': ask.approvalId }) }, LAN);
    expect(ok.status).toBe(200);
    // Once.
    expect((await a.request('http://127.0.0.1/api/danger', { method: 'POST', ...bearer(phone.token, { 'X-Mercury-Approval': ask.approvalId }) }, LAN)).status).toBe(428);
  });

  it("asking again reuses the waiting question, and a device can't flood the owner", async () => {
    const a = await app();
    const phone = await device();
    const sent: string[] = [];
    ownerApprovals().onChange((q, change) => { if (change === 'new') sent.push(q.id); });
    const one = (await (await a.request('http://127.0.0.1/api/danger', { method: 'POST', ...bearer(phone.token) }, LAN)).json()) as { approvalId: string };
    const two = (await (await a.request('http://127.0.0.1/api/danger', { method: 'POST', ...bearer(phone.token) }, LAN)).json()) as { approvalId: string };
    expect(two.approvalId).toBe(one.approvalId);
    expect(sent).toHaveLength(1);
    const { requireOwner } = await import('../web/owner-gate.js');
    const b = new Hono();
    const { authGuard } = await import('../web/middleware.js');
    b.use('*', authGuard);
    b.post('/api/x/:n', (c) => requireOwner(c, { id: `x.${c.req.param('n')}`, title: 'x' }) ?? c.json({}));
    expect((await b.request('http://127.0.0.1/api/x/1', { method: 'POST', ...bearer(phone.token) }, LAN)).status).toBe(428);
    expect((await b.request('http://127.0.0.1/api/x/2', { method: 'POST', ...bearer(phone.token) }, LAN)).status).toBe(428);
    expect((await b.request('http://127.0.0.1/api/x/3', { method: 'POST', ...bearer(phone.token) }, LAN)).status).toBe(429);
    expect(sent).toHaveLength(3);
  });

  it('a denial is a 403 that says so; on this computer nothing is asked', async () => {
    const a = await app();
    const phone = await device();
    const ask = (await (await a.request('http://127.0.0.1/api/danger', { method: 'POST', ...bearer(phone.token) }, LAN)).json()) as { approvalId: string; code: string };
    ownerApprovals().decide(ask.approvalId, 'deny', 'cli');
    const denied = await a.request('http://127.0.0.1/api/danger', { method: 'POST', ...bearer(phone.token, { 'X-Mercury-Approval': ask.approvalId }) }, LAN);
    expect(denied.status).toBe(403);
    const { writeAttachToken, readAttachToken } = await import('../web/auth.js');
    writeAttachToken();
    expect((await a.request('http://127.0.0.1/api/danger', { method: 'POST', ...bearer(readAttachToken()!) }, LOCAL)).status).toBe(200);
  });

  it('questions expire as "no"', async () => {
    let now = 1_000;
    const ap = new OwnerApprovals(() => now);
    const q = ap.request({ kind: 'pair', title: 'New device', who: 'Phone' }, 60_000);
    now += 61_000;
    expect(ap.decide(q.code, 'allow', 'cli')).toBeNull();
  });
});

describe('device tokens', () => {
  it('an unused device expires (and says so); devices from before the upgrade keep working', async () => {
    const a = await app();
    const { token, device: d } = await device();
    writeRemoteSettings({ idleDays: 30 });
    const file = join(home, 'devices.json');
    const data = JSON.parse((await import('node:fs')).readFileSync(file, 'utf-8'));
    const long = new Date(Date.now() - 40 * 86_400_000).toISOString();
    data.devices[0] = { ...data.devices[0], createdAt: long, lastSeenAt: long, idleSince: undefined };
    writeFileSync(file, JSON.stringify(data));
    const { migrateDevices } = await import('../web/devices.js');
    expect(migrateDevices()).toBe(1); // the old device's clock starts now
    expect((await a.request('http://127.0.0.1/api/ping', bearer(token), LAN)).status).toBe(200);
    // Forty days later, unused: expired.
    const again = JSON.parse((await import('node:fs')).readFileSync(file, 'utf-8'));
    again.devices[0] = { ...again.devices[0], lastSeenAt: long, idleSince: long };
    writeFileSync(file, JSON.stringify(again));
    const res = await a.request('http://127.0.0.1/api/ping', bearer(token), LAN);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { expired: boolean }).expired).toBe(true);
    const { listDevices } = await import('../web/devices.js');
    expect(listDevices().find((x) => x.id === d.id)).toBeUndefined();
  });

  it('respects the device limit', async () => {
    writeRemoteSettings({ maxDevices: 1 });
    await device('One');
    await expect(device('Two')).rejects.toThrow(/limit is 1/);
  });

  it('revoking closes the live streams of that device only', () => {
    let a = 0; let b = 0;
    trackStream('device:aaaa0000', () => { a++; });
    trackStream('device:aaaa0000', () => { a++; });
    trackStream('device:bbbb0000', () => { b++; });
    expect(closeStreams('device:aaaa0000')).toBe(2);
    expect([a, b]).toEqual([2, 0]);
    expect(closeStreams('device:aaaa0000')).toBe(0);
  });
});

describe('files', () => {
  it("Mercury's credentials are never reachable; remote devices also can't reach keys", () => {
    expect(protectedReason(join(home, 'devices.json'), false)).toMatch(/credentials/);
    expect(protectedReason(join(home, 'security', 'audit.jsonl'), false)).toMatch(/credentials/);
    expect(protectedReason(join(home, 'notes.md'), false)).toBeNull();
    expect(protectedReason(join((process.env.HOME ?? '/'), '.ssh', 'id_ed25519'), true)).toMatch(/Keys/);
    expect(protectedReason(join((process.env.HOME ?? '/'), '.ssh', 'id_ed25519'), false)).toBeNull();
  });

  it("a symlink inside the workspace doesn't reach outside it", () => {
    const ws = join(home, 'ws');
    mkdirSync(ws);
    mkdirSync(join(home, 'outside'));
    writeFileSync(join(home, 'outside', 'secret.txt'), 'x');
    symlinkSync(join(home, 'outside'), join(ws, 'link'));
    expect(realInside(join(ws, 'link', 'secret.txt'), ws)).toBe(false);
    expect(realInside(join(ws, 'new-file.txt'), ws)).toBe(true);
  });

  it("Mercury's own tools can't read or name its login files", () => {
    expect(isMercuryCredentialPath(join(home, 'attach-token'))).toBe(true);
    expect(isMercuryCredentialPath(join(home, 'mercury.yaml'))).toBe(false);
    expect(commandTouchesMercuryCredentials(`cat ${home}/devices.json`)).toBe(true);
    expect(commandTouchesMercuryCredentials('cat ~/.mercury/web-sessions.json')).toBe(true);
    expect(commandTouchesMercuryCredentials('ls ~/.mercury/bots')).toBe(false);
  });
});

describe('answers from a messaging channel', () => {
  it('reads "approve CODE" / "deny CODE", from the owner only', () => {
    expect(parseApprovalReply('approve k7q2m')).toEqual({ decision: 'allow', code: 'K7Q2M' });
    expect(parseApprovalReply('  Deny K7Q2M. ')).toEqual({ decision: 'deny', code: 'K7Q2M' });
    expect(parseApprovalReply('approve the plan')).toBeNull();
    expect(parseApprovalReply('please approve K7Q2M now')).toBeNull();
    const base = { id: '1', channelId: 'telegram:1', channelType: 'telegram' as const, senderId: '1', content: '', timestamp: 0 };
    expect(isOwnerSender({ ...base, senderRole: 'admin' })).toBe(true);
    expect(isOwnerSender({ ...base, senderRole: 'member' })).toBe(false);
    expect(isOwnerSender({ ...base, metadata: { isAdmin: true } })).toBe(true);
    expect(isOwnerSender({ ...base })).toBe(false);
  });
});

describe('addresses', () => {
  it('matches single addresses and ranges, v4 and v6', () => {
    expect(parseIpRule('203.0.113.7')).toBe('203.0.113.7');
    expect(parseIpRule('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(parseIpRule('10.0.0.0/33')).toBeNull();
    expect(parseIpRule('nope')).toBeNull();
    expect(ipMatches('100.101.2.3', '100.64.0.0/10')).toBe(true);
    expect(ipMatches('100.128.0.1', '100.64.0.0/10')).toBe(false);
    expect(ipMatches('2001:db8::1', '2001:db8::/32')).toBe(true);
    expect(ipMatches('2001:db9::1', '2001:db8::/32')).toBe(false);
    expect(ipMatches('::ffff:10.1.2.3', '10.0.0.0/8')).toBe(true);
    expect(ipAllowed('1.2.3.4', ['5.6.7.8', '1.2.3.4'])).toBe(true);
    expect(ipAllowed('1.2.3.4', [])).toBe(false);
  });
});
