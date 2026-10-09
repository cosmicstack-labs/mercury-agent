import { afterAll, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { MockLanguageModelV3 } from 'ai/test';

// The task board and permissions.yaml live under MERCURY_HOME.
const home = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'mercury-supctx-'));
  process.env.MERCURY_HOME = dir;
  return dir;
});

const { SubAgentSupervisor } = await import('./supervisor.js');
const { PermissionManager } = await import('../capabilities/permissions.js');
const { makeContext, isSubsetContext } = await import('../capabilities/permission-context.js');

function blockingModel() {
  return new MockLanguageModelV3({
    doGenerate: (options) => new Promise((_, reject) => {
      const signal = options.abortSignal;
      const abort = () => reject(signal?.reason ?? new DOMException('aborted', 'AbortError'));
      if (signal?.aborted) return abort();
      signal?.addEventListener('abort', abort, { once: true });
    }),
  });
}

function makeSupervisor(permissions: InstanceType<typeof PermissionManager>) {
  const model = blockingModel();
  const supervisor = new SubAgentSupervisor({
    agentConfig: { identity: { name: 'Mercury', owner: 'test' } } as any,
    providers: { getDefault: () => ({ name: 'mock', getModel: () => 'mock-model', getModelInstance: () => model }) } as any,
    identity: { getSystemPrompt: () => 'You are a test agent.' } as any,
    shortTerm: {} as any,
    longTerm: {} as any,
    episodic: { record() {} } as any,
    userMemory: null,
    capabilities: {
      getCwd: () => process.cwd(),
      setCwd() {},
      setChannelContext() {},
      getTools: () => ({}),
      getToolNames: () => [],
      permissions,
    } as any,
    tokenBudget: { getStatusText: () => '', getUsagePercentage: () => 0, recordUsage() {}, getRemaining: () => 1_000_000 } as any,
    channels: {} as any,
  });
  return supervisor;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

describe('SubAgentSupervisor permission contexts (ADR-016)', () => {
  const supervisors: InstanceType<typeof SubAgentSupervisor>[] = [];
  afterAll(async () => {
    for (const s of supervisors) await s.haltAll();
    await settle();
    rmSync(home, { recursive: true, force: true });
  });

  it('snapshots the spawning agent\'s context at spawn time, as a subset', async () => {
    const permissions = new PermissionManager();
    const supervisor = makeSupervisor(permissions);
    supervisors.push(supervisor);
    supervisor.setMaxConcurrent(10);

    const parent = makeContext({ channelType: 'telegram', channelId: 'chat-1', allowedTools: ['read_file', 'run_command'] });
    const id = await permissions.withContext(parent, () => supervisor.spawn({
      task: 'child', allowedTools: ['run_command', 'write_file'], sourceChannelType: 'telegram', sourceChannelId: 'chat-1',
    }));
    const ctx = (supervisor as any).agentConfigs.get(id).permissionContext;
    expect(ctx.allowedTools).toEqual(['run_command']);
    expect(ctx.channelId).toBe('chat-1');
    expect(isSubsetContext(ctx, parent)).toBe(true);
  });

  it('a queued agent keeps the context it was spawned with, not the root context when it starts', async () => {
    const permissions = new PermissionManager();
    const supervisor = makeSupervisor(permissions);
    supervisors.push(supervisor);
    supervisor.setMaxConcurrent(1);

    await supervisor.spawn({ task: 'occupies the only slot' });
    const queuedId = await supervisor.spawn({ task: 'queued', sourceChannelType: 'cli', sourceChannelId: 'cli' });
    const queued = (supervisor as any).waitQueue.find((c: any) => c.id === queuedId);
    expect(queued.permissionContext.autoApprove).toBe(false);

    // The main agent then enters an internal allow-all turn; the queued
    // config's frozen context is unaffected.
    permissions.beginTurnGrant({ scopes: [{ path: '/', read: true, write: true }] });
    expect(permissions.isAutoApproveAll()).toBe(true);
    expect(queued.permissionContext.autoApprove).toBe(false);
    expect(queued.permissionContext.scopes).toEqual([]);
    expect(Object.isFrozen(queued.permissionContext)).toBe(true);
    permissions.endTurnGrant();
  });
});
