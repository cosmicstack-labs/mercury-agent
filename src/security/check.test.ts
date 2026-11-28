import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gwsFindings, remoteAccessFindings, type SecurityFinding } from './check.js';
import type { TailscaleState } from './tunnel.js';

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
    expect(linux[0].fix).toContain('mercury google connect --install');
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

describe('mercury doctor --security: remote access', () => {
  const NOW = 10_000_000_000;
  const HOST = 'mercury.tail1234.ts.net';
  const DAY = 86_400_000;
  const on = { enabled: true };
  const base = { now: NOW, port: 6174, tailscale: null, publicUrl: null };
  const https = { url: `https://${HOST}`, https: true, funnel: false };
  const plain = { url: `http://${HOST}`, https: false, funnel: false };
  const ts = (serve: TailscaleState['serve'], extra: Partial<TailscaleState> = {}): TailscaleState => ({ magicDns: true, httpsCerts: true, serve, ...extra });
  const titles = (f: SecurityFinding[]) => f.map((x) => `${x.level}: ${x.title}`);
  const NO_TUNNEL = 'Remote access is on, but no tunnel reaches Mercury';
  const TS_HTTP = "Tailscale Serve isn't using HTTPS";
  const PLAIN = 'Mercury is reachable over plain http from the internet';

  it('says, quietly, that no tunnel reaches Mercury when Tailscale is not installed', () => {
    expect(remoteAccessFindings(base, on, 0)).toEqual([
      { level: 'info', title: NO_TUNNEL, detail: expect.stringContaining('web.publicUrl'), fix: 'tailscale serve --bg 6174, then mercury server pair' },
    ]);
  });

  it('warns that no tunnel reaches Mercury when devices are paired', () => {
    expect(titles(remoteAccessFindings(base, on, 2))).toEqual([`warn: ${NO_TUNNEL}`]);
  });

  it('is ok with the address Tailscale Serve sends over HTTPS', () => {
    expect(remoteAccessFindings({ ...base, tailscale: ts([https]) }, on, 1)).toEqual([
      { level: 'ok', title: `Remote access works over HTTPS: https://${HOST}`, detail: 'Tailscale Serve sends it to Mercury.' },
    ]);
  });

  it('warns when Tailscale Serve sends Mercury over plain http', () => {
    const f = remoteAccessFindings({ ...base, tailscale: ts([plain]) }, on, 1);
    expect(titles(f)).toEqual([`warn: ${TS_HTTP}`]);
    expect(f[0].detail).toContain(`http://${HOST}`);
    expect(f[0].fix).toBe('In the Tailscale admin console, open DNS and turn on MagicDNS and HTTPS Certificates, then run tailscale serve --bg 6174');
  });

  it('warns when MagicDNS or HTTPS certificates are off and Tailscale is the way in', () => {
    const certs = remoteAccessFindings({ ...base, tailscale: ts([], { httpsCerts: false }) }, on, 0);
    expect(titles(certs)).toEqual([`warn: ${TS_HTTP}`, `info: ${NO_TUNNEL}`]);
    expect(certs[0].detail).toMatch(/^HTTPS Certificates is off/);
    const both = remoteAccessFindings({ ...base, tailscale: ts([], { httpsCerts: false, magicDns: false }) }, on, 0);
    expect(both[0].detail).toMatch(/^MagicDNS and HTTPS Certificates are off/);
  });

  it("doesn't blame Tailscale when another tunnel is in use", () => {
    expect(titles(remoteAccessFindings({ ...base, tailscale: ts([], { httpsCerts: false }), publicUrl: 'https://mercury.example.com' }, on, 1))).toEqual([]);
    const lastRemote = { at: NOW - 60_000, proxied: true, clientIpKnown: true, scheme: 'https' as const, via: 'cloudflare' };
    expect(titles(remoteAccessFindings({ ...base, tailscale: ts([], { httpsCerts: false }), lastRemote }, on, 1))).toEqual([]);
  });

  it('flags web.publicUrl over plain http to the internet, but not to your own network', () => {
    const f = remoteAccessFindings({ ...base, publicUrl: 'http://mercury.example.com' }, on, 1);
    expect(titles(f)).toEqual([`risk: ${PLAIN}`]);
    expect(f[0].detail).toContain('http://mercury.example.com');
    expect(f[0].fix).toContain('tailscale serve --bg 6174');
    expect(titles(remoteAccessFindings({ ...base, publicUrl: 'http://192.168.1.5:6174' }, on, 1))).toEqual([]);
  });

  it('flags a recent plain-http request from a public address, but not an old one', () => {
    const recent = remoteAccessFindings({ ...base, tailscale: ts([https]), lastPlainHttp: { at: NOW - 60 * 60_000, ip: '203.0.113.9' } }, on, 1);
    expect(titles(recent)).toEqual([`risk: ${PLAIN}`, `ok: Remote access works over HTTPS: https://${HOST}`]);
    expect(recent[0].detail).toBe('A request from 203.0.113.9 came in over plain http 60 minutes ago.');
    const old = remoteAccessFindings({ ...base, tailscale: ts([https]), lastPlainHttp: { at: NOW - 8 * DAY, ip: '203.0.113.9' } }, on, 1);
    expect(titles(old)).toEqual([`ok: Remote access works over HTTPS: https://${HOST}`]);
  });

  it('is ok with web.publicUrl once a request has come in over HTTPS', () => {
    const lastRemote = { at: NOW - 60_000, proxied: true, clientIpKnown: true, scheme: 'https' as const, via: 'cloudflare' };
    expect(titles(remoteAccessFindings({ ...base, publicUrl: 'https://mercury.example.com/', lastRemote }, on, 1))).toEqual(['ok: Remote access works over HTTPS: https://mercury.example.com']);
    expect(titles(remoteAccessFindings({ ...base, publicUrl: 'https://mercury.example.com' }, on, 1))).toEqual([]);
  });

  it('counts a recent remote request as a way in, and forgets it after a week', () => {
    const lastRemote = { at: NOW - DAY, proxied: true, clientIpKnown: true, scheme: null, via: 'proxy' };
    expect(titles(remoteAccessFindings({ ...base, lastRemote }, on, 1))).toEqual([]);
    expect(titles(remoteAccessFindings({ ...base, lastRemote: { ...lastRemote, at: NOW - 8 * DAY } }, on, 1))).toEqual([`warn: ${NO_TUNNEL}`]);
  });

  it('notes devices that are paired while remote access is off', () => {
    expect(remoteAccessFindings(base, { enabled: false }, 2)).toEqual([
      { level: 'info', title: 'Remote access is off, but 2 devices are paired', detail: "They can't connect until remote access is on.", fix: 'mercury server on, or sign them out: mercury server revoke-all' },
    ]);
    expect(titles(remoteAccessFindings(base, { enabled: false }, 1))).toEqual(['info: Remote access is off, but 1 device is paired']);
    expect(remoteAccessFindings(base, { enabled: false }, 0)).toEqual([]);
  });

  it('puts the real port in its fixes', () => {
    expect(remoteAccessFindings({ ...base, port: 7000 }, on, 0)[0].fix).toBe('tailscale serve --bg 7000, then mercury server pair');
  });
});
