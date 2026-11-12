import { afterAll, describe, expect, it } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from '@ai-sdk/provider';
import type { ChannelMessage } from '../../types/channel.js';
import { EvalHarness } from '../runner.js';

/**
 * ADR-038 end to end, the reported bug: the owner presses Stop in the middle
 * of a multi-step task (a tool already ran) and a few seconds later the task
 * "resumes". The aborted attempt used to schedule a durable continuation
 * that flipped the cancelled work entry back to queued and re-ran it.
 */

const tick = (ms = 5) => new Promise<void>((r) => setTimeout(r, ms));
const USAGE = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };

function stream(parts: LanguageModelV3StreamPart[]) {
  return { stream: new ReadableStream<LanguageModelV3StreamPart>({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } }) };
}

/** Call 1: a tool call (list_dir). Every later call: hangs until aborted. */
async function multiStepHarness(name: string) {
  const harness = await EvalHarness.create({ name, turns: [], channel: { type: 'telegram', style: 'plain' } }, { fakeTimers: false });
  let calls = 0;
  const model = new MockLanguageModelV3({
    provider: 'eval.stop',
    modelId: 'stop-model',
    doStream: async (options: LanguageModelV3CallOptions) => {
      calls++;
      if (calls === 1) {
        return stream([
          { type: 'stream-start', warnings: [] },
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'list_dir', input: JSON.stringify({ path: '.' }) },
          { type: 'finish', usage: USAGE, finishReason: { unified: 'tool-calls', raw: 'tool_calls' } },
        ]);
      }
      await new Promise<never>((_resolve, reject) => {
        const signal = options.abortSignal;
        if (signal?.aborted) return reject(signal.reason ?? new Error('Aborted'));
        signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('Aborted')), { once: true });
      });
      throw new Error('unreachable');
    },
  });
  for (const p of harness.providers) (p as unknown as { getModelInstance: () => unknown }).getModelInstance = () => model;
  const send = (id: string, chat: string, text: string) => {
    const message: ChannelMessage = { id, channelId: chat, channelType: 'telegram', senderId: 'eval-user', content: text, timestamp: Date.now() };
    harness.channel.inject(message);
  };
  const delivered = (chat: string) => harness.channel.events.filter((e) => e.kind === 'delivered' && e.targetId === chat).map((e) => e.text);
  return { harness, send, delivered, calls: () => calls };
}

describe('eval · stop is final (ADR-038)', () => {
  afterAll(async () => {
    const { removeEvalRoot } = await import('../env.js');
    removeEvalRoot();
  });

  it('Stop after a tool ran: the task ends and does not come back', async () => {
    const { harness, send, delivered, calls } = await multiStepHarness('stop-after-tool');
    try {
      send('m-1', 'chat-a', 'list the files and then summarise every one of them');
      // The tool step ran and the model is now on its second step.
      for (let i = 0; i < 400 && calls() < 2; i++) await tick();
      expect(calls()).toBe(2);
      // A follow-up the owner typed before stopping must not start either.
      send('m-2', 'chat-a', 'and also count the lines');
      await tick(20);
      send('m-stop', 'chat-a', '/stop');
      await harness.agent.whenIdle();
      const text = delivered('chat-a').join('\n');
      expect(text).toMatch(/Stopped this chat's task/);
      expect(text).toMatch(/⏹ Task stopped/);
      // Past the first continuation delay (2 s) the old code re-ran it.
      await tick(3_500);
      expect(calls()).toBe(2);
      expect(harness.agent.activeTurnCount).toBe(0);
      expect(harness.agent.isIdle()).toBe(true);
      // No "checkpointed… will continue in N seconds" / retry notice either.
      expect(delivered('chat-a').join('\n')).not.toMatch(/checkpointed|continue in \d|retry in \d|safely queued/i);
    } finally {
      await harness.dispose();
    }
  }, 20_000);
});
