import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChannelMessage } from '../types/channel.js';
import { Agent, laneKeyFor } from './agent.js';
import { WorkLedger } from './work-ledger.js';
import { bareTurnFields } from './testing/fake-turns.js';

/**
 * ADR-037: chats run at once, each in its own lane; one chat's messages
 * still run strictly one after another; every turn sees only its own state;
 * the governor's limit holds extra chats back; a stop in one chat leaves the
 * others running.
 */

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const tick = (ms = 1) => new Promise<void>((r) => setTimeout(r, ms));

function msg(id: string, channelId: string, channelType: ChannelMessage['channelType'] = 'web'): ChannelMessage {
  return { id, channelId, channelType, senderId: 'u', content: `do ${id}`, timestamp: Date.now(), metadata: {} };
}

interface Gate { open: () => void; promise: Promise<void> }
function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((r) => { open = r; });
  return { open, promise };
}

function harness(limit = 4) {
  const dir = mkdtempSync(join(tmpdir(), 'mercury-concurrent-'));
  dirs.push(dir);
  const workLedger = new WorkLedger({ filePath: join(dir, 'work-ledger.json') });
  const agent = Object.create(Agent.prototype) as Agent;
  const gates = new Map<string, Gate>();
  const log: string[] = [];
  /** What each turn saw of "its own" state after its awaits. */
  const seen = new Map<string, { message: string | undefined; abortIsMine: boolean; activity: string }>();
  Object.assign(agent, {
    ...bareTurnFields({ limit }),
    workLedger,
    running: true,
    channels: { get: () => undefined, getChannelForMessage: () => undefined },
    globalLifecycle: { is: () => true },
    supervisor: undefined,
    withSessionProgramming: (_m: unknown, run: () => Promise<void>) => run(),
    handleMessage: async (m: ChannelMessage) => {
      const self = agent as unknown as { currentAbort: AbortController | null; currentActivity: string; currentMessage: ChannelMessage | null };
      const mine = new AbortController();
      self.currentAbort = mine;
      self.currentActivity = `working on ${m.id}`;
      log.push(`start ${m.id}`);
      const g = gate();
      gates.set(m.id, g);
      await Promise.race([g.promise, new Promise<void>((r) => mine.signal.addEventListener('abort', () => r()))]);
      await tick();
      seen.set(m.id, { message: self.currentMessage?.id, abortIsMine: self.currentAbort === mine, activity: self.currentActivity });
      log.push(`${mine.signal.aborted ? 'aborted' : 'end'} ${m.id}`);
      workLedger.markCompleted((agent as unknown as { currentWorkKey: string }).currentWorkKey, 'done');
    },
  });
  const send = (m: ChannelMessage) => {
    agent.queueMessage(m, workLedger.accept(m).entry.key);
    (agent as unknown as { processQueue(): void }).processQueue();
  };
  const finish = async (id: string) => {
    for (let i = 0; i < 100 && !gates.has(id); i++) await tick();
    gates.get(id)!.open();
    await tick(5);
  };
  return { agent, send, finish, log, seen };
}

