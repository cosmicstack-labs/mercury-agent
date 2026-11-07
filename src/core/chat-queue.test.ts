import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChannelMessage } from '../types/channel.js';
import { Agent } from './agent.js';
import { WorkLedger } from './work-ledger.js';

/**
 * Two chats at once on the desktop: Mercury runs one turn at a time, so the
 * second waits. It must say so (its place in line, and what's ahead of it)
 * instead of showing "Thinking" for a turn that hasn't started — and the
 * owner can put it first.
 */

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function msg(id: string, channelId: string, content = id): ChannelMessage {
  return { id, channelId, channelType: 'web', senderId: 'web_user', content, timestamp: 1, metadata: {} };
}

function agentWithWeb() {
  const dir = mkdtempSync(join(tmpdir(), 'mercury-chat-queue-'));
  dirs.push(dir);
  const workLedger = new WorkLedger({ filePath: join(dir, 'work-ledger.json') });
  const sent: Array<{ target: string; position: number; busyWith?: string; busySessionId?: string }> = [];
  const web = { sendQueued: (target: string, d: { position: number; busyWith?: string; busySessionId?: string }) => sent.push({ target, ...d }) };
  const agent = Object.create(Agent.prototype) as Agent;
  Object.assign(agent, {
    messageQueue: [], queuedWorkKeys: new Set(), workLedger, processing: false, currentMessage: null, currentActivity: '', currentAbort: null,
    channels: { get: (t: string) => (t === 'web' ? web : undefined) },
  });
  const enqueue = (m: ChannelMessage) => agent.queueMessage(m, workLedger.accept(m).entry.key);
  return { agent, enqueue, sent };
}

describe('a chat waiting for another', () => {
  it('is told its place in line and what is running, as soon as it joins', () => {
    const { agent, enqueue, sent } = agentWithWeb();
    Object.assign(agent, { processing: true, currentMessage: msg('r', 'research', 'Research the top news on TechCrunch today') });
    enqueue(msg('j', 'jokes', 'tell me a joke'));
    expect(sent).toEqual([{ target: 'jokes', position: 1, busyWith: 'Research the top news on TechCrunch today', busySessionId: 'research' }]);
    expect(agent.queueStateFor('jokes')).toMatchObject({ state: 'queued', position: 1, busySessionId: 'research' });
    expect(agent.queueStateFor('research')).toEqual({ state: 'running' });
    expect(agent.queueStateFor('other')).toEqual({ state: 'none' });
  });

  it('says nothing when nothing is running (the turn starts at once)', () => {
    const { enqueue, sent } = agentWithWeb();
    enqueue(msg('j', 'jokes'));
    expect(sent).toEqual([]);
  });

  it('uses what the running turn is doing right now, when known', () => {
    const { agent, enqueue, sent } = agentWithWeb();
    const running = msg('r', 'research', 'Research the top news');
    Object.assign(agent, { processing: true, currentMessage: running, currentActivity: '🔎 Searching the web' });
    enqueue(msg('j', 'jokes'));
    expect(sent[0].busyWith).toBe('Searching the web');
  });

  it('"do mine first" moves the chat to the front and tells everyone their new place', () => {
    const { agent, enqueue, sent } = agentWithWeb();
    Object.assign(agent, { processing: true, currentMessage: msg('r', 'research') });
    enqueue(msg('a', 'alpha'));
    enqueue(msg('b', 'beta'));
    sent.length = 0;
    expect(agent.prioritize('beta')).toBe(1);
    expect(sent.map((s) => `${s.target}@${s.position}`)).toEqual(['beta@1', 'alpha@2']);
    expect(agent.prioritize('nobody')).toBe(0);
  });
});
