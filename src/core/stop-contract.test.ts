import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChannelMessage } from '../types/channel.js';
import { Agent, stopNoteFor } from './agent.js';
import { WorkLedger } from './work-ledger.js';
import { bareTurnFields, startFakeTurn } from './testing/fake-turns.js';

/**
 * ADR-038: a stop is final. Whatever the turn was doing (a stall retry in
 * flight, a provider fallback, a continuation round, a durable retry), it
 * never carries on, and nothing the chat had waiting starts in its place.
 */

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function msg(id: string, channelId: string): ChannelMessage {
  return { id, channelId, channelType: 'web', senderId: 'u', content: `do ${id}`, timestamp: Date.now(), metadata: {} };
}

function bare() {
  const dir = mkdtempSync(join(tmpdir(), 'mercury-stop-'));
  dirs.push(dir);
  const workLedger = new WorkLedger({ filePath: join(dir, 'work-ledger.json') });
  const agent = Object.create(Agent.prototype) as Agent;
  Object.assign(agent, { ...bareTurnFields(), workLedger, running: true, channels: { get: () => undefined }, globalLifecycle: { is: () => true } });
  const internals = agent as unknown as {
    turnStore: { run<T>(s: unknown, fn: () => T): T };
    currentAbort: AbortController | null;
    currentAbortReason: string | null;
    scheduleDurableRetry(m: ChannelMessage, key: string, err: unknown, continuation?: boolean): number;
    runQueuedItem(item: { message: ChannelMessage; workKey?: string }): Promise<void>;
    messageQueue: Array<{ message: ChannelMessage; workKey?: string }>;
    capabilities: { getCwd(): string };
  };
  return { agent, workLedger, internals };
}

describe('a stop is sticky for the turn', () => {
  it('lands even while a stall retry has the controller aborted, and the retry gets a dead controller', () => {
    const { agent, internals } = bare();
    const t = startFakeTurn(agent, msg('a', 'chat-a')) as unknown as { abort: AbortController; cancelled: string | null };
    internals.turnStore.run(t, () => {
      // The stall watchdog aborted the attempt to retry it...
      internals.currentAbortReason = 'stalled';
      t.abort.abort();
      // ...and the owner presses Stop in that window.
      agent.abortTurn(t as never, 'stopped', 'Stopped by the user (/stop).');
      expect(t.cancelled).toBe('stopped');
      // The stall branch clears its reason and makes a fresh controller:
      internals.currentAbortReason = null;
      const fresh = new AbortController();
      internals.currentAbort = fresh;
      expect(fresh.signal.aborted).toBe(true);
      expect(internals.currentAbortReason).toBe('stopped');
      // Internal reasons can never overwrite it either.
      internals.currentAbortReason = 'time-limit';
      expect(internals.currentAbortReason).toBe('stopped');
    });
  });

  it('a second stop is a no-op', async () => {
    const { agent } = bare();
    const t = startFakeTurn(agent, msg('a', 'chat-a')) as unknown as { cancelled: string | null };
    expect(agent.abortTurn(t as never, 'stopped')).toBe(true);
    expect(agent.abortTurn(t as never, 'halted')).toBe(false);
    expect(t.cancelled).toBe('stopped');
  });

  it('the stop note is the one desktop recognises', () => {
    expect(stopNoteFor('stopped')).toMatch(/^⏹ Task stopped\b/);
    expect(stopNoteFor('halted')).toMatch(/^⏹ Task halted\b/);
  });
});

describe('stopped work is never retried or resumed', () => {
  it('a durable retry from a stopped turn does nothing and the entry stays cancelled', () => {
    vi.useFakeTimers();
    try {
      const { agent, workLedger, internals } = bare();
      const m = msg('a', 'chat-a');
      const key = workLedger.accept(m).entry.key;
      workLedger.markRunning(key);
      const t = startFakeTurn(agent, m) as unknown as { workKey: string | null };
      t.workKey = key;
      internals.turnStore.run(t, () => {
        agent.abortTurn(t as never, 'stopped', 'Stopped by the user (/stop).');
        expect(internals.scheduleDurableRetry(m, key, new Error('aborted after a tool completed'), true)).toBe(0);
      });
      vi.advanceTimersByTime(10 * 60_000);
      expect(workLedger.get(key)?.status).toBe('cancelled');
      expect(internals.messageQueue).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the ledger refuses to turn a cancelled entry back into a retry', () => {
    const { workLedger } = bare();
    const key = workLedger.accept(msg('a', 'chat-a')).entry.key;
    workLedger.markRunning(key);
    workLedger.markCancelled(key, 'stopped');
    workLedger.markRetry(key, new Error('x'), Date.now() + 1000, { continuation: true });
    workLedger.markPaused(key, 'x');
    workLedger.markFailed(key, new Error('x'));
    expect(workLedger.get(key)?.status).toBe('cancelled');
  });

  it('a cancelled entry that was already back in line never runs', async () => {
    const { agent, workLedger, internals } = bare();
    const handle = vi.fn();
    Object.assign(agent, { handleMessage: handle, withSessionProgramming: (_m: unknown, run: () => Promise<void>) => run() });
    const m = msg('a', 'chat-a');
    const key = workLedger.accept(m).entry.key;
    workLedger.markCancelled(key, 'stopped');
    await internals.runQueuedItem({ message: m, workKey: key });
    expect(handle).not.toHaveBeenCalled();
  });
});

describe("a stop clears the chat's line", () => {
  it("drops this chat's waiting messages (cancelled, never replayed); other chats keep theirs", async () => {
    const { agent, workLedger, internals } = bare();
    const running = startFakeTurn(agent, msg('a1', 'chat-a'));
    const queue = (m: ChannelMessage) => { const key = workLedger.accept(m).entry.key; agent.queueMessage(m, key); return key; };
    const a2 = queue(msg('a2', 'chat-a'));
    const b1 = queue(msg('b1', 'chat-b'));
    const note = await agent.stopAllWork('stopped', { channelId: 'chat-a' });
    expect(running.abort.signal.aborted).toBe(true);
    expect(note).toMatch(/^Stopped this chat's task, dropped 1 waiting message\./);
    expect(internals.messageQueue.map((i) => i.message.id)).toEqual(['b1']);
    expect(workLedger.get(a2)?.status).toBe('cancelled');
    expect(workLedger.get(b1)?.status).toBe('queued');
  });

  it('"do mine first" (keepQueued) stops the running turn only', async () => {
    const { agent, workLedger, internals } = bare();
    startFakeTurn(agent, msg('a1', 'chat-a'));
    const key = workLedger.accept(msg('a2', 'chat-a')).entry.key;
    agent.queueMessage(msg('a2', 'chat-a'), key);
    await agent.stopAllWork('stopped', { channelId: 'chat-a', keepQueued: true });
    expect(internals.messageQueue.map((i) => i.message.id)).toEqual(['a2']);
  });

  it('/halt empties the whole line', async () => {
    const { agent, workLedger, internals } = bare();
    startFakeTurn(agent, msg('a1', 'chat-a'));
    for (const m of [msg('a2', 'chat-a'), msg('b1', 'chat-b')]) agent.queueMessage(m, workLedger.accept(m).entry.key);
    await agent.stopAllWork('halted');
    expect(internals.messageQueue).toEqual([]);
  });
});
