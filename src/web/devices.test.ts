import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { createDevice, listDevices, revokeDevice, validateDeviceToken, looksLikeDeviceToken, getDevicesPath, _resetDeviceState, normalizeDeviceName } from './devices.js';

/**
 * Device tokens: the credential a remote client (Mercury Desktop, a phone)
 * keeps. Hashed at rest, constant-time compared, revocable one at a time.
 */
describe('device tokens', () => {
  let home: string;
  const previousHome = process.env.MERCURY_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mercury-devices-'));
    process.env.MERCURY_HOME = home;
    _resetDeviceState();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.MERCURY_HOME;
    else process.env.MERCURY_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('creates a token that validates, and stores only its hash', () => {
    const created = createDevice('Office laptop', 'macos');
    expect(created.token).toMatch(/^mdt_[0-9a-f]{8}_[0-9a-f]{64}$/);
    expect(looksLikeDeviceToken(created.token)).toBe(true);

    const device = validateDeviceToken(created.token);
    expect(device?.id).toBe(created.device.id);
    expect(device?.name).toBe('Office laptop');
    expect(device?.platform).toBe('macos');

    const raw = readFileSync(getDevicesPath(), 'utf-8');
    expect(raw).not.toContain(created.token.split('_')[2]);
    if (platform() !== 'win32') {
      expect(statSync(getDevicesPath()).mode & 0o777).toBe(0o600);
    }
  });

  it('rejects a wrong secret, a wrong id and malformed strings', () => {
    const created = createDevice('Phone', 'android');
    const [prefix, id, secret] = created.token.split('_');
    const flipped = secret[0] === 'a' ? 'b' : 'a';
    expect(validateDeviceToken(`${prefix}_${id}_${flipped}${secret.slice(1)}`)).toBeNull();
    expect(validateDeviceToken(`${prefix}_deadbeef_${secret}`)).toBeNull();
    expect(validateDeviceToken('')).toBeNull();
    expect(validateDeviceToken('Bearer x')).toBeNull();
    expect(looksLikeDeviceToken('mdt_short')).toBe(false);
  });

  it('revokes one device without touching the others', () => {
    const a = createDevice('A');
    const b = createDevice('B');
    expect(listDevices().map((d) => d.id).sort()).toEqual([a.device.id, b.device.id].sort());
    expect(revokeDevice(a.device.id)).toBe(true);
    expect(revokeDevice(a.device.id)).toBe(false);
    expect(validateDeviceToken(a.token)).toBeNull();
    expect(validateDeviceToken(b.token)?.id).toBe(b.device.id);
  });

  it('survives a corrupt file by treating it as empty, never by throwing', () => {
    writeFileSync(getDevicesPath(), '{not json', { mode: 0o600 });
    expect(listDevices()).toEqual([]);
    expect(validateDeviceToken('mdt_00000000_' + '0'.repeat(64))).toBeNull();
    const created = createDevice('After corruption');
    expect(validateDeviceToken(created.token)?.id).toBe(created.device.id);
  });

  it('records last-seen on use, at most once a minute', () => {
    const created = createDevice('Laptop');
    expect(listDevices()[0].lastSeenAt).toBeNull();
    validateDeviceToken(created.token);
    const first = listDevices()[0].lastSeenAt;
    expect(first).toBeTruthy();
    validateDeviceToken(created.token);
    expect(listDevices()[0].lastSeenAt).toBe(first);
  });

  it('sanitises names: control characters out, length capped, empty becomes a default', () => {
    expect(normalizeDeviceName('  Office\u0007 laptop ')).toBe('Office laptop');
    expect(normalizeDeviceName('x'.repeat(100))).toHaveLength(64);
    expect(normalizeDeviceName('')).toBe('Unnamed device');
    expect(normalizeDeviceName(undefined)).toBe('Unnamed device');
  });
});
