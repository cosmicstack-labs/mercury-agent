import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { jsonSchema, tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3GenerateResult } from '@ai-sdk/provider';

const home = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'mercury-supervisor-session-'));
  process.env.MERCURY_HOME = dir;
  return dir;
});
const { SubAgentSupervisor } = await import('./supervisor.js');
const { CapabilityRegistry } = await import('../capabilities/registry.js');
const { makeContext } = await import('../capabilities/permission-context.js');

const supervisors: InstanceType<typeof SubAgentSupervisor>[] = [];
const releases: Array<() => void> = [];
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => { resolve = yes; });
  releases.push(resolve);
  return { promise, resolve };
}
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const done = (): LanguageModelV3GenerateResult => ({
  content: [{ type: 'text', text: 'done' }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [],
});
const callTool = (): LanguageModelV3GenerateResult => ({
  content: [{ type: 'tool-call', toolCallId: 'call', toolName: 'fixture', input: '{}' }],
  finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage, warnings: [],
});
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
function makeSupervisor(model = blockingModel()) {
  const registry = new CapabilityRegistry();
  const supervisor = new SubAgentSupervisor({
    agentConfig: { identity: { name: 'Mercury', owner: 'test' } },
    providers: { getDefault: () => ({ name: 'mock', getModel: () => 'mock', getModelInstance: () => model }) },
    identity: { getSystemPrompt: () => 'You are a test agent.' },
    shortTerm: {}, longTerm: {}, episodic: { record() {} }, userMemory: null,
    capabilities: registry,
    tokenBudget: { getStatusText: () => '', getUsagePercentage: () => 0, recordUsage() {}, getRemaining: () => 1_000_000 },
    channels: {},
  } as unknown as ConstructorParameters<typeof SubAgentSupervisor>[0]);
  supervisor.setMaxConcurrent(10);
  supervisors.push(supervisor);
  return { supervisor, registry };
}
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const supervisor of supervisors.splice(0)) {
    await supervisor.haltAll();
    await vi.waitFor(() => expect(supervisor.getActiveAgents()).toEqual([]));
  }
  vi.restoreAllMocks();
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('session-scoped delegated cancellation', () => {
  it('halts matching running and queued descendants while preserving another session', async () => {
    const { supervisor } = makeSupervisor();
    supervisor.setMaxConcurrent(3);
    const a = await supervisor.spawn({ task: 'A', sourceChannelId: 'transport-A', sourceChannelType: 'web' });
    const b = await supervisor.spawn({ task: 'B', sourceChannelId: 'session-B' });
    const child = await supervisor.spawn({ task: 'child A', parentId: a, sourceChannelId: 'internal-child' });
    const grandchild = await supervisor.spawn({ task: 'queued A', parentId: child });
    const queuedB = await supervisor.spawn({ task: 'queued B', sourceChannelId: 'session-B' });
    expect(new Set(await supervisor.haltForSession('session-A', [{ channelId: 'transport-A', channelType: 'web' }])))
      .toEqual(new Set([a, child, grandchild]));
    expect(supervisor.getTaskBoard().get(grandchild)?.status).toBe('halted');
    await vi.waitFor(() => expect(supervisor.getActiveAgents().map((agent) => agent.id).sort()).toEqual([b, queuedB].sort()));
    expect(supervisor.getTaskBoard().get(b)?.status).toBe('running');
    expect(supervisor.getTaskBoard().get(queuedB)?.status).toBe('running');
    await expect(supervisor.spawn({ task: 'late child', parentId: child })).rejects.toThrow('parent agent has been stopped');
    // Stopping a conversation does not ban the owner's later independent work.
    const nextA = await supervisor.spawn({ task: 'new A turn', sourceChannelId: 'session-A' });
    expect(supervisor.getActiveAgents().some((agent) => agent.id === nextA)).toBe(true);
  });

  it('does not stop another channel that happens to use the same transport id', async () => {
    const { supervisor } = makeSupervisor();
    const a = await supervisor.spawn({ task: 'web A', sourceChannelId: 'shared', sourceChannelType: 'web' });
    const b = await supervisor.spawn({ task: 'slack B', sourceChannelId: 'shared', sourceChannelType: 'slack' });
    expect(await supervisor.haltForSession('session-A', [{ channelId: 'shared', channelType: 'web' }])).toEqual([a]);
    await vi.waitFor(() => expect(supervisor.getActiveAgents().map((agent) => agent.id)).toEqual([b]));
    expect(supervisor.getTaskBoard().get(b)?.status).toBe('running');
  });

  it('matches a captured permission context when no explicit source exists, without prefix matches', async () => {
    const { supervisor, registry } = makeSupervisor();
    const a = await registry.permissions.withContext(makeContext({ channelType: 'web', channelId: 'session-A' }),
      () => supervisor.spawn({ task: 'captured A' }));
    const b = await supervisor.spawn({ task: 'different chat', sourceChannelId: 'session-A-other' });
    expect(await supervisor.haltForSession('session-A')).toEqual([a]);
    await vi.waitFor(() => expect(supervisor.getActiveAgents().map((agent) => agent.id)).toEqual([b]));
  });

  it('keeps locks and permission context until a stopped tool drains, leaving B active', async () => {
    const startedA = gate();
    const startedB = gate();
    const finishA = gate();
    const finishB = gate();
    const model = new MockLanguageModelV3({ doGenerate: async (options) => options.prompt.some((message) => message.role === 'tool') ? done() : callTool() });
    const { supervisor, registry } = makeSupervisor(model);
    supervisor.setMaxConcurrent(2);
    const seen: string[] = [];
    const lock = join(home, 'shared.txt');
    vi.spyOn(registry, 'getTools').mockReturnValue({ fixture: tool({
      inputSchema: jsonSchema<Record<string, never>>({ type: 'object', properties: {} }),
      execute: async () => {
        const context = registry.permissions.currentContext();
        seen.push(context.channelId);
        if (context.channelId === 'session-A') {
          const id = supervisor.getActiveAgents().find((agent) => agent.task === 'A mutation')!.id;
          expect(supervisor.getFileLockManager().acquire(lock, id, 'write')).toBe(true);
          startedA.resolve();
          await finishA.promise; // Deliberately ignores cancellation until its operation settles.
          expect(registry.permissions.currentContext()).toBe(context);
        } else {
          startedB.resolve();
          await finishB.promise;
          expect(registry.permissions.currentContext()).toBe(context);
        }
        return 'finished';
      },
    }) });
    const a = await supervisor.spawn({ task: 'A mutation', sourceChannelId: 'session-A', sourceChannelType: 'web' });
    const b = await supervisor.spawn({ task: 'B mutation', sourceChannelId: 'session-B', sourceChannelType: 'web' });
    await Promise.all([startedA.promise, startedB.promise]);
    const queuedA = await supervisor.spawn({ task: 'A queued', sourceChannelId: 'session-A' });
    expect(new Set(await supervisor.haltForSession('session-A'))).toEqual(new Set([a, queuedA]));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(supervisor.getFileLockManager().getLocksFor(a)).toHaveLength(1);
    expect(supervisor.getTaskBoard().get(a)?.status).toBe('running');
    expect(supervisor.getTaskBoard().get(b)?.status).toBe('running');
    expect(seen.sort()).toEqual(['session-A', 'session-B']);
    finishA.resolve();
    await vi.waitFor(() => expect(supervisor.getActiveAgents().map((agent) => agent.id)).toEqual([b]));
    expect(supervisor.getFileLockManager().getLocksFor(a)).toEqual([]);
    expect(supervisor.getTaskBoard().get(a)?.status).toBe('halted');
    expect(supervisor.getTaskBoard().get(queuedA)?.status).toBe('halted');
  });

  it('clears expired stop fences while retaining live ancestor ownership and locks', async () => {
    const { supervisor } = makeSupervisor();
    const parent = await supervisor.spawn({ task: 'A parent', sourceChannelId: 'session-A' });
    const child = await supervisor.spawn({ task: 'A child', parentId: parent, sourceChannelId: 'internal-child' });
    await supervisor.halt(parent);
    await vi.waitFor(() => expect(supervisor.getActiveAgents().map((agent) => agent.id)).toEqual([child]));
    const locks = supervisor.getFileLockManager();
    expect(locks.acquire(join(home, 'live-lock.txt'), child, 'write')).toBe(true);
    supervisor.clearTaskBoard();
    expect(locks.getLocksFor(child)).toHaveLength(1);
    await expect(supervisor.spawn({ task: 'late child', parentId: parent })).rejects.toThrow('parent agent has been stopped');
    const b = await supervisor.spawn({ task: 'B after clearing', sourceChannelId: 'session-B' });
    expect([parent, child]).not.toContain(b);
    expect(await supervisor.haltForSession('session-A')).toEqual([child]);
    await vi.waitFor(() => expect(supervisor.getActiveAgents().map((agent) => agent.id)).toEqual([b]));
    expect(locks.getLocksFor(child)).toEqual([]);
    await supervisor.haltAll();
    await vi.waitFor(() => expect(supervisor.getActiveAgents()).toEqual([]));
    supervisor.clearTaskBoard();
    const state = supervisor as unknown as { haltedAgents: Set<string>; pendingResumes: Set<string>; agentConfigs: Map<string, unknown>; parents: Map<string, unknown> };
    expect([state.haltedAgents.size, state.pendingResumes.size, state.agentConfigs.size, state.parents.size]).toEqual([0, 0, 0, 0]);
    const fresh = await supervisor.spawn({ task: 'new turn', sourceChannelId: 'session-A' });
    await expect(supervisor.spawn({ task: 'new child', parentId: fresh })).resolves.toBeTypeOf('string');
  });

  it.each(['session', 'all'] as const)('%s stop cancels a descendant waiting to resume after its parent completed', async (stop) => {
    const notifying = gate();
    const finishNotify = gate();
    let childCalls = 0;
    const model = new MockLanguageModelV3({ doGenerate: async (options) => {
      if (JSON.stringify(options.prompt).includes('completed parent')) return done();
      childCalls++;
      return callTool();
    } });
    const { supervisor, registry } = makeSupervisor(model);
    vi.spyOn(registry, 'getTools').mockReturnValue({ fixture: tool({
      inputSchema: jsonSchema<Record<string, never>>({ type: 'object', properties: {} }), execute: async () => 'step done',
    }) });
    supervisor.setNotifyCallback(async (_type, _id, message) => {
      if (!message.includes('resuming with a fresh budget')) return;
      notifying.resolve();
      await finishNotify.promise;
    });
    const parent = await supervisor.spawn({ task: 'completed parent', sourceChannelId: 'transport-A', sourceChannelType: 'web' });
    await vi.waitFor(() => expect(supervisor.getActiveAgents()).toEqual([]));
    const child = await supervisor.spawn({ task: 'unfinished child', parentId: parent, sourceChannelId: 'internal-child', maxSteps: 1 });
    await notifying.promise;
    expect(await (stop === 'all' ? supervisor.haltAll() : supervisor.haltForSession('session-A', [{ channelId: 'transport-A', channelType: 'web' }]))).toEqual([child]);
    expect(supervisor.getTaskBoard().get(child)?.status).toBe('halted');
    finishNotify.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(childCalls).toBe(1);
    expect(supervisor.getActiveAgents()).toEqual([]);
    expect(supervisor.getTaskBoard().get(child)?.status).toBe('halted');
    await expect(supervisor.spawn({ task: 'late grandchild', parentId: child })).rejects.toThrow('parent agent has been stopped');
  });
});
