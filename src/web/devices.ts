import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getMercuryHome } from '../utils/config.js';

/**
 * Device tokens — long-lived bearer credentials for clients that are not on
 * this machine's loopback: Mercury Desktop on another computer, a phone,
 * a script on a server. One token per device, revocable one at a time.
 *
 * Why not the web session? Sessions live in memory, die with the process and
 * are cookie-shaped; a desktop app needs something it can keep in the OS
 * keychain and present as `Authorization: Bearer` from any address.
 *
 * Why not the attach token? That one is a per-boot, loopback-only secret
 * for `mercury attach` and must stay that way.
 *
 * Storage: `~/.mercury/devices.json`, owner-only, holding only a SHA-256 of
 * each secret. The plaintext token is shown exactly once, at creation.
 *
 * Token shape: `mdt_<id>_<secret>` — `mdt` = Mercury device token, the id
 * selects the record (so lookup is O(1) and the hash compare is constant
 * time), the secret is 32 random bytes.
 */

export interface DeviceRecord {
  id: string;
  name: string;
  /** Free-form: "macos", "windows", "linux", "android", "ios", "script". */
  platform: string;
  tokenHash: string;
  createdAt: string;
  lastSeenAt: string | null;
}

export interface DeviceSummary {
  id: string;
  name: string;
  platform: string;
  createdAt: string;
  lastSeenAt: string | null;
}

interface DevicesFile {
  version: 1;
  devices: DeviceRecord[];
}

const FILE_NAME = 'devices.json';
const TOKEN_PREFIX = 'mdt';
const TOKEN_RE = /^mdt_([0-9a-f]{8})_([0-9a-f]{64})$/;
/** How often `lastSeenAt` is written back — once a minute per device is plenty. */
const LAST_SEEN_WRITE_INTERVAL_MS = 60_000;

const lastSeenWrites = new Map<string, number>();

export function getDevicesPath(): string {
  return join(getMercuryHome(), FILE_NAME);
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

function readFile(): DevicesFile {
  const path = getDevicesPath();
  if (!existsSync(path)) return { version: 1, devices: [] };
  try {
    // Repair permissions on a file a previous version might have left 0644.
    try { chmodSync(path, 0o600); } catch { /* best effort */ }
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<DevicesFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.devices)) return { version: 1, devices: [] };
    return { version: 1, devices: parsed.devices.filter(isRecord) };
  } catch {
    return { version: 1, devices: [] };
  }
}

function isRecord(value: unknown): value is DeviceRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && typeof v.name === 'string' && typeof v.tokenHash === 'string';
}

function writeFile(data: DevicesFile): void {
  const home = getMercuryHome();
  if (!existsSync(home)) mkdirSync(home, { recursive: true });
  const path = getDevicesPath();
  // Write-then-rename so a crash mid-write never leaves a truncated file
  // (which would silently revoke every device).
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* best effort */ }
  renameSync(tmp, path);
}

export function listDevices(): DeviceSummary[] {
  return readFile().devices.map(toSummary);
}

function toSummary(d: DeviceRecord): DeviceSummary {
  return { id: d.id, name: d.name, platform: d.platform, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt };
}

export interface CreatedDevice {
  device: DeviceSummary;
  /** The plaintext token. Shown once; never stored. */
  token: string;
}

const MAX_NAME_LENGTH = 64;
const MAX_DEVICES = 200;

export function normalizeDeviceName(name: unknown): string {
  // eslint-disable-next-line no-control-regex -- strips control characters on purpose
  const trimmed = String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (trimmed || 'Unnamed device').slice(0, MAX_NAME_LENGTH);
}

export function normalizePlatform(platform: unknown): string {
  const p = String(platform ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24);
  return p || 'unknown';
}

export function createDevice(name: unknown, platform?: unknown): CreatedDevice {
  const data = readFile();
  if (data.devices.length >= MAX_DEVICES) {
    throw new Error(`Too many devices (${MAX_DEVICES}); revoke one first`);
  }
  let id = randomBytes(4).toString('hex');
  while (data.devices.some((d) => d.id === id)) id = randomBytes(4).toString('hex');
  const secret = randomBytes(32).toString('hex');
  const record: DeviceRecord = {
    id,
    name: normalizeDeviceName(name),
    platform: normalizePlatform(platform),
    tokenHash: hashSecret(secret),
    createdAt: new Date().toISOString(),
    lastSeenAt: null,
  };
  data.devices.push(record);
  writeFile(data);
  return { device: toSummary(record), token: `${TOKEN_PREFIX}_${id}_${secret}` };
}

export function revokeDevice(id: string): boolean {
  const data = readFile();
  const before = data.devices.length;
  data.devices = data.devices.filter((d) => d.id !== id);
  if (data.devices.length === before) return false;
  writeFile(data);
  lastSeenWrites.delete(id);
  return true;
}

/** True when the string has the device-token shape (cheap pre-check; no I/O). */
export function looksLikeDeviceToken(token: string): boolean {
  return TOKEN_RE.test(token);
}

/**
 * Resolve a bearer token to its device, or null. Constant-time on the
 * secret; the id lookup is by equality, which only reveals whether an id
 * exists — ids are not secret.
 */
export function validateDeviceToken(token: string): DeviceSummary | null {
  const match = TOKEN_RE.exec(token);
  if (!match) return null;
  const [, id, secret] = match;
  const data = readFile();
  const record = data.devices.find((d) => d.id === id);
  if (!record) return null;
  const expected = Buffer.from(record.tokenHash, 'hex');
  const actual = Buffer.from(hashSecret(secret), 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  touchLastSeen(data, record);
  return toSummary(record);
}

function touchLastSeen(data: DevicesFile, record: DeviceRecord): void {
  const now = Date.now();
  const last = lastSeenWrites.get(record.id) ?? 0;
  if (now - last < LAST_SEEN_WRITE_INTERVAL_MS) return;
  lastSeenWrites.set(record.id, now);
  record.lastSeenAt = new Date(now).toISOString();
  try { writeFile(data); } catch { /* best effort: last-seen is cosmetic */ }
}

/** Test hook: forget write throttling between cases. */
export function _resetDeviceState(): void {
  lastSeenWrites.clear();
}
