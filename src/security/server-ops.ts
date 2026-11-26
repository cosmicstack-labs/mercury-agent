import { createDevice, getDevice, listDevices, revokeAllDevices, revokeDevice } from '../web/devices.js';
import { lastPlainHttpRequest, lastRemoteRequest } from '../web/middleware.js';
import { approvalRoutes } from '../web/owner-gate.js';
import { sessionCount } from '../web/auth.js';
import { ownerApprovals } from './owner-approvals.js';
import { readRemoteSettings, writeRemoteSettings, type RemoteSettings } from './remote-settings.js';
import { audit, readAudit } from './audit.js';
import { closeStreams } from './live-streams.js';
import { securityCheck, summarizeFindings } from './check.js';
import { pairCodes, type PairOutcome } from './pair-codes.js';
import { checkHereAnswers, choosePairAddress } from './tunnel.js';
import type { PairStart, ServerOps, ServerStatus } from './server-menu.js';

export async function startPairing(address: string | undefined, by: string): Promise<PairStart> {
  const remote = readRemoteSettings();
  if (!remote.enabled) return { ok: false, reason: 'remote-off', message: "Remote access is off, so a phone can't connect. Turn it on first." };
  const count = listDevices().length;
  if (count >= remote.maxDevices) {
    return { ok: false, reason: 'limit', message: `This Mercury already has ${count} devices (the limit is ${remote.maxDevices}). Revoke one, or raise the limit with /server limit <n>.` };
  }
  const chosen = choosePairAddress(address);
  if (!chosen.ok) return chosen;
  const here = await checkHereAnswers(chosen);
  if (!here.ok) return here;
  return { ok: true, ...pairCodes().create(here.address, by) };
}

/**
 * The /server operations inside the running Mercury (the chat command and
 * the /api/security routes): its own state, directly.
 */
export function localServerOps(opts: { cloudConnected?: () => boolean; by?: string; offline?: boolean } = {}): ServerOps {
  const by = opts.by ?? 'this computer';
  return {
    async status(): Promise<ServerStatus> {
      const findings = securityCheck({ lastRemote: lastRemoteRequest(), lastPlainHttp: lastPlainHttpRequest(), cloudConnected: opts.cloudConnected?.() ?? false });
      return {
        remote: readRemoteSettings(),
        devices: listDevices(),
        browsers: sessionCount(),
        pending: ownerApprovals().pending(),
        approvalRoutes: approvalRoutes(),
        lastRemote: lastRemoteRequest(),
        check: { summary: summarizeFindings(findings), findings },
      };
    },
    async setRemote(patch: Partial<RemoteSettings>) {
      const before = readRemoteSettings();
      const next = writeRemoteSettings(patch);
      const changes = (Object.keys(patch) as Array<keyof RemoteSettings>).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(next[k]));
      if (changes.length) audit('remote.changed', { by, detail: changes.map((k) => `${k}: ${JSON.stringify(next[k])}`).join(', ') });
    },
    async decide(idOrCode, decision) {
      const a = ownerApprovals().decide(idOrCode, decision, by);
      if (a?.kind === 'action') audit(a.status === 'allowed' ? 'action.allowed' : 'action.denied', { who: a.who, ip: a.ip, detail: a.title, by });
      else if (a?.status === 'denied') audit('pair.denied', { who: a.who, ip: a.ip, by });
      return a;
    },
    async createDevice(name) {
      const created = createDevice(name, 'manual', by);
      audit('pair.local', { who: created.device.name, detail: 'token made on this computer' });
      return created;
    },
    async revoke(id) {
      const name = getDevice(id)?.name ?? id;
      if (!revokeDevice(id)) return false;
      closeStreams(`device:${id}`);
      audit('device.revoked', { who: name, by });
      return true;
    },
    async revokeAll() {
      const ids = revokeAllDevices();
      for (const id of ids) closeStreams(`device:${id}`);
      if (ids.length) audit('device.revoked', { who: `${ids.length} devices (all)`, by });
      return ids.length;
    },
    async audit(limit) {
      return readAudit(limit);
    },
    async pair(address) {
      if (opts.offline) {
        return { ok: false, reason: 'not-running', message: "Mercury isn't running, and a phone pairs with the running Mercury. Start it with mercury start, then run mercury server pair again." };
      }
      return startPairing(address, by);
    },
    waitPair: (id) => pairCodes().wait(id),
    async cancelPair() {
      pairCodes().cancel();
    },
  };
}

/**
 * The same operations from another process on this computer (`mercury
 * server` while Mercury runs): through its API, with the local attach token.
 */
export function httpServerOps(base: string, token: string): ServerOps {
  const call = async <T>(path: string, init: RequestInit = {}, accept: number[] = [410]): Promise<T> => {
    const res = await fetch(`${base}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
    const body = await res.json().catch(() => ({})) as T & { error?: string };
    if (!res.ok && !accept.includes(res.status)) throw new Error(body.error ?? `Mercury answered ${res.status}`);
    return body;
  };
  return {
    status: () => call<ServerStatus>('/api/security/status'),
    async setRemote(patch) { await call('/api/security/remote', { method: 'PUT', body: JSON.stringify(patch) }); },
    async decide(idOrCode, decision) {
      const r = await call<{ approval?: import('./owner-approvals.js').OwnerApproval }>(`/api/security/approvals/${encodeURIComponent(idOrCode)}`, { method: 'POST', body: JSON.stringify({ decision, by: 'cli' }) });
      return r.approval ?? null;
    },
    createDevice: (name) => call('/api/security/devices', { method: 'POST', body: JSON.stringify({ name }) }),
    async revoke(id) { await call(`/api/security/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }); return true; },
    async revokeAll() { return (await call<{ revoked: number }>('/api/security/devices', { method: 'DELETE' })).revoked; },
    async audit(limit) { return (await call<{ entries: import('./audit.js').AuditEntry[] }>(`/api/security/audit?limit=${limit}`)).entries; },
    pair: (address) => call<PairStart>('/api/security/pair', { method: 'POST', body: JSON.stringify({ address, by: 'cli' }) }, [409]),
    async waitPair(id) {
      for (;;) {
        const r = await call<PairOutcome | { status: 'waiting' }>(`/api/security/pair/${encodeURIComponent(id)}`);
        if (r.status !== 'waiting') return r;
      }
    },
    async cancelPair() { await call('/api/security/pair', { method: 'DELETE' }); },
  };
}
