import { afterAll, describe, expect, it } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from '@ai-sdk/provider';
import type { ChannelMessage } from '../../types/channel.js';
import { EvalHarness } from '../runner.js';

/**
 * ADR-037 end to end: the real Agent (real handleMessage, sessions,
 * permissions, capability registry) with a model that holds each call until
 * the test lets it answer. Two chats run at once and each turn — deep inside
 * the AI SDK's call into the model — sees only its own message, permission
 * identity and session; one chat's messages still run one after another.
 */

interface Call { text: string; currentMessageId?: string; permissionChannel: string; release: () => void }

const tick = (ms = 5) => new Promise<void>((r) => setTimeout(r, ms));

function lastUserText(options: LanguageModelV3CallOptions): string {
  for (let i = options.prompt.length - 1; i >= 0; i--) {
    const m = options.prompt[i];
    if (m.role !== 'user') continue;
    const part = m.content.find((p) => p.type === 'text');
    if (part && part.type === 'text') return part.text;
  }
  return '';
}

async function gatedHarness(name: string) {
  const harness = await EvalHarness.create({ name, turns: [], channel: { type: 'telegram', style: 'plain' } }, { fakeTimers: false });
  const calls: Call[] = [];
  const model = new MockLanguageModelV3({
    provider: 'eval.gated',
    modelId: 'gated-model',
    doStream: async (options) => {
      const text = lastUserText(options);
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      calls.push({
        text,
        currentMessageId: harness.agent.currentMessage?.id,
        permissionChannel: harness.capabilities.permissions.currentContext().channelId,
        release,
      });
      // Like a real provider request, an abort ends the call at once.
      await new Promise<void>((resolve, reject) => {
        const signal = options.abortSignal;
        if (signal?.aborted) return reject(signal.reason ?? new Error('Aborted'));
        signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('Aborted')), { once: true });
        void gate.then(resolve);
      });
      const parts: LanguageModelV3StreamPart[] = [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't0' },
        { type: 'text-delta', id: 't0', delta: `reply to ${text}` },
        { type: 'text-end', id: 't0' },
        { type: 'finish', usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } }, finishReason: { unified: 'stop', raw: 'stop' } },
      ];
      return { stream: new ReadableStream<LanguageModelV3StreamPart>({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } }) };
    },
  });
  for (const p of harness.providers) (p as unknown as { getModelInstance: () => unknown }).getModelInstance = () => model;
  const send = (id: string, chat: string, text: string) => {
    const message: ChannelMessage = { id, channelId: chat, channelType: 'telegram', senderId: 'eval-user', content: text, timestamp: Date.now() };
    harness.channel.inject(message);
  };
  const waitForCalls = async (n: number) => {
    for (let i = 0; i < 400 && calls.length < n; i++) await tick();
    return calls.length;
  };
  const delivered = (chat: string) => harness.channel.events.filter((e) => e.kind === 'delivered' && e.targetId === chat).map((e) => e.text);
  return { harness, calls, send, waitForCalls, delivered };
}

describe('eval · chats run at the same time (ADR-037)', () => {
  afterAll(async () => {
    const { removeEvalRoot } = await import('../env.js');
    removeEvalRoot();
  });

  it('two chats are answered at once, each with its own identity and session', async () => {
    const { harness, calls, send, waitForCalls, delivered } = await gatedHarness('concurrency-two-chats');
    try {
      send('m-a', 'chat-a', 'hello alpha');
      send('m-b', 'chat-b', 'hello bravo');
      // Both model calls are in flight before either answers.
      expect(await waitForCalls(2)).toBe(2);
      expect(harness.agent.activeTurnCount).toBe(2);
      const a = calls.find((c) => c.text === 'hello alpha')!;
      const b = calls.find((c) => c.text === 'hello bravo')!;
      expect(a).toMatchObject({ currentMessageId: 'm-a', permissionChannel: 'chat-a' });
      expect(b).toMatchObject({ currentMessageId: 'm-b', permissionChannel: 'chat-b' });
      // The second chat finishes first; the first is unaffected.
      b.release();
      for (let i = 0; i < 400 && delivered('chat-b').length === 0; i++) await tick();
      expect(delivered('chat-b').join('\n')).toContain('reply to hello bravo');
      expect(delivered('chat-a')).toEqual([]);
      a.release();
      await harness.agent.whenIdle();
      expect(delivered('chat-a').join('\n')).toContain('reply to hello alpha');
      expect(delivered('chat-a').join('\n')).not.toContain('bravo');
      // Each chat's stored conversation holds only its own exchange.
      const historyOf = (chat: string) => (harness.sessions.getByBinding('telegram', chat)?.messages ?? []).filter((m) => m.kind === 'message').map((m) => `${m.role}:${m.content}`);
      expect(historyOf('chat-a')).toEqual(['user:hello alpha', 'assistant:reply to hello alpha']);
      expect(historyOf('chat-b')).toEqual(['user:hello bravo', 'assistant:reply to hello bravo']);
    } finally {
      await harness.dispose();
    }
  });

  it("one chat's second message waits for its first", async () => {
    const { harness, calls, send, waitForCalls } = await gatedHarness('concurrency-same-chat');
    try {
      send('m-1', 'chat-a', 'first question');
      send('m-2', 'chat-a', 'second question');
      expect(await waitForCalls(1)).toBe(1);
      await tick(30);
      expect(calls.map((c) => c.text)).toEqual(['first question']);
      calls[0].release();
      expect(await waitForCalls(2)).toBe(2);
      expect(calls[1]).toMatchObject({ text: 'second question', currentMessageId: 'm-2' });
      calls[1].release();
      await harness.agent.whenIdle();
    } finally {
      await harness.dispose();
    }
  });

  it('/stop in one chat ends that chat only', async () => {
    const { harness, calls, send, waitForCalls, delivered } = await gatedHarness('concurrency-stop-one');
    try {
      send('m-a', 'chat-a', 'long task alpha');
      send('m-b', 'chat-b', 'long task bravo');
      expect(await waitForCalls(2)).toBe(2);
      send('m-stop', 'chat-a', '/stop');
      for (let i = 0; i < 400 && harness.agent.activeTurnCount > 1; i++) await tick();
      expect(harness.agent.activeTurnCount).toBe(1);
      expect(harness.agent.turnForChannel('chat-b')).toBeDefined();
      expect(delivered('chat-a').join('\n')).toMatch(/Stopped this chat's task/);
      calls.find((c) => c.text === 'long task bravo')!.release();
      calls.find((c) => c.text === 'long task alpha')!.release();
      await harness.agent.whenIdle();
      expect(delivered('chat-b').join('\n')).toContain('reply to long task bravo');
    } finally {
      await harness.dispose();
    }
  });
});
