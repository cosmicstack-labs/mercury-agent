import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from '@ai-sdk/provider';
import type { ChannelMessage } from '../../types/channel.js';
import { EvalHarness } from '../runner.js';

/**
 * ADR-039: "Hi" must not sit at Starting while a provider holds the request
 * open and sends nothing. Past the first-response window the next provider
 * answers.
 */

const tick = (ms = 5) => new Promise<void>((r) => setTimeout(r, ms));
const USAGE = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } };

function silentModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    provider: 'eval.silent',
    modelId: 'silent',
    doStream: async (options: LanguageModelV3CallOptions) => {
      await new Promise<never>((_r, reject) => {
        const signal = options.abortSignal;
        if (signal?.aborted) return reject(signal.reason ?? new Error('Aborted'));
        signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('Aborted')), { once: true });
      });
      throw new Error('unreachable');
    },
  });
}

function answeringModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    provider: 'eval.ok',
    modelId: 'ok',
    doStream: async () => ({
      stream: new ReadableStream<LanguageModelV3StreamPart>({
        start(c) {
          for (const p of [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 't' },
            { type: 'text-delta', id: 't', delta: 'Hello!' },
            { type: 'text-end', id: 't' },
            { type: 'finish', usage: USAGE, finishReason: { unified: 'stop', raw: 'stop' } },
          ] as LanguageModelV3StreamPart[]) c.enqueue(p);
          c.close();
        },
      }),
    }),
  });
}

describe('eval · first response (ADR-039)', () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  afterAll(async () => {
    const { removeEvalRoot } = await import('../env.js');
    removeEvalRoot();
  });

  it('a provider that sends nothing is left after the window; the next one answers', async () => {
    vi.stubEnv('MERCURY_FIRST_RESPONSE_TIMEOUT_MS', '400');
    const harness = await EvalHarness.create({
      name: 'first-response',
      turns: [],
      providers: [{ name: 'silent' }, { name: 'backup' }],
      channel: { type: 'telegram', style: 'plain' },
    }, { fakeTimers: false });
    try {
      const silent = silentModel();
      const ok = answeringModel();
      for (const p of harness.providers) (p as unknown as { getModelInstance: () => unknown }).getModelInstance = () => (p.name === 'silent' ? silent : ok);
      const started = Date.now();
      const message: ChannelMessage = { id: 'hi', channelId: 'chat', channelType: 'telegram', senderId: 'eval-user', content: 'Hi', timestamp: Date.now() };
      harness.channel.inject(message);
      await tick(20);
      await harness.agent.whenIdle();
      const elapsed = Date.now() - started;
      const delivered = harness.channel.events.filter((e) => e.kind === 'delivered').map((e) => e.text).join('\n');
      expect(delivered).toContain('Hello!');
      expect(elapsed).toBeLessThan(5_000);
    } finally {
      await harness.dispose();
    }
  }, 20_000);
});
