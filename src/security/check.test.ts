import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gwsFindings } from './check.js';

let home: string;
let bin: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mercury-gws-home-'));
  bin = join(home, 'bin');
  mkdirSync(bin);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function gwsDir(...parts: string[]): string {
  const dir = join(home, ...parts);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function installGws(platform: NodeJS.Platform): void {
  const file = join(bin, platform === 'win32' ? 'gws.exe' : 'gws');
  writeFileSync(file, '');
  chmodSync(file, 0o755);
}

function check(platform: NodeJS.Platform, env: NodeJS.ProcessEnv = {}) {
  return gwsFindings({ home, platform, env, serviceDirs: [bin], mercuryBinDir: join(home, 'mercury-gws-bin') });
}

describe('mercury doctor --security: gws', () => {
  it('says nothing when gws was never set up', () => {
    installGws('linux');
    expect(check('linux')).toEqual([]);
  });

  it('is ok when the sign-in is encrypted and the service can find gws', () => {
    writeFileSync(join(gwsDir('.config', 'gws'), 'credentials.enc'), 'x');
    installGws('linux');
    expect(check('linux')).toEqual([{ level: 'ok', title: 'gws keeps your Google sign-in encrypted, and the service can find it' }]);
  });

  it('flags a plaintext sign-in as a risk', () => {
    const plain = join(gwsDir('.config', 'gws'), 'credentials.json');
    writeFileSync(plain, '{}');
    installGws('linux');
    const findings = check('linux');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ level: 'risk', detail: plain });
    expect(findings[0].fix).toContain('gws auth login');
  });

  it('warns about a key file on macOS and Windows, where gws normally uses the keychain', () => {
    writeFileSync(join(gwsDir('.config', 'gws'), '.encryption_key'), 'k');
    for (const platform of ['darwin', 'win32'] as const) {
      installGws(platform);
      expect(check(platform).map((f) => f.level)).toEqual(['warn']);
      expect(check(platform)[0].fix).toContain('GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND');
    }
    installGws('linux');
    expect(check('linux').map((f) => f.level)).toEqual(['ok']);
  });

  it("warns when the service can't find gws, with a fix for the platform", () => {
    gwsDir('.config', 'gws');
    const linux = check('linux');
    expect(linux).toHaveLength(1);
    expect(linux[0]).toMatchObject({ level: 'warn', title: "Mercury's background service can't find gws" });
    expect(linux[0].fix).toContain('/usr/local/bin/gws');
    expect(check('win32')[0].fix).toContain('gws.exe');
  });

  it('counts the gws Mercury installed as found by the service', () => {
    writeFileSync(join(gwsDir('.config', 'gws'), 'credentials.enc'), 'x');
    const own = gwsDir('mercury-gws-bin');
    writeFileSync(join(own, 'gws'), '');
    chmodSync(join(own, 'gws'), 0o755);
    expect(check('linux').map((f) => f.level)).toEqual(['ok']);
  });

  it('finds the older macOS and Windows folders', () => {
    gwsDir('Library', 'Application Support', 'gws');
    gwsDir('AppData', 'Roaming', 'gws');
    expect(check('linux')).toEqual([]);
    expect(check('darwin')).not.toEqual([]);
    expect(check('win32', { APPDATA: join(home, 'AppData', 'Roaming') })).not.toEqual([]);
  });

  it('uses GOOGLE_WORKSPACE_CLI_CONFIG_DIR when it is set', () => {
    const custom = gwsDir('custom-gws');
    writeFileSync(join(custom, 'credentials.json'), '{}');
    installGws('linux');
    expect(check('linux', { GOOGLE_WORKSPACE_CLI_CONFIG_DIR: custom }).map((f) => f.level)).toEqual(['risk']);
    expect(check('linux', { GOOGLE_WORKSPACE_CLI_CONFIG_DIR: join(home, 'missing') })).toEqual([]);
  });
});
