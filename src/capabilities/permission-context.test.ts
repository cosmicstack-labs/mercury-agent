import { afterAll, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';

// permissions.yaml lives under MERCURY_HOME, resolved at import time.
const home = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'mercury-ctx-'));
  process.env.MERCURY_HOME = dir;
  return dir;
});

const { PermissionManager } = await import('./permissions.js');
const { makeContext, deriveChildContext, isSubsetContext, withChanges } = await import('./permission-context.js');

afterAll(() => rmSync(home, { recursive: true, force: true }));

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function manager(ask = vi.fn().mockResolvedValue('no')) {
  const pm = new PermissionManager();
  const shell = pm.getManifest().capabilities.shell;
  shell.enabled = true;
  shell.blocked = [];
  shell.cwdOnly = false;
  pm.onAsk(ask);
  return { pm, ask };
}

describe('PermissionContext values', () => {
  it('contexts are deeply frozen', () => {
    const ctx = makeContext({ scopes: [{ path: '/w', read: true, write: true }], allowedTools: ['read_file'] });
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(Object.isFrozen(ctx.scopes)).toBe(true);
    expect(Object.isFrozen(ctx.scopes[0])).toBe(true);
    expect(Object.isFrozen(ctx.allowedTools)).toBe(true);
    expect(() => { (ctx as any).autoApprove = true; }).toThrow();
  });

  it('withChanges returns a new context and leaves the original untouched', () => {
    const a = makeContext();
    const b = withChanges(a, { autoApprove: true });
    expect(a.autoApprove).toBe(false);
    expect(b.autoApprove).toBe(true);
    expect(b.autoApproveOrigin).toBe('session');
  });
});

describe('deriveChildContext: child ⊆ parent', () => {
  it('intersects allowedTools with the parent', () => {
    const parent = makeContext({ allowedTools: ['read_file', 'list_dir'] });
    const child = deriveChildContext(parent, { allowedTools: ['read_file', 'run_command'] });
    expect(child.allowedTools).toEqual(['read_file']);
    expect(isSubsetContext(child, parent)).toBe(true);
    // A child that asks for nothing inherits the parent's restriction, not "unrestricted".
    expect(deriveChildContext(parent).allowedTools).toEqual(['read_file', 'list_dir']);
  });

  it('keeps only requested scopes the parent covers', () => {
    const parent = makeContext({ scopes: [{ path: '/work', read: true, write: false }] });
    const child = deriveChildContext(parent, {
      scopes: [
        { path: '/work/sub', read: true, write: false },
        { path: '/work/sub', read: true, write: true },
        { path: '/etc', read: true, write: false },
      ],
    });
    expect(child.scopes).toEqual([{ path: '/work/sub', read: true, write: false }]);
    expect(isSubsetContext(child, parent)).toBe(true);
  });

  it('inherits a user-chosen session Allow All but never an internal turn grant', () => {
    const session = makeContext({ autoApprove: true, autoApproveOrigin: 'session' });
    expect(deriveChildContext(session).autoApprove).toBe(true);
    const turn = makeContext({ autoApprove: true, autoApproveOrigin: 'turn' });
    expect(deriveChildContext(turn).autoApprove).toBe(false);
  });

  it('never inherits skill elevation', () => {
    const parent = makeContext({ elevated: ['run_command'] });
    expect(deriveChildContext(parent).elevated).toEqual([]);
  });

  it('isSubsetContext rejects widening', () => {
    const parent = makeContext({ allowedTools: ['read_file'] });
    expect(isSubsetContext(makeContext({}), parent)).toBe(false);
    expect(isSubsetContext(makeContext({ allowedTools: ['read_file'], autoApprove: true }), parent)).toBe(false);
  });
});

