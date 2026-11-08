import '../eval/env.js';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { EvalHarness } from '../eval/runner.js';
import { removeEvalRoot } from '../eval/env.js';
import { call, textStep, toolStep, type ScriptedStep } from '../eval/fixture.js';
import { promptText } from '../eval/script-player.js';
import type { ChannelMessage } from '../types/channel.js';
import { getWorkKey, type WorkEntry } from './work-ledger.js';

/** Model-side barriers hold actual SDK calls open; the queue, tools, permission
 * checks, persistence and delivery are the production implementations. */
class Gate {
  private releasePromise!: () => void;
  private readonly promise = new Promise<void>((resolve) => { this.releasePromise = resolve; });

  release(): void { this.releasePromise(); }

  async wait(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new DOMException('Stopped', 'AbortError'));
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    try { await Promise.race([this.promise, aborted]); }
    finally { if (onAbort) signal?.removeEventListener('abort', onAbort); }
  }
}

interface ModelCall {
  label: string;
  round: number;
  options: LanguageModelV3CallOptions;
  cwd: string;
  permissionChannel: string;
  permissionScopes: string[];
}

type ModelScript = (call: ModelCall) => ScriptedStep | Promise<ScriptedStep>;
let harness: EvalHarness | undefined;
let calls: ModelCall[] = [];
let gates: Gate[] = [];

function gate(): Gate {
  const value = new Gate();
  gates.push(value);
  return value;
}

async function setup(script: ModelScript): Promise<EvalHarness> {
  calls = [];
  gates = [];
  const h = await EvalHarness.create({
    name: 'concurrent-sessions', channel: { type: 'web', style: 'plain' }, turns: [],
  }, { fakeTimers: false });
  harness = h;
  // Web correctly ignores the CLI's ambient allow-all. Approve the scratch
  // fixture's writes explicitly; the denial scenario overrides this handler.
  h.capabilities.permissions.onAsk(async () => 'yes');
  const model = h.providers[0].getModelInstance();
  model.doStream = async (options) => {
    const userText = [...options.prompt].reverse().find((message) => message.role === 'user');
    const label = JSON.stringify(userText?.content).match(/Concurrent request ([A-Z]\d+)\./)?.[1];
    if (!label) throw new Error('Unexpected model call without a concurrency request');
    const record: ModelCall = {
      label, round: calls.filter((entry) => entry.label === label).length,
      options, cwd: h.capabilities.getCwd(),
      permissionChannel: h.capabilities.permissions.getCurrentChannelId(),
      permissionScopes: h.capabilities.permissions.currentContext().scopes.map((scope) => scope.path),
    };
    calls.push(record);
    const step = await script(record);
    const parts: LanguageModelV3StreamPart[] = [{ type: 'stream-start', warnings: [] }];
    if (step.text) parts.push(
      { type: 'text-start', id: 'text' },
      { type: 'text-delta', id: 'text', delta: step.text },
      { type: 'text-end', id: 'text' },
    );
    if (step.kind === 'tools') step.calls.forEach((tool, index) => parts.push({
      type: 'tool-call', toolCallId: `${label}-${record.round}-${index}`,
      toolName: tool.tool, input: JSON.stringify(tool.input),
    }));
    parts.push({
      type: 'finish',
      finishReason: { unified: step.kind === 'tools' ? 'tool-calls' : 'stop', raw: 'test' },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 10, text: 10, reasoning: 0 },
      },
    });
    return { stream: new ReadableStream({ start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    } }) };
  };
  return h;
}

function inject(h: EvalHarness, sessionId: string, label: string, options: {
  channelId?: string; omitCanonicalId?: boolean; metadata?: Record<string, unknown>; suffix?: string;
} = {}): ChannelMessage {
  const message: ChannelMessage = {
    id: `concurrent-${label}`, channelType: 'web', channelId: options.channelId ?? sessionId,
    senderId: 'eval-owner', senderRole: 'admin', content: `Concurrent request ${label}.${options.suffix ?? ''}`,
    timestamp: Date.now(), ...(options.omitCanonicalId ? {} : { sessionId }),
    ...(options.metadata ? { metadata: options.metadata } : {}),
  };
  h.channel.inject(message);
  return message;
}

function ledger(h: EvalHarness): WorkEntry[] {
  return JSON.parse(readFileSync(join(dirname(h.workDir), 'work-ledger.json'), 'utf8')).entries;
}

function status(h: EvalHarness, message: ChannelMessage): WorkEntry | undefined {
  return ledger(h).find((entry) => entry.key === getWorkKey(message));
}

