import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChannelMessage } from '../types/channel.js';
import { Agent } from './agent.js';
import { WorkLedger } from './work-ledger.js';
import { bareTurnFields, startFakeTurn, endFakeTurns } from './testing/fake-turns.js';

/**
 * Questions asked on a call: someone is waiting on the line, so they go
 * ahead of queued chat work, and stopping the call cancels the ones that
 * never started (or a restart would run them after all).
 */

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function msg(id: string, channelId: string, voiceCall = false): ChannelMessage {
  return { id, channelId, channelType: channelId.split(':')[0] as ChannelMessage['channelType'], senderId: 'local', content: id, timestamp: 1, metadata: voiceCall ? { voiceCall: true } : {} };
}

function bareAgent() {
  const dir = mkdtempSync(join(tmpdir(), 'mercury-voice-queue-'));
  dirs.push(dir);
  const workLedger = new WorkLedger({ filePath: join(dir, 'work-ledger.json') });
  const agent = Object.create(Agent.prototype) as Agent;
  Object.assign(agent, { ...bareTurnFields(), workLedger });
  const enqueue = (m: ChannelMessage) => { const key = workLedger.accept(m).entry.key; agent.queueMessage(m, key); return key; };
  const order = () => (agent as unknown as { messageQueue: Array<{ message: ChannelMessage }> }).messageQueue.map((i) => i.message.id);
  return { agent, workLedger, enqueue, order };
}

describe('voice questions in the work queue', () => {
  it('go ahead of queued chat work, in the order they were asked', () => {
    const { agent, enqueue, order } = bareAgent();
    enqueue(msg('chat1', 'web:a'));
    enqueue(msg('chat2', 'web:b'));
    enqueue(msg('voice1', 'desktop:call:x', true));
    enqueue(msg('voice2', 'desktop:call:x', true));
    expect(order()).toEqual(['voice1', 'voice2', 'chat1', 'chat2']);
    expect(agent.workStateFor('desktop:call:x').state).toBe('queued');
    expect(agent.workStateFor('web:c').state).toBe('none');
  });

  it('say what Mercury is busy with when it is something else', () => {
    const { agent, enqueue } = bareAgent();
    enqueue(msg('voice1', 'desktop:call:x', true));
    startFakeTurn(agent, msg('long', 'web:a'), '📄 Reading report.md');
    expect(agent.workStateFor('desktop:call:x')).toEqual({ state: 'queued', busyWith: 'Reading report.md' });
    endFakeTurns(agent);
    startFakeTurn(agent, msg('voice1', 'desktop:call:x', true));
    expect(agent.workStateFor('desktop:call:x').state).toBe('running');
  });

  it('stopping a call cancels its queued questions, so a restart never replays them', () => {
    const { agent, workLedger, enqueue, order } = bareAgent();
    const chat = enqueue(msg('chat1', 'web:a'));
    const v1 = enqueue(msg('voice1', 'desktop:call:x', true));
    const v2 = enqueue(msg('voice2', 'desktop:call:x', true));
    expect(agent.stopWorkFor('desktop:call:x')).toBe(true);
    expect(order()).toEqual(['chat1']);
    expect(workLedger.get(v1)?.status).toBe('cancelled');
    expect(workLedger.get(v2)?.status).toBe('cancelled');
    expect(workLedger.get(chat)?.status).toBe('queued');
    // The same question asked again can be queued afresh.
    agent.queueMessage(msg('voice1', 'desktop:call:x', true), v1);
    expect(order()).toEqual(['voice1', 'chat1']);
  });
});

describe('stopping one call (ADR-037)', () => {
  it('stops only the running turn of that call; another chat keeps running', () => {
    const { agent, enqueue } = bareAgent();
    enqueue(msg('chat2', 'web:b'));
    const call = startFakeTurn(agent, msg('voice1', 'desktop:call:x', true));
    const chat = startFakeTurn(agent, msg('chat1', 'web:a'));
    expect(agent.stopWorkFor('desktop:call:x')).toBe(true);
    expect(call.abort.signal.aborted).toBe(true);
    expect(chat.abort.signal.aborted).toBe(false);
  });
});
