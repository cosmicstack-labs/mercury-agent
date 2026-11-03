import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OwnerApprovals, _setOwnerApprovals, ownerApprovals } from './owner-approvals.js';
import { runServerCommand, type ServerUi } from './server-menu.js';
import { localServerOps } from './server-ops.js';
import { readRemoteSettings } from './remote-settings.js';
import { readAudit } from './audit.js';

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