describe('concurrent turns', () => {
  it('two chats run at the same time', async () => {
    const { agent, send, finish, log } = harness();
    send(msg('a1', 'chat-a'));
    send(msg('b1', 'chat-b'));
    await tick(5);
    expect(log).toEqual(['start a1', 'start b1']);
    expect(agent.activeTurnCount).toBe(2);
    await finish('b1');
    await finish('a1');
    await agent.whenIdle();
    expect(log).toEqual(['start a1', 'start b1', 'end b1', 'end a1']);
  });

  it("one chat's messages run one after another, in order", async () => {
    const { agent, send, finish, log } = harness();
    send(msg('a1', 'chat-a'));
    send(msg('a2', 'chat-a'));
    send(msg('b1', 'chat-b'));
    await tick(5);
    expect(log).toEqual(['start a1', 'start b1']);
    await finish('a1');
    expect(log.slice(-1)).toEqual(['start a2']);
    await finish('a2');
    await finish('b1');
    await agent.whenIdle();
    expect(log.filter((l) => l.endsWith('a1') || l.endsWith('a2'))).toEqual(['start a1', 'end a1', 'start a2', 'end a2']);
  });

  it('every turn sees its own message, abort controller and activity', async () => {
    const { agent, send, finish, seen } = harness();
    send(msg('a1', 'chat-a'));
    send(msg('b1', 'chat-b'));
    send(msg('c1', 'chat-c'));
    await tick(5);
    await finish('b1');
    await finish('c1');
    await finish('a1');
    await agent.whenIdle();
    for (const id of ['a1', 'b1', 'c1']) {
      expect(seen.get(id)).toEqual({ message: id, abortIsMine: true, activity: `working on ${id}` });
    }
    // Outside any turn there is no "current" turn state.
    expect(agent.currentMessage).toBeNull();
    expect(agent.currentActivity).toBe('');
  });

  it('the limit holds extra chats back until a slot frees', async () => {
    const { agent, send, finish, log } = harness(2);
    send(msg('a1', 'chat-a'));
    send(msg('b1', 'chat-b'));
    send(msg('c1', 'chat-c'));
    await tick(5);
    expect(log).toEqual(['start a1', 'start b1']);
    expect(agent.queueStateFor('chat-c')).toMatchObject({ state: 'queued', position: 1 });
    await finish('a1');
    expect(log).toContain('start c1');
    await finish('b1');
    await finish('c1');
    await agent.whenIdle();
  });

  it('/stop in one chat stops only that chat', async () => {
    const { agent, send, finish, log } = harness();
    send(msg('a1', 'chat-a'));
    send(msg('b1', 'chat-b'));
    await tick(5);
    const note = await agent.stopAllWork('stopped', { channelId: 'chat-a' });
    expect(note).toMatch(/Stopped this chat's task/);
    expect(note).toMatch(/1 task in other chats keeps running/);
    await tick(5);
    expect(log).toContain('aborted a1');
    expect(log).not.toContain('aborted b1');
    expect(agent.activeTurnCount).toBe(1);
    expect(await agent.stopAllWork('stopped', { channelId: 'chat-z' })).toMatch(/^Nothing is running in this chat\./);
    await finish('b1');
    await agent.whenIdle();
  });

  it('/halt stops every chat', async () => {
    const { agent, send, log } = harness();
    send(msg('a1', 'chat-a'));
    send(msg('b1', 'chat-b'));
    await tick(5);
    await agent.stopAllWork('halted');
    await agent.whenIdle();
    expect(log).toContain('aborted a1');
    expect(log).toContain('aborted b1');
  });
});

describe('laneKeyFor', () => {
  it('a session id names the lane; otherwise the channel conversation', () => {
    expect(laneKeyFor({ ...msg('x', 'req-1'), sessionId: 's1' })).toBe('session:s1');
    expect(laneKeyFor({ ...msg('x', 'req-2'), metadata: { sessionId: 's1' } })).toBe('session:s1');
    expect(laneKeyFor(msg('x', '12345', 'telegram'))).toBe('telegram:12345');
    expect(laneKeyFor({ ...msg('x', 'ch', 'web'), metadata: { externalConversationId: 'conv' } })).toBe('web:conv');
  });

  it('the terminal is one lane, and each scheduled task its own', () => {
    expect(laneKeyFor(msg('x', 'cli', 'cli'))).toBe('cli');
    expect(laneKeyFor({ ...msg('x', 'internal', 'internal'), metadata: { scheduledTaskId: 't1' } })).toBe('internal:t1');
    expect(laneKeyFor({ ...msg('x', 'internal', 'internal'), metadata: { scheduledTaskId: 't2' } })).toBe('internal:t2');
  });
});

describe('one stored conversation, two lanes', () => {
  it('turns take the conversation one at a time, in order, and the lock is forgotten after', async () => {
    const agent = Object.create(Agent.prototype) as Agent;
    Object.assign(agent, { sessionLocks: new Map() });
    const lock = (id: string) => (agent as unknown as { lockSession(id: string): Promise<() => void> }).lockSession(id);
    const order: string[] = [];
    const releaseA = await lock('s1');
    const b = lock('s1').then((release) => { order.push('b'); return release; });
    const c = lock('s1').then((release) => { order.push('c'); return release; });
    const other = await lock('s2'); // a different conversation is never held up
    other();
    await tick(2);
    expect(order).toEqual([]);
    releaseA();
    const releaseB = await b;
    await tick(2);
    expect(order).toEqual(['b']);
    releaseB();
    releaseB(); // releasing twice is harmless
    (await c)();
    expect(order).toEqual(['b', 'c']);
    expect((agent as unknown as { sessionLocks: Map<string, unknown> }).sessionLocks.size).toBe(0);
  });
});

describe('a stop typed in an idle chat (it runs as that chat\'s own turn)', () => {
  it('never aborts itself, and leaves other chats running', async () => {
    const { agent, send, finish, log } = harness();
    send(msg('b1', 'chat-b'));
    await tick(5);
    // Simulate the /stop command running as chat-a's own turn.
    const internal = agent as unknown as { activeTurns: Map<string, unknown>; turnStore: { run<T>(s: unknown, fn: () => T): T } };
    const { startFakeTurn } = await import('./testing/fake-turns.js');
    const own = startFakeTurn(agent, msg('stop', 'chat-a')) as unknown as { abort: AbortController; id: string };
    const note = await internal.turnStore.run(own, () => agent.stopAllWork('stopped', { channelId: 'chat-a' }));
    expect(own.abort.signal.aborted).toBe(false);
    expect(note).toBe('Nothing is running in this chat. 1 task in other chats keeps running — /halt stops everything.');
    internal.activeTurns.delete('web:chat-a');
    expect(log).not.toContain('aborted b1');
    await finish('b1');
    await agent.whenIdle();
  });
});
