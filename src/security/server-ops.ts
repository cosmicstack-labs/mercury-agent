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
import { checkAddress, checkHereAnswers, choosePairAddress, configuredPublicUrl, reachesMercury, refreshTailscale } from './tunnel.js';
import { getWebPort } from '../web/auth.js';
import { updateConfig } from '../utils/config.js';
import type { AddressResult, PairStart, PhoneAddress, ServerOps, ServerStatus } from './server-menu.js';

export async function startPairing(address: string | undefined, by: string): Promise<PairStart> {
  const remote = readRemoteSettings();
  if (!remote.enabled) return { ok: false, reason: 'remote-off', message: "Remote access is off, so a phone can't connect. Turn it on first." };
  const count = listDevices().length;
  if (count >= remote.maxDevices) {
    return { ok: false, reason: 'limit', message: `This Mercury already has ${count} devices (the limit is ${remote.maxDevices}). Revoke one, or raise the limit with /server limit <n>.` };
  }
  await refreshTailscale({ port: getWebPort() });
  const chosen = choosePairAddress(address);
  if (!chosen.ok) return chosen;
  const here = await checkHereAnswers(chosen);
  if (!here.ok) return here;
  return { ok: true, ...pairCodes().create(here.address, by) };
}

/** The address the QR code carries: the one the owner saved, else Tailscale Serve's. */
export async function phoneAddressStatus(): Promise<PhoneAddress> {
  await refreshTailscale({ port: getWebPort() });
  const saved = configuredPublicUrl();
  const chosen = choosePairAddress();
  return chosen.ok
    ? { saved, address: chosen.address, source: chosen.source === 'tailscale' ? 'tailscale' : 'saved', problem: null }
    : { saved, address: null, source: null, problem: chosen.message };
}

const AUTOMATIC = new Set(['', 'auto', 'automatic', 'clear', 'off', 'none']);

/**
 * Save the address phones open Mercury at (web.publicUrl), after checking it:
 * https (or plain http inside your own network), not this computer only, and,
 * while Mercury runs, that it really leads back to this Mercury.
 */
export async function savePhoneAddress(input: string | null, opts: { live: boolean; by?: string }): Promise<AddressResult> {
  const by = opts.by ?? 'this computer';
  if (input === null || AUTOMATIC.has(input.trim().toLowerCase())) {
    updateConfig((c) => { if (c.web) delete c.web.publicUrl; });
    audit('remote.changed', { by, detail: 'phone address: automatic' });
    return { ok: true, address: null, message: 'Phone address cleared. Mercury will use Tailscale Serve if it finds it.' };
  }
  const port = getWebPort();
  const checked = checkAddress(input, 'given', port);
  if (!checked.ok) return { ok: false, address: null, message: checked.message };
  const here = await checkHereAnswers(checked);
  if (!here.ok) return { ok: false, address: null, message: here.message };
  const address = here.address;
  let note = '';
  if (opts.live) {
    const reach = await reachesMercury(address);
    if (reach === 'other') {
      return { ok: false, address: null, message: `${address} answers, but not as this Mercury. Point the tunnel at http://127.0.0.1:${port} and try again.` };
    }
    if (reach === 'unreachable') note = ` Mercury couldn't open ${address} from this computer, so check that the tunnel is running; a phone may still reach it.`;
  } else {
    note = " Mercury isn't running, so the address wasn't tested.";
  }
  updateConfig((c) => { c.web = { ...(c.web ?? {}), publicUrl: address } as typeof c.web; });
  audit('remote.changed', { by, detail: `phone address: ${address}` });
  return { ok: true, address, message: `✓ Phone address saved: ${address}. Pairing QR codes use it.${note}` };
}

/**
 * The /server operations inside the running Mercury (the chat command and
 * the /api/security routes): its own state, directly.
 */
export function localServerOps(opts: { cloudConnected?: () => boolean; by?: string; offline?: boolean } = {}): ServerOps {
  const by = opts.by ?? 'this computer';
  return {
    async status(): Promise<ServerStatus> {
      const phone = await phoneAddressStatus();
      const findings = securityCheck({ lastRemote: lastRemoteRequest(), lastPlainHttp: lastPlainHttpRequest(), cloudConnected: opts.cloudConnected?.() ?? false });
      return {
        remote: readRemoteSettings(),
        devices: listDevices(),
        browsers: sessionCount(),
        pending: ownerApprovals().pending(),
        approvalRoutes: approvalRoutes(),
        lastRemote: lastRemoteRequest(),
        check: { summary: summarizeFindings(findings), findings },
        phone,
      };
    },
    setAddress: (address) => savePhoneAddress(address, { live: !opts.offline, by }),
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
    setAddress: (address) => call<AddressResult>('/api/security/address', { method: 'PUT', body: JSON.stringify({ address, by: 'cli' }) }, [400]),
  };
}
