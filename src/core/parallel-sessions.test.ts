import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChannelMessage } from '../types/channel.js';
import { Agent } from './agent.js';
import { runWithTurn, testTurn } from './turn-state.js';
import { WorkLedger } from './work-ledger.js';

/**
 * Parallel working sessions: several sessions may be mid-turn at once.
 * A turn running in one session must not block another from starting;
 * cancellation is scoped to its own session; and two turns never share
 * a working folder.
 */

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function msg(id: string, channelId: string, extra: Record<string, unknown> = {}, channelType = 'web'): ChannelMessage {
  return { id, channelId, channelType: channelType as ChannelMessage['channelType'], senderId: 'web_user', content: id, timestamp: 1, metadata: { ...extra } };
}

/** Real Agent with empty internals, but handleMessage stubbed to a controllable gate. */
function controllableAgent() {
  const dir = mkdtempSync(join(tmpdir(), 'mercury-parallel-'));
  dirs.push(dir);
  const workLedger = new WorkLedger({ filePath: join(dir, 'work-ledger.json') });
  const agent = Object.create(Agent.prototype) as Agent;
  const started: string[] = [];
  const releaseFns = new Map<string, () => void>();
  Object.assign(agent, {
    messageQueue: [],
    queuedWorkKeys: new Set(),
    workLedger,
    turns: new Map(),
    draining: false,
    lastTypingAtByTurn: new Map(),
    running: true,
    config: {},
    lifecycle: { is: () => true, canTransitionTo: () => true, transition: () => true },
    channels: { get: () => undefined, getChannelForMessage: () => undefined },
  });
  // Stub the turn body: record the start, then wait until released.
  // IMPORTANT: private-field access from outside — cast through unknown.
  (agent as unknown as { handleMessage: (m: ChannelMessage) => Promise<void> }).handleMessage = async (m: ChannelMessage) => {
    started.push(m.id);
    await new Promise<void>((resolve) => { releaseFns.set(m.id, resolve); });
  };
  (agent as unknown as { withSessionProgramming: (m: ChannelMessage, run: () => Promise<void>) => Promise<void> }).withSessionProgramming =
    async (_m, run) => { await run(); };
  const enqueue = (m: ChannelMessage, meta: Record<string, unknown> = {}) => {
    const full: ChannelMessage = { ...m, metadata: { ...(m.metadata as object ?? {}), ...meta } };
    agent.queueMessage(full, workLedger.accept(full).entry.key);
  };
  const release = (id: string) => releaseFns.get(id)?.();
  const flush = () => new Promise((r) => setTimeout(r, 20));
  return { agent, enqueue, started, release, flush };
}

