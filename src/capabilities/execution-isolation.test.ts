import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { jsonSchema, tool, type Tool } from 'ai';

const home = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'mercury-execution-'));
  process.env.MERCURY_HOME = dir;
  return dir;
});
const { CapabilityRegistry } = await import('./registry.js');
const { makeContext, deriveChildContext } = await import('./permission-context.js');
const { trackTools } = await import('./tool-execution-scope.js');
const { publishTool, resetToolBridge, setPluginImagesAllowed, toolContent } = await import('../plugins/tool-bridge.js');

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function invoke(t: Tool, input: unknown = {}, signal?: AbortSignal) {
  return t.execute!(input, { toolCallId: 'same-call-id', messages: [], abortSignal: signal });
}

function plugin(invoke: (args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>, options: { readOnly?: boolean; timeoutMs?: number } = {}) {
  return publishTool({
    pluginId: 'fixture', pluginName: 'Fixture', name: 'action', description: 'Fixture action',
    inputSchema: { type: 'object', properties: {} }, readOnly: options.readOnly ?? true,
    timeoutMs: options.timeoutMs ?? 5000, invoke,
  });
}

afterEach(() => { resetToolBridge(); vi.useRealTimers(); });
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('concurrent capability execution', () => {
  it('keeps real file reads, tool availability and nested cwd changes in their own turn', async () => {
    const registry = new CapabilityRegistry();
    registry.registerAll();
    const base = registry.getDefaultCwd();
    const first = join(home, 'first');
    const second = join(home, 'second');
    for (const dir of [first, second]) {
      mkdirSync(dir);
      writeFileSync(join(dir, 'value.txt'), dir);
    }
    registry.permissions.getManifest().capabilities.filesystem.scopes = [{ path: home, read: true, write: false }];
    const ready = deferred();
    const otherReady = deferred();
    const a = registry.withExecutionContext(async () => {
      registry.setCwd(first);
      ready.resolve();
      await otherReady.promise;
      expect(await invoke(registry.getTools().read_file, { path: 'value.txt' })).toContain(first);
      await registry.withExecutionContext(async () => {
        registry.setCwd(second);
        registry.setToolsDisabled(true);
        expect(registry.getTools()).toEqual({});
        expect(registry.getPlanTools()).toEqual({});
        await registry.withExecutionContext(async () => {
          expect(registry.getCwd()).toBe(base);
          expect(registry.areToolsDisabled()).toBe(false);
        }, { cwd: registry.getDefaultCwd(), toolsDisabled: false });
      });
      expect(registry.getCwd()).toBe(first);
      expect(registry.areToolsDisabled()).toBe(false);
      expect(registry.getDefaultCwd()).toBe(base);
    });
    const b = registry.withExecutionContext(async () => {
      await ready.promise;
      registry.setCwd(second);
      expect(await invoke(registry.getPlanTools().read_file, { path: 'value.txt' })).toContain(second);
      registry.setToolsDisabled(true);
      otherReady.resolve();
    });
    await Promise.all([a, b]);
    expect(registry.getCwd()).toBe(base);
    expect(registry.areToolsDisabled()).toBe(false);
  });

  it.each(['normal', 'plan'] as const)('drains a detached %s tool before releasing its turn and rejects late starts', async (mode) => {
    const registry = new CapabilityRegistry();
    const started = deferred();
    const done = deferred<string>();
    const work = vi.fn(async () => { started.resolve(); return done.promise; });
    plugin(work);
    let exposed!: Tool;
    let settled = false;
    const turn = registry.withExecutionContext(async () => {
      exposed = (mode === 'plan' ? registry.getPlanTools() : registry.getTools()).fixture__action;
      void invoke(exposed);
      await started.promise;
    }).then(() => { settled = true; });
    await started.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(() => invoke(exposed)).toThrow('turn has stopped');
    done.resolve('finished');
    await turn;
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('holds the turn after a plugin timeout until the original side effect settles', async () => {
    vi.useFakeTimers();
    const registry = new CapabilityRegistry();
    const started = deferred();
    const done = deferred<string>();
    const toolReturned = deferred();
    const effects: string[] = [];
    plugin(async () => { started.resolve(); await done.promise; effects.push('completed'); return 'done'; }, { timeoutMs: 10 });
    let settled = false;
    const turn = registry.withExecutionContext(async () => {
      const output = await invoke(registry.getTools().fixture__action);
      expect(output).toContain('timed out');
      toolReturned.resolve();
    }).then(() => { settled = true; });
    await started.promise;
    await vi.advanceTimersByTimeAsync(10);
    await toolReturned.promise;
    expect(settled).toBe(false);
    expect(effects).toEqual([]);
    done.resolve('done');
    await turn;
    expect(effects).toEqual(['completed']);
  });

  it('does not perform a plugin side effect after an approval arrives on an aborted turn', async () => {
    const registry = new CapabilityRegistry();
    const approval = deferred<string>();
    const asked = deferred();
    registry.permissions.onAsk(async () => { asked.resolve(); return approval.promise; });
    const work = vi.fn(async () => 'done');
    plugin(work, { readOnly: false });
    const ac = new AbortController();
    const turn = registry.permissions.withContext(makeContext({ channelType: 'web', channelId: 'cancel' }), () =>
      registry.withExecutionContext(async () => invoke(registry.getTools().fixture__action), { signal: ac.signal }));
    await asked.promise;
    ac.abort();
    approval.resolve('always');
    await expect(turn).resolves.toContain('not approved');
    expect(work).not.toHaveBeenCalled();
    expect(registry.permissions.drainAnswers()).toEqual([]);
    registry.permissions.onAsk(async () => 'no');
    await registry.permissions.withContext(makeContext({ channelType: 'web', channelId: 'cancel' }), async () => {
      expect(await registry.permissions.approvePluginTool('fixture__action', 'Write')).toBe(false);
    });
  });

  it('passes turn cancellation through to the underlying plugin and drains its rejection', async () => {
    const registry = new CapabilityRegistry();
    const started = deferred();
    const ac = new AbortController();
    const work = vi.fn((_args: Record<string, unknown>, signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
      started.resolve();
    }));
    plugin(work);
    const turn = registry.withExecutionContext(async () => invoke(registry.getTools().fixture__action), { signal: ac.signal });
    await started.promise;
    ac.abort();
    await expect(turn).resolves.toContain('stopped');
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('closes and drains a streaming tool when its consumer stops waiting', async () => {
    const registry = new CapabilityRegistry();
    const started = deferred();
    const finish = deferred();
    const cleanup = vi.fn();
    let settled = false;
    const turn = registry.withExecutionContext(async () => {
      const t = trackTools({ stream: tool({
        inputSchema: jsonSchema({ type: 'object' }),
        execute: async function* () {
          try {
            started.resolve();
            await finish.promise;
            yield 'partial';
          } finally {
            cleanup();
          }
        },
      }) });
      const iterator = (invoke(t.stream) as AsyncIterable<unknown>)[Symbol.asyncIterator]();
      void iterator.next();
      await started.promise;
    }).then(() => { settled = true; });
    await started.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(cleanup).not.toHaveBeenCalled();
    finish.resolve();
    await turn;
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

describe('concurrent permission metadata', () => {
  it('isolates turn grants, plugin grants and answer attribution across interleaved contexts', async () => {
    const pm = new CapabilityRegistry().permissions;
    const scheduledReady = deferred();
    const release = deferred();
    const answerA = deferred<string>();
    const answerB = deferred<string>();
    pm.onAsk((prompt) => prompt === 'A: action' ? answerA.promise : answerB.promise);
    const scheduled = pm.withContext(makeContext({ channelType: 'internal', channelId: 'scheduled' }), async () => {
      pm.beginTurnGrant({ scopes: [{ path: home, read: true, write: true }] });
      pm.setTurnPluginGrants(['fixture__action']);
      expect(pm.isAutoApproveAll()).toBe(true);
      expect(pm.currentContext().autoApproveOrigin).toBe('turn');
      expect(pm.sessionContext().autoApprove).toBe(false);
      await pm.withContext(deriveChildContext(pm.currentContext()), async () => {
        expect(pm.isAutoApproveAll()).toBe(false);
        expect(await pm.approvePluginTool('fixture__action', 'child')).toBe(false);
      });
      scheduledReady.resolve();
      await release.promise;
      pm.endTurnGrant();
      expect(pm.isAutoApproveAll()).toBe(false);
      expect(pm.currentContext().scopes).toEqual([]);
    });
    await scheduledReady.promise;
    const run = (id: string, answer: ReturnType<typeof deferred<string>>) => pm.withContext(makeContext({ channelType: 'web', channelId: id }), async () => {
      expect(pm.isAutoApproveAll()).toBe(false);
      expect(pm.currentContext().scopes).toEqual([]);
      const approved = pm.approvePluginTool('fixture__action', `${id}: action`);
      await answer.promise;
      expect(await approved).toBe(id === 'A');
      return pm.drainAnswers();
    });
    const a = run('A', answerA);
    const b = run('B', answerB);
    answerB.resolve('no');
    expect(await b).toEqual([{ action: 'B', answer: 'no' }]);
    answerA.resolve('yes');
    expect(await a).toEqual([{ action: 'A', answer: 'yes' }]);
    release.resolve();
    await scheduled;
    expect(pm.isAutoApproveAll()).toBe(false);
    expect(pm.drainAnswers()).toEqual([]);
  });
});

describe('plugin images across concurrent turns and provider attempts', () => {
  it('keeps duplicate tool-call IDs and vision settings scoped to their run', async () => {
    const registry = new CapabilityRegistry();
    plugin(async (args) => toolContent(String(args.text), [{ data: String(args.image), mimeType: 'image/png' }]));
    const readyA = deferred();
    const readyB = deferred();
    const run = (text: string, allowed: boolean, ready: ReturnType<typeof deferred<void>>, other: ReturnType<typeof deferred<void>>) => registry.withExecutionContext(async () => {
      setPluginImagesAllowed(allowed);
      const t = registry.getTools().fixture__action;
      const output = await invoke(t, { text, image: text });
      ready.resolve();
      await other.promise;
      return t.toModelOutput!({ toolCallId: 'same-call-id', input: {}, output });
    });
    const [a, b] = await Promise.all([run('A', true, readyA, readyB), run('B', false, readyB, readyA)]);
    expect(a).toEqual({ type: 'content', value: [{ type: 'text', text: 'A\n[1 image attached]' }, { type: 'image-data', data: 'A', mediaType: 'image/png' }] });
    expect(b).toEqual({ type: 'text', value: expect.stringContaining("can't view images") });
    expect(JSON.stringify(b)).not.toContain('"data":"A"');
  });

  it('keeps old attempt results separate when a fallback reuses the call ID', async () => {
    const registry = new CapabilityRegistry();
    plugin(async (args) => args.image ? toolContent('screen', [{ data: String(args.image), mimeType: 'image/png' }]) : 'plain');
    await registry.withExecutionContext(async () => {
      setPluginImagesAllowed(true);
      const oldTool = registry.getTools().fixture__action;
      const oldOutput = await invoke(oldTool, { image: 'first' });
      setPluginImagesAllowed(false);
      const newTool = registry.getTools().fixture__action;
      const newOutput = await invoke(newTool);
      expect(await newTool.toModelOutput!({ toolCallId: 'same-call-id', input: {}, output: newOutput })).toEqual({ type: 'text', value: 'plain' });
      expect(await oldTool.toModelOutput!({ toolCallId: 'same-call-id', input: {}, output: oldOutput })).toEqual({ type: 'content', value: expect.arrayContaining([{ type: 'image-data', data: 'first', mediaType: 'image/png' }]) });
    });
  });
});
