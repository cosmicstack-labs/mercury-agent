import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OwnerApprovals, _setOwnerApprovals, ownerApprovals } from './owner-approvals.js';
import { runServerCommand, type ServerUi } from './server-menu.js';
import { localServerOps } from './server-ops.js';
import { readRemoteSettings, writeRemoteSettings } from './remote-settings.js';
import { readAudit } from './audit.js';
import { PairCodes, _setPairCodes, pairCodes } from './pair-codes.js';
import { SERVER_HELP, serverMenu } from './server-menu.js';

let home: string;
const previous = process.env.MERCURY_HOME;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'mercury-server-')); process.env.MERCURY_HOME = home; _setOwnerApprovals(new OwnerApprovals()); });
afterEach(() => { if (previous === undefined) delete process.env.MERCURY_HOME; else process.env.MERCURY_HOME = previous; rmSync(home, { recursive: true, force: true }); });

function screen(picks: string[] = []) {
  const said: string[] = [];
  const secrets: string[] = [];
  const titles: string[] = [];
  const ui: ServerUi = {
    choose: async (title, options) => { titles.push(title); const p = picks.shift() ?? 'done'; return options.find((o) => o.value === p || o.value.startsWith(p))?.value ?? null; },
    say: async (t) => { said.push(t); },
    secret: async (t) => { secrets.push(t); },
  };
  return { ui, said, secrets, titles };
}

describe('/server', () => {
  it('turns remote access off and on, and logs who did it', async () => {
    const ops = localServerOps({ by: 'cli' });
    const s = screen();
    await runServerCommand('off', ops, s.ui);
    expect(readRemoteSettings().enabled).toBe(false);
    await runServerCommand('on', ops, s.ui);
    expect(readRemoteSettings().enabled).toBe(true);
    expect(readAudit(5).map((e) => [e.kind, e.by])).toContainEqual(['remote.changed', 'cli']);
  });

  it('makes a token shown once (as a secret, never said), lists and revokes it', async () => {
    const ops = localServerOps();
    const s = screen();
    await runServerCommand('token Office laptop', ops, s.ui);
    expect(s.secrets[0]).toMatch(/mdt_[0-9a-f]{8}_[0-9a-f]{64}/);
    expect(s.said.join('\n')).not.toMatch(/mdt_/);
    await runServerCommand('devices', ops, s.ui);
    expect(s.said.at(-1)).toMatch(/Office laptop/);
    await runServerCommand('revoke office laptop', ops, s.ui);
    expect((await ops.status()).devices).toHaveLength(0);
  });

  it('approves a waiting device by its code', async () => {
    const q = ownerApprovals().request({ kind: 'pair', title: 'New device: Phone', who: 'Phone' }, 60_000);
    const s = screen();
    await runServerCommand(`approve ${q.code.toLowerCase()}`, localServerOps(), s.ui);
    expect(ownerApprovals().get(q.id)?.status).toBe('allowed');
    expect(s.said.at(-1)).toMatch(/Approved/);
    await runServerCommand(`deny ${q.code}`, localServerOps(), s.ui);
    expect(s.said.at(-1)).toMatch(/No question is waiting/);
  });

  it('validates addresses and settings', async () => {
    const ops = localServerOps();
    const s = screen();
    await runServerCommand('allow-ip not-an-ip', ops, s.ui);
    expect(readRemoteSettings().allowIps).toEqual([]);
    await runServerCommand('allow-ip 100.64.0.0/10', ops, s.ui);
    await runServerCommand('allow-ip 203.0.113.7', ops, s.ui);
    expect(readRemoteSettings().allowIps).toEqual(['100.64.0.0/10', '203.0.113.7']);
    await runServerCommand('remove-ip 203.0.113.7', ops, s.ui);
    expect(readRemoteSettings().allowIps).toEqual(['100.64.0.0/10']);
    await runServerCommand('expire never', ops, s.ui);
    await runServerCommand('limit 3', ops, s.ui);
    await runServerCommand('shell on', ops, s.ui);
    expect(readRemoteSettings()).toMatchObject({ idleDays: 0, maxDevices: 3, allowShell: true });
    await runServerCommand('nonsense', ops, s.ui);
    expect(s.said.at(-1)).toMatch(/\/server approve <code>/);
  });

  it('the menu walks: waiting → approve, then Done', async () => {
    const q = ownerApprovals().request({ kind: 'action', title: 'Run a shell command', who: 'Phone', scope: { principal: 'device:x', action: 'a' } }, 60_000);
    const s = screen(['pending', q.id, 'allow', 'done']);
    await runServerCommand('', localServerOps(), s.ui);
    expect(ownerApprovals().get(q.id)?.status).toBe('allowed');
    expect(s.titles[0]).toMatch(/Remote access: on · 0 devices · 1 waiting for you · Security:/);
  });
});