describe('AsyncLocalStorage isolation', () => {
  it('two concurrent agents each resolve their own context across awaits', async () => {
    const { pm } = manager();
    const a = makeContext({ channelType: 'telegram', channelId: 'A', autoApprove: true });
    const b = makeContext({ channelType: 'web', channelId: 'B', senderRole: 'member' });

    const seen: string[] = [];
    const agent = (ctx: typeof a, label: string) => pm.withContext(ctx, async () => {
      for (let i = 0; i < 3; i++) {
        await tick(i % 2 ? 1 : 7);
        const c = pm.currentContext();
        seen.push(`${label}:${c.channelId}:${pm.isAutoApproveAll()}:${pm.getCurrentSenderRole() ?? '-'}`);
      }
    });
    await Promise.all([agent(a, 'a'), agent(b, 'b')]);

    expect(seen.filter((s) => s.startsWith('a:')).every((s) => s === 'a:A:true:-')).toBe(true);
    expect(seen.filter((s) => s.startsWith('b:')).every((s) => s === 'b:B:false:member')).toBe(true);
    // Outside any agent the root context is untouched.
    expect(pm.currentContext().channelId).toBe('cli');
    expect(pm.isAutoApproveAll()).toBe(false);
  });

  it('a grant inside one agent (scope, elevation, allow-all) stays in that agent', async () => {
    const { pm } = manager();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const other = pm.withContext(makeContext({ channelId: 'other' }), async () => {
      await gate;
      return { auto: pm.isAutoApproveAll(), elevated: pm.isShellElevated(), scopes: pm.currentContext().scopes.length };
    });
    await pm.withContext(makeContext({ channelId: 'granted' }), async () => {
      pm.setAutoApproveAll(true);
      pm.elevateForSkill(['run_command']);
      pm.addTempScope('/', true, true);
      await tick();
      expect(pm.isAutoApproveAll()).toBe(true);
      expect(pm.isShellElevated()).toBe(true);
    });
    release();
    expect(await other).toEqual({ auto: false, elevated: false, scopes: 0 });
    expect(pm.isAutoApproveAll()).toBe(false);
    expect(pm.isShellElevated()).toBe(false);
  });

  it('contexts are per PermissionManager (a bot manager never reads a sub-agent cell)', async () => {
    const { pm } = manager();
    const { pm: botPm } = manager();
    botPm.setCurrentContext('bot', 'worker');
    await pm.withContext(makeContext({ channelType: 'telegram', channelId: 'chat' }), async () => {
      await tick();
      expect(botPm.getCurrentChannelType()).toBe('bot');
      expect(pm.getCurrentChannelType()).toBe('telegram');
    });
  });

  it('a turn grant changes the root context only, and endTurnGrant keeps the session', async () => {
    const { pm, ask } = manager();
    pm.setCurrentContext('cli', 'cli');
    const child = pm.withContext(deriveChildContext(pm.currentContext()), async () => {
      await tick(10);
      return pm.checkShellCommand('rm -rf build');
    });
    pm.setCurrentContext('internal', 'internal');
    pm.beginTurnGrant({ scopes: [{ path: '/', read: true, write: true }] });
    expect(pm.isAutoApproveAll()).toBe(true);
    // Child spawned during the turn: no allow-all.
    expect(deriveChildContext(pm.currentContext()).autoApprove).toBe(false);
    await expect(child).resolves.toMatchObject({ allowed: false });
    expect(ask).toHaveBeenCalledWith('Run command: rm -rf build');
    pm.endTurnGrant();
    expect(pm.isAutoApproveAll()).toBe(false);
    expect(pm.currentContext().scopes).toEqual([]);

    // A user's session Allow All survives an internal turn ending.
    pm.setAutoApproveAll(true);
    pm.beginTurnGrant();
    pm.endTurnGrant();
    expect(pm.isAutoApproveAll()).toBe(true);
  });

  it('requestApproval on the internal channel approves only under allow-all', async () => {
    const { pm } = manager();
    pm.setCurrentContext('internal', 'internal');
    await expect(pm.requestApproval('x')).resolves.toBe(false);
    pm.beginTurnGrant();
    await expect(pm.requestApproval('x')).resolves.toBe(true);
    await expect(pm.withContext(deriveChildContext(pm.currentContext()), () => pm.requestApproval('x'))).resolves.toBe(false);
    pm.endTurnGrant();
  });
});
