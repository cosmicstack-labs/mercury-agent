import { afterAll, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';

// permissions.yaml lives under MERCURY_HOME, resolved at import time.
const home = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'mercury-turn-'));
  process.env.MERCURY_HOME = dir;
  return dir;
});

const { PermissionManager } = await import('./permissions.js');
const { deriveChildContext } = await import('./permission-context.js');

afterAll(() => rmSync(home, { recursive: true, force: true }));

const tick = (ms = 2) => new Promise((r) => setTimeout(r, ms));

describe('concurrent turns (ADR-037)', () => {
  it('each turn keeps its own channel, session and sender across awaits', async () => {
    const pm = new PermissionManager();
    const seen: string[] = [];
    const turn = (channel: string, role: 'admin' | 'member', delay: number) => pm.withTurn(async () => {
      pm.setCurrentContext('telegram', channel, `s-${channel}`);
      pm.setCurrentSenderRole(role);
      await tick(delay);
      const ctx = pm.currentContext();
      seen.push(`${ctx.channelId}/${ctx.sessionId}/${ctx.senderRole}`);
    });
    await Promise.all([turn('a', 'admin', 6), turn('b', 'member', 1)]);
    expect(seen.sort()).toEqual(['a/s-a/admin', 'b/s-b/member']);
    // The shared session context was never touched by either turn's identity.
    expect(pm.currentContext().channelId).toBe('cli');
  });

  it("the owner's Allow All and approved scopes are shared, live, with running turns", async () => {
    const pm = new PermissionManager();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const result = pm.withTurn(async () => {
      pm.setCurrentContext('web', 'w1');
      await gate;
      return pm.currentContext();
    });
    // Outside any turn (e.g. the /permissions fast path): owner changes the session.
    pm.setAutoApproveAll(true);
    pm.addTempScope('/tmp/approved-here', true, true);
    release();
    const ctx = await result;
    expect(ctx.autoApprove).toBe(true);
    expect(ctx.channelId).toBe('w1');
    expect(ctx.scopes.some((s) => s.path.endsWith('approved-here'))).toBe(true);
  });

  it('a scope approved inside a turn lands on the shared session (as before)', async () => {
    const pm = new PermissionManager();
    await pm.withTurn(async () => {
      pm.setCurrentContext('web', 'w1');
      pm.addTempScope('/tmp/granted-in-turn', true, false);
    });
    expect(pm.currentContext().scopes.some((s) => s.path.endsWith('granted-in-turn'))).toBe(true);
    expect(pm.currentContext().channelId).toBe('cli');
  });

  it("an internal turn's grant stays with that turn; a concurrent chat turn never sees it", async () => {
    const pm = new PermissionManager();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const internal = pm.withTurn(async () => {
      pm.setCurrentContext('internal', 'sched');
      pm.beginTurnGrant({ scopes: [{ path: '/', read: true, write: true }] });
      await gate;
      const ctx = pm.currentContext();
      pm.endTurnGrant();
      return ctx;
    });
    const chat = await pm.withTurn(async () => {
      pm.setCurrentContext('telegram', 't1');
      await tick();
      return pm.currentContext();
    });
    release();
    const internalCtx = await internal;
    expect(internalCtx.autoApprove).toBe(true);
    expect(internalCtx.autoApproveOrigin).toBe('turn');
    expect(chat.autoApprove).toBe(false);
    expect(chat.scopes.some((s) => s.path === '/')).toBe(false);
    // Never baked into the session.
    expect(pm.currentContext().autoApprove).toBe(false);
    expect(pm.currentContext().scopes.some((s) => s.path === '/')).toBe(false);
  });

  it('skill elevation stays with the turn that asked for it', async () => {
    const pm = new PermissionManager();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const elevated = pm.withTurn(async () => {
      pm.elevateForSkill(['run_command']);
      await gate;
      return pm.isShellElevated();
    });
    const other = await pm.withTurn(async () => {
      await tick();
      return pm.isShellElevated();
    });
    release();
    expect(await elevated).toBe(true);
    expect(other).toBe(false);
    expect(pm.isShellElevated()).toBe(false);
  });

  it("plugin grants belong to the turn that set them", async () => {
    const pm = new PermissionManager();
    const ask = vi.fn().mockResolvedValue('no');
    pm.onAsk(ask);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const granted = pm.withTurn(async () => {
      pm.setCurrentContext('telegram', 'x');
      pm.setTurnPluginGrants(['plug:tool']);
      await gate;
      return pm.approvePluginTool('plug:tool', 'ok?');
    });
    const denied = await pm.withTurn(async () => {
      pm.setCurrentContext('telegram', 'y');
      return pm.approvePluginTool('plug:tool', 'ok?');
    });
    release();
    expect(await granted).toBe(true);
    expect(denied).toBe(false);
    expect(ask).toHaveBeenCalledOnce();
  });

  it('a sub-agent inside a turn still runs on its own derived context', async () => {
    const pm = new PermissionManager();
    await pm.withTurn(async () => {
      pm.setCurrentContext('web', 'parent');
      pm.elevateForSkill(['run_command']);
      const child = deriveChildContext(pm.currentContext());
      await pm.withContext(child, async () => {
        expect(pm.currentContext().channelId).toBe('parent');
        expect(pm.isShellElevated()).toBe(false);
        pm.setCurrentContext('web', 'child-moved');
      });
      expect(pm.currentContext().channelId).toBe('parent');
      expect(pm.isShellElevated()).toBe(true);
    });
  });
});