describe('/server pair', () => {
  beforeEach(() => { _setPairCodes(new PairCodes()); });
  afterEach(() => { _setPairCodes(null); });

  const ADDRESS = 'https://phone.example.com';
  const shownCode = (text: string) => /Code\s+([0-9A-Z-]{29})/.exec(text)?.[1] ?? '';
  const pairPhone = (text: string) => {
    const found = pairCodes().match(shownCode(text));
    if (found) pairCodes().redeemed(found.id, { name: 'Pixel 9', platform: 'android' });
  };

  function terminalScreen(onShown: (text: string) => void, picks: string[] = []) {
    const s = screen(picks);
    const shown: string[] = [];
    s.ui.terminal = true;
    s.ui.waitFor = async <T>(text: string, until: Promise<T>): Promise<T | null> => { shown.push(text); onShown(text); return until; };
    return { ...s, shown };
  }

  it('shows the address, the grouped code and a QR, then who paired', async () => {
    const s = terminalScreen(pairPhone);
    await runServerCommand(`pair ${ADDRESS}`, localServerOps({ by: 'cli' }), s.ui);
    expect(s.shown).toHaveLength(1);
    expect(s.shown[0]).toContain(`Address  ${ADDRESS}`);
    expect(shownCode(s.shown[0])).toMatch(/^([0-9A-Z]{5}-){4}[0-9A-Z]{5}$/);
    expect(s.shown[0]).toContain('\x1b[97;40m');
    expect(s.said.at(-1)).toBe('✓ Paired with Pixel 9 (android).');
    expect(readAudit(5).map((e) => [e.kind, e.by])).toContainEqual(['pair.code.created', 'cli']);
  });

  it('cancels the code when the owner cancels', async () => {
    let code = '';
    const s = screen();
    s.ui.waitFor = async <T>(text: string): Promise<T | null> => { code = shownCode(text); return null; };
    await runServerCommand(`pair ${ADDRESS}`, localServerOps(), s.ui);
    expect(code).not.toBe('');
    expect(pairCodes().match(code)).toBeNull();
    expect(s.said.at(-1)).toMatch(/^Cancelled/);
  });

  it('offers to turn remote access on, and pairs once it is on', async () => {
    writeRemoteSettings({ enabled: false });
    const s = terminalScreen(pairPhone, ['on']);
    await runServerCommand(`pair ${ADDRESS}`, localServerOps({ by: 'cli' }), s.ui);
    expect(s.titles[0]).toMatch(/Remote access is off/);
    expect(readRemoteSettings().enabled).toBe(true);
    expect(readAudit(10).map((e) => [e.kind, e.by])).toContainEqual(['remote.changed', 'cli']);
    expect(s.said.at(-1)).toMatch(/^✓ Paired/);
  });

  it('leaves remote access off, and shows no code, when the owner says no', async () => {
    writeRemoteSettings({ enabled: false });
    const s = terminalScreen(pairPhone, ['off']);
    await runServerCommand(`pair ${ADDRESS}`, localServerOps(), s.ui);
    expect(readRemoteSettings().enabled).toBe(false);
    expect(s.shown).toHaveLength(0);
    expect(s.said.at(-1)).toMatch(/stays off/);
  });

  it('refuses at the device limit', async () => {
    const { createDevice } = await import('../web/devices.js');
    writeRemoteSettings({ maxDevices: 1 });
    createDevice('Old phone', 'ios');
    const s = terminalScreen(pairPhone);
    await runServerCommand(`pair ${ADDRESS}`, localServerOps(), s.ui);
    expect(s.shown).toHaveLength(0);
    expect(s.said.at(-1)).toMatch(/the limit is 1/);
  });

  it('refuses plain http to the internet, and says how to get HTTPS', async () => {
    const s = terminalScreen(pairPhone);
    await runServerCommand('pair http://203.0.113.7:8080', localServerOps(), s.ui);
    expect(s.shown).toHaveLength(0);
    expect(s.said.at(-1)).toMatch(/tailscale serve --bg \d+/);
  });

  it('says to start Mercury when it is not running', async () => {
    const s = terminalScreen(pairPhone);
    await runServerCommand(`pair ${ADDRESS}`, localServerOps({ offline: true }), s.ui);
    expect(s.shown).toHaveLength(0);
    expect(s.said.at(-1)).toMatch(/mercury start/);
  });

  it('in a chat, posts the screen as plain text and the result as a later message', async () => {
    const s = screen();
    await runServerCommand(`pair ${ADDRESS}`, localServerOps(), s.ui);
    expect(s.said).toHaveLength(1);
    expect(s.said[0]).toContain('```text\n');
    expect(s.said[0]).toContain('Pair a phone');
    expect(s.said[0]).not.toContain('\x1b[');
    pairPhone(s.said[0]);
    await new Promise((r) => setTimeout(r, 0));
    expect(s.said.at(-1)).toBe('✓ Paired with Pixel 9 (android).');
  });

  it('is in the help and the menu', async () => {
    expect(SERVER_HELP).toContain('/server pair [address]');
    const labels: string[] = [];
    const ui = { ...screen().ui, choose: async (_t: string, options: Array<{ value: string; label: string }>) => { labels.push(...options.map((o) => o.label)); return 'done'; } };
    await serverMenu(localServerOps(), ui);
    expect(labels).toContain('Pair a phone (QR code)');
  });
});