describe('parallel working sessions', () => {
  it('two sessions run concurrently — B starts before A finishes', async () => {
    const { agent, enqueue, started, release, flush } = controllableAgent();
    enqueue(msg('a', 'web:a'));
    await flush();
    expect(started).toEqual(['a']);
    enqueue(msg('b', 'web:b'));
    await flush();
    // B started while A is still mid-turn (its gate is still closed).
    expect(started).toEqual(['a', 'b']);
    expect(agent.activeTurnCount).toBe(2);
    release('a');
    release('b');
    await flush();
  });

  it('the same session never runs two turns at once', async () => {
    const { agent, enqueue, started, release, flush } = controllableAgent();
    enqueue(msg('a1', 'web:a'));
    await flush();
    enqueue(msg('a2', 'web:a'));
    await flush();
    expect(started).toEqual(['a1']);
    expect((agent as unknown as { messageQueue: unknown[] }).messageQueue.length).toBe(1);
    release('a1');
    await flush();
    // The drain re-scans when a turn ends and starts the waiting message.
    expect(started).toEqual(['a1', 'a2']);
    release('a2');
    await flush();
  });

  it('the concurrency cap holds excess turns queued until a slot frees', async () => {
    const { agent, enqueue, started, release, flush } = controllableAgent();
    Object.assign(agent, { config: { maxConcurrentSessions: 1 } });
    enqueue(msg('a', 'web:a'));
    await flush();
    enqueue(msg('b', 'web:b'));
    await flush();
    expect(started).toEqual(['a']);
    expect(agent.activeTurnCount).toBe(1);
    expect((agent as unknown as { messageQueue: unknown[] }).messageQueue.length).toBe(1);
    release('a');
    await flush();
    expect(started).toEqual(['a', 'b']);
    release('b');
    await flush();
  });

  it('stopping one session leaves the other running', async () => {
    const { agent, enqueue, started, release, flush } = controllableAgent();
    enqueue(msg('a', 'web:a'));
    await flush();
    enqueue(msg('b', 'web:b'));
    await flush();
    expect(started).toEqual(['a', 'b']);
    expect(agent.stopWorkFor('web:b')).toBe(true);
    const keys = agent.getActiveSessionKeysForTest();
    expect(keys).not.toContain('web:b');
    expect(keys).toContain('web:a');
    release('a');
    release('b');
    await flush();
  });

  it('workspace exclusion: same folder waits, different folders run', async () => {
    const { agent, enqueue, started, release, flush } = controllableAgent();
    enqueue(msg('a', 'web:a'), { workCwd: '/tmp/same' });
    await flush();
    expect(started).toEqual(['a']);
    enqueue(msg('b', 'web:b'), { workCwd: '/tmp/same' });
    await flush();
    // Blocked on the busy folder — still queued.
    expect(started).toEqual(['a']);
    expect((agent as unknown as { messageQueue: unknown[] }).messageQueue.length).toBe(1);
    enqueue(msg('c', 'web:c'), { workCwd: '/tmp/other' });
    await flush();
    expect(started).toEqual(['a', 'c']);
    release('a');
    await flush();
    // Folder freed — the waiting turn starts.
    expect(started).toEqual(['a', 'c', 'b']);
    release('b');
    release('c');
    await flush();
  });

  it('scheduled work gets its own session key and never blocks chat', async () => {
    const { agent } = controllableAgent();
    const chat = msg('chat1', 'web:a');
    const cron1 = msg('cron1', 'internal', { scheduledTaskId: 'nightly' }, 'internal');
    const cron2 = msg('cron2', 'internal', { scheduledTaskId: 'nightly' }, 'internal');
    expect(agent.sessionKeyFor(chat)).toBe('web:a');
    expect(agent.sessionKeyFor(cron1)).toBe('scheduled:nightly');
    expect(agent.sessionKeyFor(cron2)).toBe('scheduled:nightly');
    expect(agent.sessionKeyFor(cron1)).not.toBe(agent.sessionKeyFor(chat));
  });

  it('ambient-turn isolation: concurrent contexts see their own fields', async () => {
    const t1 = testTurn({ sessionKey: 'a', activity: 'one' });
    const t2 = testTurn({ sessionKey: 'b', activity: 'two' });
    const { currentTurn } = await import('./turn-state.js');
    const seen: string[] = [];
    await Promise.all([
      runWithTurn(t1, async () => {
        await new Promise((r) => setTimeout(r, 10));
        seen.push(currentTurn()?.activity ?? '?');
      }),
      runWithTurn(t2, async () => {
        seen.push(currentTurn()?.activity ?? '?');
      }),
    ]);
    expect(seen.sort()).toEqual(['one', 'two']);
  });

  it('announceQueue reports queue positions per chat, not the old global flags', async () => {
    const { agent, enqueue, flush } = controllableAgent();
    const sent: Array<{ target: string; position: number }> = [];
    Object.assign(agent, {
      channels: {
        get: (t: string) => (t === 'web' ? { sendQueued: (target: string, d: { position: number }) => sent.push({ target, ...d }) } : undefined),
        getChannelForMessage: () => undefined,
      },
    });
    // Occupy the single slot so later items wait and get announced.
    Object.assign(agent, { config: { maxConcurrentSessions: 1 } });
    enqueue(msg('a', 'web:a'));
    await flush();
    sent.length = 0;
    enqueue(msg('b', 'web:b'));
    await flush();
    expect(sent.map((s) => s.target)).toContain('web:b');
    vi.restoreAllMocks();
  });
});
