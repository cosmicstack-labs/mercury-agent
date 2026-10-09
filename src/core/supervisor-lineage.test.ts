import { describe, expect, it, afterAll, beforeAll, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { MockLanguageModelV3 } from 'ai/test';

// The task board and permissions.yaml live under MERCURY_HOME, which the
// modules read at import time — point it at a scratch directory first.
const home = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'mercury-lineage-'));
  process.env.MERCURY_HOME = dir;
  return dir;
});

const { SubAgentSupervisor } = await import('./supervisor.js');
const { createStopAgentTool, createListAgentsTool } = await import('../capabilities/subagents/index.js');

/** A model that never answers: it rejects only when the agent is aborted. */
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

function makeSupervisor() {
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
      permissions: {
        clearElevation() {},
        isAutoApproveAll: () => false,
        getManifest: () => ({ capabilities: { filesystem: { scopes: [] } } }),
      },
    } as any,
    tokenBudget: { getStatusText: () => '', getUsagePercentage: () => 0, recordUsage() {}, getRemaining: () => 1_000_000 } as any,
    channels: {} as any,
  });
  supervisor.setMaxConcurrent(10);
  return supervisor;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

async function run(toolInstance: any, input: any): Promise<string> {
  return toolInstance.execute(input, { toolCallId: 't', messages: [] });
}

describe('SubAgentSupervisor lineage (#74)', () => {
  const supervisors: InstanceType<typeof SubAgentSupervisor>[] = [];
  beforeAll(() => {
    expect(process.env.MERCURY_HOME).toBe(home);
  });
  afterAll(async () => {
    for (const s of supervisors) await s.haltAll();
    await settle();
    rmSync(home, { recursive: true, force: true });
  });

  /** root → a (→ b → c) and root → d; returns the ids. */
  async function tree() {
    const supervisor = makeSupervisor();
    supervisors.push(supervisor);
    const a = await supervisor.spawn({ task: 'a' });
    const b = await supervisor.spawn({ task: 'b', parentId: a });
    const c = await supervisor.spawn({ task: 'c', parentId: b });
    const d = await supervisor.spawn({ task: 'd' });
    return { supervisor, a, b, c, d };
  }

  it('records parentage and answers descendant queries transitively', async () => {
    const { supervisor, a, b, c, d } = await tree();
    expect(supervisor.getParentId(a)).toBeUndefined();
    expect(supervisor.getParentId(b)).toBe(a);
    expect(supervisor.isDescendant(b, a)).toBe(true);
    expect(supervisor.isDescendant(c, a)).toBe(true);
    expect(supervisor.isDescendant(c, b)).toBe(true);
    expect(supervisor.isDescendant(d, a)).toBe(false);
    expect(supervisor.isDescendant(a, b)).toBe(false);
    expect(supervisor.isDescendant(a, a)).toBe(false);
  });

  it('getActiveAgents(owner) lists only the owner\'s descendants; no owner lists everything', async () => {
    const { supervisor, a, b, c, d } = await tree();
    expect(supervisor.getActiveAgents().map(x => x.id).sort()).toEqual([a, b, c, d].sort());
    expect(supervisor.getActiveAgents(a).map(x => x.id).sort()).toEqual([b, c].sort());
    expect(supervisor.getActiveAgents(b).map(x => x.id)).toEqual([c]);
    expect(supervisor.getActiveAgents(d)).toEqual([]);
  });

  it('halt(id, caller) refuses siblings and ancestors, allows descendants', async () => {
    const { supervisor, a, b, c, d } = await tree();
    await expect(supervisor.halt(d, b)).resolves.toBe(false);
    await expect(supervisor.halt(a, b)).resolves.toBe(false);
    await expect(supervisor.halt(b, b)).resolves.toBe(false);
    await settle();
    expect(supervisor.getActiveAgents().map(x => x.id).sort()).toEqual([a, b, c, d].sort());

    await expect(supervisor.halt(c, a)).resolves.toBe(true);
    await settle();
    expect(supervisor.getActiveAgents().map(x => x.id).sort()).toEqual([a, b, d].sort());
  });

  it('haltAll(caller) halts only the caller\'s subtree', async () => {
    const { supervisor, a, b, c, d } = await tree();
    const halted = await supervisor.haltAll(a);
    expect(halted.sort()).toEqual([b, c].sort());
    await settle();
    expect(supervisor.getActiveAgents().map(x => x.id).sort()).toEqual([a, d].sort());
  });

  it('halt also reaches a queued descendant', async () => {
    const supervisor = makeSupervisor();
    supervisors.push(supervisor);
    supervisor.setMaxConcurrent(1);
    const root = await supervisor.spawn({ task: 'root' });
    const child = await supervisor.spawn({ task: 'child', parentId: root });
    expect(supervisor.getActiveAgents(root).map(x => x.id)).toEqual([child]);
    expect(supervisor.getActiveAgents(root)[0].status).toBe('pending');
    await expect(supervisor.halt(child, root)).resolves.toBe(true);
    expect(supervisor.getActiveAgents(root)).toEqual([]);
    expect(supervisor.getTaskBoard().get(child)?.status).toBe('halted');
  });

  it('stop_agent bound to a child cannot stop a sibling, and "all" only halts its own subtree', async () => {
    const { supervisor, a, b, c, d } = await tree();
    const stopAsB = createStopAgentTool(supervisor, { callerId: b });
    await expect(run(stopAsB, { agentId: d })).resolves.toMatch(/was not delegated by you/);
    await expect(run(stopAsB, { agentId: a })).resolves.toMatch(/was not delegated by you/);
    const all = await run(stopAsB, { agentId: 'all' });
    expect(all).toContain(c);
    expect(all).not.toContain(d);
    await settle();
    expect(supervisor.getActiveAgents().map(x => x.id).sort()).toEqual([a, b, d].sort());
    // The main agent's instance (no caller) still halts anything.
    const stopAsMain = createStopAgentTool(supervisor);
    await expect(run(stopAsMain, { agentId: d })).resolves.toMatch(/halt signal sent/);
  });

  it('list_agents bound to a child shows only its descendants', async () => {
    const { supervisor, a, b, c, d } = await tree();
    const listAsA = await run(createListAgentsTool(supervisor, { callerId: a }), {});
    expect(listAsA).toContain(b);
    expect(listAsA).toContain(c);
    expect(listAsA).not.toContain(`**${d}**`);
    const listAsD = await run(createListAgentsTool(supervisor, { callerId: d }), {});
    expect(listAsD).toMatch(/No agents delegated by you/);
    const listAsMain = await run(createListAgentsTool(supervisor), {});
    for (const id of [a, b, c, d]) expect(listAsMain).toContain(`**${id}**`);
  });
});
