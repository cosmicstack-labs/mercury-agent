import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatProvider } from './openai-compat.js';
import type { ProviderConfig } from '../utils/config.js';

/**
 * The endpoint pin lives on the wire, not in the SDK: `createOpenAI` has no
 * field for OpenRouter's `provider` block, so it is written into the JSON body
 * by a fetch hook. These tests read the body that would leave the process.
 */
function config(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    name: 'openrouter',
    apiKey: 'sk-or-test',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'deepseek/deepseek-v4.1-flash-1017',
    enabled: true,
    ...overrides,
  };
}

function stubFetch() {
  const bodies: any[] = [];
  const fetchMock = vi.fn(async (_input: any, init?: any) => {
    if (typeof init?.body === 'string') bodies.push(JSON.parse(init.body));
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: 1,
        model: 'deepseek/deepseek-v4.1-flash-1017',
        choices: [{ index: 0, message: { role: 'assistant', content: '42' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  return bodies;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('openrouter endpoint pinning', () => {
  it('writes the provider block the gateway reads', async () => {
    const bodies = stubFetch();
    const provider = new OpenAICompatProvider(
      config({ routing: { order: ['inference-net'], quantizations: ['fp8'] } }),
      { useChatApi: true },
    );

    await provider.generateText('17+25 ?', 'one word');

    expect(bodies.length).toBe(1);
    expect(bodies[0].provider).toEqual({
      order: ['inference-net'],
      quantizations: ['fp8'],
      // Not "whatever answers instead": the caller asked for this endpoint.
      allow_fallbacks: false,
    });
  });

  it('sends no provider block when nothing is pinned', async () => {
    const bodies = stubFetch();
    const provider = new OpenAICompatProvider(config(), { useChatApi: true });

    await provider.generateText('17+25 ?', 'one word');

    expect(bodies.length).toBe(1);
    expect(bodies[0].provider).toBeUndefined();
  });

  it('keeps the model id and the messages intact', async () => {
    const bodies = stubFetch();
    const provider = new OpenAICompatProvider(
      config({ routing: { order: ['inference-net'] } }),
      { useChatApi: true },
    );

    await provider.generateText('17+25 ?', 'one word');

    expect(bodies[0].model).toBe('deepseek/deepseek-v4.1-flash-1017');
    expect(bodies[0].messages?.at(-1)).toMatchObject({ role: 'user', content: '17+25 ?' });
  });

  it('never sends the block to another provider', async () => {
    // `litellm` shares this class. A block it does not understand is a 400.
    const bodies = stubFetch();
    const provider = new OpenAICompatProvider(
      config({ name: 'litellm', baseUrl: 'http://localhost:4000/v1', routing: { order: ['inference-net'] } }),
      { useChatApi: true },
    );

    await provider.generateText('17+25 ?', 'one word');

    expect(bodies[0].provider).toBeUndefined();
  });

  it('honours an explicit allowFallbacks', async () => {
    const bodies = stubFetch();
    const provider = new OpenAICompatProvider(
      config({ routing: { order: ['inference-net'], allowFallbacks: true } }),
      { useChatApi: true },
    );

    await provider.generateText('17+25 ?', 'one word');

    expect(bodies[0].provider.allow_fallbacks).toBe(true);
  });
});
