import { Hono } from 'hono';
import { createDevice, getDevice, listDevices, revokeAllDevices, revokeDevice } from '../devices.js';
import { authenticateRequest, isThisComputer, lastRemoteRequest, principalKey } from '../middleware.js';
import { approvalRoutes } from '../owner-gate.js';
import { ownerApprovals } from '../../security/owner-approvals.js';
import { readRemoteSettings, writeRemoteSettings, type RemoteSettings } from '../../security/remote-settings.js';
import { parseIpRule } from '../../security/ip-match.js';
import { audit, readAudit } from '../../security/audit.js';
import { closeStreams } from '../../security/live-streams.js';
import { securityCheck, summarizeFindings } from '../../security/check.js';
import { sessionCount } from '../auth.js';

/**
 * Remote access and its security, for the owner on this computer (`/server`,
 * `mercury server`, Mercury Desktop's Security settings). Everything here
 * works only from this computer, except one read: a device waiting for the
 * owner can ask how its own question stands.
 *
 *   GET    /api/security/status                  settings, devices, waiting questions, last remote request, check
 *   PUT    /api/security/remote                  { enabled?, allowIps?, allowShell?, maxDevices?, idleDays? }
 *   GET    /api/security/approvals               questions waiting for the owner
 *   POST   /api/security/approvals/:id           { decision: "allow" | "deny" } (id or code)
 *   GET    /api/security/approvals/:id/status    the asking device's own question
 *   POST   /api/security/devices                 { name } → a new token, shown once
 *   DELETE /api/security/devices/:id | /devices  revoke one / all
 *   GET    /api/security/audit?limit=            the security log, newest first
 *   GET    /api/security/check                   the security check
 */

let cloudConnected: () => boolean = () => false;
export function setSecurityCloudState(fn: () => boolean): void { cloudConnected = fn; }

const security = new Hono();

security.use('/api/security/*', async (c, next) => {
  if (/\/approvals\/[^/]+\/status$/.test(new URL(c.req.url).pathname)) return next();
  if (!isThisComputer(c)) return c.json({ error: 'Remote access settings can only be changed on the computer Mercury runs on.', thisComputerOnly: true }, 403);
  return next();
});

function status() {
  const findings = securityCheck({ lastRemote: lastRemoteRequest(), cloudConnected: cloudConnected() });
  return {
    remote: readRemoteSettings(),
    devices: listDevices(),
    browsers: sessionCount(),
    pending: ownerApprovals().pending(),
    approvalRoutes: approvalRoutes(),
    lastRemote: lastRemoteRequest(),
    check: { summary: summarizeFindings(findings), findings },
  };
}

security.get('/api/security/status', (c) => c.json(status()));

security.put('/api/security/remote', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Partial<RemoteSettings>;
  const patch: Partial<RemoteSettings> = {};
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
  if (typeof body.allowShell === 'boolean') patch.allowShell = body.allowShell;
  if (typeof body.maxDevices === 'number') patch.maxDevices = body.maxDevices;
  if (typeof body.idleDays === 'number') patch.idleDays = body.idleDays;
  if (Array.isArray(body.allowIps)) {
    const bad = body.allowIps.find((r) => !parseIpRule(String(r)));
    if (bad !== undefined) return c.json({ error: `“${bad}” is not an address or range (e.g. 203.0.113.7 or 100.64.0.0/10).` }, 400);
    patch.allowIps = body.allowIps.map(String);
  }
  const before = readRemoteSettings();
  const next = writeRemoteSettings(patch);
  const changes = (Object.keys(patch) as Array<keyof RemoteSettings>).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(next[k]));
  if (changes.length) audit('remote.changed', { by: 'this computer', detail: changes.map((k) => `${k}: ${JSON.stringify(next[k])}`).join(', ') });
  return c.json(status());
});

security.get('/api/security/approvals', (c) => c.json({ pending: ownerApprovals().pending(), routes: approvalRoutes() }));

security.post('/api/security/approvals/:id', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { decision?: unknown; by?: unknown };
  if (body.decision !== 'allow' && body.decision !== 'deny') return c.json({ error: 'decision must be "allow" or "deny"' }, 400);
  const by = typeof body.by === 'string' && /^[a-z -]{2,20}$/i.test(body.by) ? body.by : 'this computer';
  const a = ownerApprovals().decide(c.req.param('id'), body.decision, by);
  if (!a) return c.json({ error: 'That question was already answered or has expired.' }, 410);
  if (a.kind === 'action') audit(a.status === 'allowed' ? 'action.allowed' : 'action.denied', { who: a.who, ip: a.ip, detail: a.title, by });
  else if (a.status === 'denied') audit('pair.denied', { who: a.who, ip: a.ip, by });
  return c.json({ approval: a });
});

/** The asking device follows its own question (and only its own). */
security.get('/api/security/approvals/:id/status', (c) => {
  const a = ownerApprovals().get(c.req.param('id'));
  const me = principalKey(authenticateRequest(c));
  if (!a || a.kind !== 'action' || a.scope?.principal !== me) return c.json({ status: 'expired' }, 404);
  return c.json({ status: a.status, code: a.code, expiresAt: a.expiresAt });
});

security.post('/api/security/devices', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { name?: unknown; platform?: unknown };
  try {
    const created = createDevice(body.name, body.platform ?? 'manual', 'this computer');
    audit('pair.local', { who: created.device.name, detail: 'token made on this computer' });
    return c.json(created);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Could not create the device' }, 409);
  }
});

security.delete('/api/security/devices/:id', (c) => {
  const id = c.req.param('id');
  const name = getDevice(id)?.name ?? id;
  if (!revokeDevice(id)) return c.json({ error: 'No such device' }, 404);
  closeStreams(`device:${id}`);
  audit('device.revoked', { who: name, by: 'this computer' });
  return c.json({ success: true });
});

security.delete('/api/security/devices', (c) => {
  const ids = revokeAllDevices();
  for (const id of ids) closeStreams(`device:${id}`);
  if (ids.length) audit('device.revoked', { who: `${ids.length} devices (all)`, by: 'this computer' });
  return c.json({ revoked: ids.length });
});

security.get('/api/security/audit', (c) => c.json({ entries: readAudit(Math.min(500, Math.max(1, Number(c.req.query('limit')) || 50))) }));

security.get('/api/security/check', (c) => {
  const findings = securityCheck({ lastRemote: lastRemoteRequest(), cloudConnected: cloudConnected() });
  return c.json({ summary: summarizeFindings(findings), findings });
});

export default security;