const reached = (label: string, round = 0): Promise<void> => vi.waitFor(() => {
  expect(calls.some((entry) => entry.label === label && entry.round === round)).toBe(true);
}, { timeout: 2500, interval: 10 });

const delivered = (h: EvalHarness, label: string, targetId: string): Promise<void> => vi.waitFor(() => {
  expect(h.channel.events.some((event) => event.kind === 'delivered' && event.targetId === targetId && event.text === `Answer ${label}.`)).toBe(true);
}, { timeout: 2500, interval: 10 });

afterEach(async () => {
  for (const barrier of gates) barrier.release();
  if (harness) {
    const h = harness;
    // A failed assertion must not leave a blocked model turn running into the
    // next scratch home (or conceal the original failure with teardown noise).
    await vi.waitFor(() => {
      expect(ledger(h).filter((entry) => entry.status === 'running' || entry.status === 'queued')).toEqual([]);
    }, { timeout: 4000, interval: 10 }).catch(() => {});
    await h.dispose();
    harness = undefined;
  }
});

afterAll(removeEvalRoot);

describe('bounded concurrent web sessions through the real Agent', () => {
  it('finishes B while A is blocked, skips queued A2, and preserves A history order', async () => {
    const h = await setup(async ({ label, options }) => {
      if (label === 'A1') await holdA.wait(options.abortSignal);
      return textStep(`Answer ${label}.`);
    });
    const holdA = gate();
    const a = h.sessions.create();
    const b = h.sessions.create();
    const a1 = inject(h, a.id, 'A1');
    await reached('A1');
    const a2 = inject(h, a.id, 'A2');
    const b1 = inject(h, b.id, 'B1');
    await delivered(h, 'B1', b.id);
    expect(calls.map((entry) => entry.label)).toEqual(['A1', 'B1']);
    expect(status(h, a1)?.status).toBe('running');
    expect(status(h, a2)?.status).toBe('queued');
    expect(status(h, b1)?.status).toBe('completed');

    holdA.release();
    await delivered(h, 'A2', a.id);
    expect(h.sessions.get(a.id).messages.filter((message) => message.kind === 'message').map((message) => message.content))
      .toEqual(['Concurrent request A1.', 'Answer A1.', 'Concurrent request A2.', 'Answer A2.']);
    expect(promptText(calls.find((entry) => entry.label === 'A2')!.options.prompt)).toContain('Answer A1.');
    expect(promptText(calls.find((entry) => entry.label === 'B1')!.options.prompt)).not.toContain('Concurrent request A1.');
    expect(h.sessions.get(b.id).messages.filter((message) => message.kind === 'message').map((message) => message.content))
      .toEqual(['Concurrent request B1.', 'Answer B1.']);
    expect(ledger(h).map((entry) => entry.status)).toEqual(['completed', 'completed', 'completed']);
  });

  it('admits at most two independent sessions and starts the next queued session when one finishes', async () => {
    const holds = new Map<string, Gate>();
    let inFlight = 0;
    let peak = 0;
    const h = await setup(async ({ label, options }) => {
      peak = Math.max(peak, ++inFlight);
      try { await holds.get(label)!.wait(options.abortSignal); }
      finally { inFlight--; }
      return textStep(`Answer ${label}.`);
    });
    const sessions = ['A1', 'B1', 'C1'].map((label) => {
      holds.set(label, gate());
      return { label, session: h.sessions.create() };
    });
    const messages = sessions.map(({ label, session }) => inject(h, session.id, label));
    await reached('A1');
    await reached('B1');
    expect(calls.map((entry) => entry.label)).toEqual(['A1', 'B1']);
    expect(status(h, messages[2])?.status).toBe('queued');
    holds.get('B1')!.release();
    await reached('C1');
    expect(status(h, messages[0])?.status).toBe('running');
    expect(peak).toBe(2);
    holds.get('A1')!.release();
    holds.get('C1')!.release();
    await delivered(h, 'C1', sessions[2].session.id);
  });

  it('serializes different transport bindings of the same canonical session before reading its history', async () => {
    const h = await setup(async ({ label, options }) => {
      if (label === 'A1') await holdA.wait(options.abortSignal);
      return textStep(`Answer ${label}.`);
    });
    const holdA = gate();
    const a = h.sessions.create();
    const b = h.sessions.create();
    h.sessions.bind(a.id, 'web', 'second-browser');
    inject(h, a.id, 'A1');
    await reached('A1');
    inject(h, a.id, 'A2', { channelId: 'second-browser', omitCanonicalId: true });
    inject(h, b.id, 'B1');
    await delivered(h, 'B1', b.id);
    expect(calls.map((entry) => entry.label)).toEqual(['A1', 'B1']);
    holdA.release();
    await delivered(h, 'A2', 'second-browser');
    expect(promptText(calls.find((entry) => entry.label === 'A2')!.options.prompt)).toContain('Answer A1.');
    expect(h.sessions.getByBinding('web', 'second-browser')?.id).toBe(a.id);
    expect(h.sessions.get(a.id).messages.filter((message) => message.role === 'assistant').map((message) => message.content))
      .toEqual(['Answer A1.', 'Answer A2.']);
  });

  it('keeps actual cd and create_file tools in each session directory after the other session finishes', async () => {
    const h = await setup(async ({ label, round, options }) => {
      if (round === 0) return toolStep([call('cd', { path: label === 'A1' ? aDir : bDir })]);
      if (round === 1) {
        if (label === 'A1') await holdA.wait(options.abortSignal);
        return toolStep([call('create_file', { path: 'result.txt', content: label })]);
      }
      return textStep(`Answer ${label}.`);
    });
    const holdA = gate();
    const aDir = join(h.workDir, 'alpha');
    const bDir = join(h.workDir, 'beta');
    mkdirSync(aDir); mkdirSync(bDir);
    const a = h.sessions.create();
    const b = h.sessions.create();
    inject(h, a.id, 'A1');
    await reached('A1', 1);
    inject(h, b.id, 'B1');
    await delivered(h, 'B1', b.id);
    expect(h.capabilities.toolLog.filter((entry) => entry.id.startsWith('B1')).map((entry) => entry.output))
      .toEqual([`Changed directory to ${bDir}`, expect.stringContaining(`Successfully created ${join(bDir, 'result.txt')}`)]);
    expect(readFileSync(join(bDir, 'result.txt'), 'utf8')).toBe('B1');
    expect(existsSync(join(aDir, 'result.txt'))).toBe(false);
    holdA.release();
    await delivered(h, 'A1', a.id);
    expect(readFileSync(join(aDir, 'result.txt'), 'utf8')).toBe('A1');
    expect(readFileSync(join(bDir, 'result.txt'), 'utf8')).toBe('B1');
    expect(h.capabilities.getCwd()).toBe(h.workDir);
    for (const record of calls) {
      expect(record.permissionChannel).toBe(record.label === 'A1' ? a.id : b.id);
      if (record.round > 0) expect(record.cwd).toBe(record.label === 'A1' ? aDir : bDir);
    }
  });

  it('does not give B the temporary directory grant approved for A', async () => {
    const h = await setup(async ({ label, round, options }) => {
      if (label === 'A1' && round === 0) return toolStep([call('approve_scope', { path: privateDir, mode: 'write' })]);
      if (label === 'A1' && round === 1) {
        await holdA.wait(options.abortSignal);
        return toolStep([call('create_file', { path: join(privateDir, 'owner.txt'), content: 'allowed A' })]);
      }
      if (label === 'B1' && round === 0) return toolStep([call('create_file', { path: join(privateDir, 'leaked.txt'), content: 'must not be written' })]);
      return textStep(`Answer ${label}.`);
    });
    const holdA = gate();
    const privateAlias = join(dirname(h.workDir), 'private-alpha');
    mkdirSync(privateAlias);
    // Exercise per-session approval here, not the separate symlink-escape
    // denial. macOS temporary directories commonly contain an alias.
    const privateDir = realpathSync(privateAlias);
    const a = h.sessions.create();
    const b = h.sessions.create();
    const prompts: Array<{ channel: string; prompt: string }> = [];
    h.capabilities.permissions.setAutoApproveAll(false);
    h.capabilities.permissions.onAsk(async (prompt) => {
      const channel = h.capabilities.permissions.getCurrentChannelId();
      prompts.push({ channel, prompt });
      return channel === a.id ? 'yes' : 'no';
    });
    inject(h, a.id, 'A1');
    await reached('A1', 1);
    inject(h, b.id, 'B1');
    await delivered(h, 'B1', b.id);
    expect(calls.find((entry) => entry.label === 'A1' && entry.round === 1)?.permissionScopes).toContain(privateDir);
    expect(calls.find((entry) => entry.label === 'B1')?.permissionScopes).not.toContain(privateDir);
    expect(existsSync(join(privateDir, 'leaked.txt'))).toBe(false);
    const denied = h.capabilities.toolLog.find((entry) => entry.id === 'B1-0-0');
    expect(String(denied?.output)).toMatch(/denied/i);
    expect(promptText(calls.find((entry) => entry.label === 'B1' && entry.round === 1)!.options.prompt)).toMatch(/denied/i);
    holdA.release();
    await delivered(h, 'A1', a.id);
    expect(readFileSync(join(privateDir, 'owner.txt'), 'utf8')).toBe('allowed A');
    expect(prompts.some((entry) => entry.channel === a.id)).toBe(true);
    expect(prompts.some((entry) => entry.channel === b.id)).toBe(true);
    expect(h.capabilities.permissions.currentContext().scopes.some((scope) => scope.path === privateDir)).toBe(false);
  });

  it('starts a fresh capability context when a completed turn callback enqueues another session', async () => {
    let queued: Promise<void> | undefined;
    const h = await setup(({ label, round }) => {
      if (label === 'A1' && round === 0) return toolStep([call('cd', { path: aDir })]);
      if (label === 'A1') {
        // Retry timers and deferred callbacks inherit the old turn's ALS.
        // Fire this callback only after A has delivered and released its slot.
        queued = callback.wait().then(() => { inject(h, bId, 'B1'); });
      }
      return textStep(`Answer ${label}.`);
    });
    const callback = gate();
    const aDir = join(h.workDir, 'old-turn');
    mkdirSync(aDir);
    const a = h.sessions.create();
    const bId = h.sessions.create().id;
    inject(h, a.id, 'A1');
    await delivered(h, 'A1', a.id);
    callback.release();
    await queued;
    await delivered(h, 'B1', bId);
    expect(calls.find((entry) => entry.label === 'B1')?.cwd).toBe(h.workDir);
    expect(calls.find((entry) => entry.label === 'B1')?.permissionChannel).toBe(bId);
    expect(h.sessions.get(bId).messages.find((message) => message.role === 'user')?.metadata?.workCwd).toBe(h.workDir);
  });

  it.each(['same', 'nested'] as const)('serializes code sessions with %s workspaces while an unrelated workspace proceeds', async (layout) => {
    const h = await setup(async ({ label, options }) => {
      if (label === 'A1') await holdA.wait(options.abortSignal);
      return textStep(`Answer ${label}.`);
    });
    const holdA = gate();
    const shared = join(h.workDir, 'shared');
    const nested = join(shared, 'nested');
    const separate = join(h.workDir, 'separate');
    mkdirSync(nested, { recursive: true }); mkdirSync(separate);
    const a = h.sessions.create();
    const b = h.sessions.create();
    const c = h.sessions.create();
    const coding = (folder: string) => ({ metadata: { programming: 'plan', programmingCwd: folder } });
    inject(h, a.id, 'A1', coding(shared));
    await reached('A1');
    const b1 = inject(h, b.id, 'B1', coding(layout === 'same' ? shared : nested));
    inject(h, c.id, 'C1', coding(separate));
    await delivered(h, 'C1', c.id);
    expect(calls.map((entry) => entry.label)).toEqual(['A1', 'C1']);
    expect(status(h, b1)?.status).toBe('queued');
    holdA.release();
    await delivered(h, 'B1', b.id);
    expect(calls.find((entry) => entry.label === 'B1')?.cwd).toBe(layout === 'same' ? shared : nested);
    expect(calls.find((entry) => entry.label === 'C1')?.cwd).toBe(separate);
  });

  it.each([false, true])('preserves arrival order through slow research classification (cancel first: %s)', async (cancel) => {
    const h = await setup(({ label }) => textStep(`Answer ${label}.`));
    const classifier = gate();
    let classificationStarted = false;
    h.providers[0].getModelInstance().doGenerate = async () => {
      classificationStarted = true;
      await classifier.wait();
      return {
        content: [{ type: 'text', text: 'NORMAL' }],
        finishReason: { unified: 'stop', raw: 'test' },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
        warnings: [],
      };
    };
    const a = h.sessions.create();
    const b = h.sessions.create();
    const a1 = inject(h, a.id, 'A1', { suffix: ' What happened last week?' });
    await vi.waitFor(() => expect(classificationStarted).toBe(true), { timeout: 2500, interval: 10 });
    const a2 = inject(h, a.id, 'A2');
    inject(h, b.id, 'B1');
    await delivered(h, 'B1', b.id);
    expect(calls.map((entry) => entry.label)).toEqual(['B1']);
    if (cancel) {
      await h.agent.stopSessionWork(a.id);
      expect(status(h, a1)).toMatchObject({ status: 'cancelled', attempts: 0 });
      expect(status(h, a2)).toMatchObject({ status: 'cancelled', attempts: 0 });
    }
    classifier.release();
    if (cancel) {
      // Prove a later independent request can finish after the classifier
      // resolves; neither of the cancelled requests may be resurrected.
      inject(h, b.id, 'B2');
      await delivered(h, 'B2', b.id);
      expect(calls.map((entry) => entry.label)).toEqual(['B1', 'B2']);
      expect(h.sessions.get(a.id).messages).toEqual([]);
    } else {
      await delivered(h, 'A2', a.id);
      expect(calls.map((entry) => entry.label)).toEqual(['B1', 'A1', 'A2']);
      expect(promptText(calls.find((entry) => entry.label === 'A2')!.options.prompt)).toContain('Answer A1.');
    }
  });

  it('cancels durable retry backoff without restarting it or interrupting another active session', async () => {
    const h = await setup(async ({ label, options }) => {
      if (label === 'A1') throw new Error('503 Service Unavailable: fixture outage');
      if (label === 'B1') await holdB.wait(options.abortSignal);
      return textStep(`Answer ${label}.`);
    });
    const holdB = gate();
    const a = h.sessions.create();
    const b = h.sessions.create();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      const a1 = inject(h, a.id, 'A1');
      await vi.waitFor(() => {
        expect(status(h, a1)).toMatchObject({ status: 'queued', attempts: 1, nextAttemptAt: expect.any(Number) });
        expect(h.agent.processing).toBe(false);
      }, { timeout: 2500, interval: 10 });
      const failedCalls = calls.filter((entry) => entry.label === 'A1').length;
      inject(h, b.id, 'B1');
      await reached('B1');
      await h.agent.stopSessionWork(a.id);
      expect(status(h, a1)?.status).toBe('cancelled');
      await vi.advanceTimersByTimeAsync(6000);
      expect(calls.filter((entry) => entry.label === 'A1')).toHaveLength(failedCalls);
      expect(calls.find((entry) => entry.label === 'B1')!.options.abortSignal?.aborted).toBe(false);
      expect(status(h, a1)).toMatchObject({ status: 'cancelled', attempts: 1 });
      holdB.release();
      await delivered(h, 'B1', b.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops only the selected session including its queued alias, leaving B and its queue intact', async () => {
    const holds = new Map<string, Gate>();
    const h = await setup(async ({ label, options }) => {
      if (holds.has(label)) await holds.get(label)!.wait(options.abortSignal);
      return textStep(`Answer ${label}.`);
    });
    holds.set('A1', gate()); holds.set('B1', gate());
    const a = h.sessions.create();
    const b = h.sessions.create();
    h.sessions.bind(a.id, 'web', 'other-tab-a');
    const a1 = inject(h, a.id, 'A1');
    const b1 = inject(h, b.id, 'B1');
    await reached('A1'); await reached('B1');
    const a2 = inject(h, a.id, 'A2', { channelId: 'other-tab-a', omitCanonicalId: true });
    const b2 = inject(h, b.id, 'B2');
    await h.agent.stopSessionWork(a.id);
    expect(calls.find((entry) => entry.label === 'A1')!.options.abortSignal?.aborted).toBe(true);
    expect(calls.find((entry) => entry.label === 'B1')!.options.abortSignal?.aborted).toBe(false);
    expect(status(h, a1)?.status).toBe('cancelled');
    expect(status(h, a2)).toMatchObject({ status: 'cancelled', attempts: 0 });
    expect(status(h, b1)?.status).toBe('running');
    expect(status(h, b2)?.status).toBe('queued');
    holds.get('B1')!.release();
    await delivered(h, 'B2', b.id);
    expect(calls.some((entry) => entry.label === 'A2')).toBe(false);
    expect(status(h, b1)?.status).toBe('completed');
    expect(status(h, b2)?.status).toBe('completed');
    expect(h.sessions.get(b.id).messages.filter((message) => message.kind === 'message').map((message) => message.content))
      .toEqual(['Concurrent request B1.', 'Answer B1.', 'Concurrent request B2.', 'Answer B2.']);
    expect(h.channel.events.some((event) => event.text === 'Answer A1.' || event.text === 'Answer A2.')).toBe(false);
    // A transport redelivery cannot resurrect a cancelled queued operation.
    h.channel.inject(a2);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(status(h, a2)).toMatchObject({ status: 'cancelled', attempts: 0 });
    expect(calls.some((entry) => entry.label === 'A2')).toBe(false);
  });
});
