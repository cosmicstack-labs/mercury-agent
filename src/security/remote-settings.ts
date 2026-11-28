import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getMercuryHome } from '../utils/config.js';
import { parseIpRule } from './ip-match.js';

/**
 * The owner's remote-access settings (`/server`, `mercury server`), in
 * `~/.mercury/remote.json`. Read on every remote request (cached by mtime),
 * so a change from the CLI applies at once without a restart.
 */

export interface RemoteSettings {
  /** Remote clients (device tokens, sessions through a tunnel) may connect at all. */
  enabled: boolean;
  /** Client addresses allowed in; empty = any. Needs a proxy that passes the real address. */
  allowIps: string[];
  /** Remote devices may use the terminal (each run still needs the owner's approval). */
  allowShell: boolean;
  /** Most devices that can be paired. */
  maxDevices: number;
  /** A device unused this many days stops working until approved again. 0 = never. */
  idleDays: number;
}

export const DEFAULT_REMOTE: RemoteSettings = { enabled: true, allowIps: [], allowShell: false, maxDevices: 10, idleDays: 30 };

export function remoteSettingsPath(): string {
  return join(getMercuryHome(), 'remote.json');
}

let cache: { mtime: number; path: string; value: RemoteSettings } | null = null;

function normalize(raw: Partial<RemoteSettings>): RemoteSettings {
  const num = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_REMOTE.enabled,
    allowIps: Array.isArray(raw.allowIps) ? [...new Set(raw.allowIps.map((r) => parseIpRule(String(r))).filter((r): r is string => !!r))].slice(0, 100) : [],
    allowShell: raw.allowShell === true,
    maxDevices: num(raw.maxDevices, DEFAULT_REMOTE.maxDevices, 1, 200),
    idleDays: num(raw.idleDays, DEFAULT_REMOTE.idleDays, 0, 3650),
  };
}

export function readRemoteSettings(): RemoteSettings {
  const path = remoteSettingsPath();
  try {
    if (!existsSync(path)) return { ...DEFAULT_REMOTE };
    const mtime = statSync(path).mtimeMs;
    if (cache && cache.path === path && cache.mtime === mtime) return cache.value;
    const value = normalize(JSON.parse(readFileSync(path, 'utf-8')) as Partial<RemoteSettings>);
    cache = { mtime, path, value };
    return value;
  } catch {
    // Unreadable settings: the safe defaults, not "everything allowed".
    return { ...DEFAULT_REMOTE };
  }
}

export function writeRemoteSettings(patch: Partial<RemoteSettings>): RemoteSettings {
  const next = normalize({ ...readRemoteSettings(), ...patch });
  const path = remoteSettingsPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: 'utf-8', mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* best effort */ }
  renameSync(tmp, path);
  cache = null;
  return next;
}
