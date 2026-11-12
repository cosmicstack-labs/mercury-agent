import { afterEach, describe, expect, it, vi } from 'vitest';

// Reasoning prefs live under MERCURY_HOME; point it at a scratch dir so the
// level set for the composition test never touches the real home.
await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  process.env.MERCURY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-or-routing-'));
});

import { OpenAICompatProvider } from './openai-compat.js';
import type { ProviderConfig } from '../utils/config.js';
import { setModelPref } from '../utils/model-prefs.js';

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

interface SentBody {
  model?: string;
  messages?: Array<{ role?: string; content?: unknown }>;
  provider?: { order?: string[]; quantizations?: string[]; allow_fallbacks?: boolean };
  reasoning?: { effort?: string };
}

function stubFetch() {
  const bodies: SentBody[] = [];
  const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    if (typeof init?.body === 'string') bodies.push(JSON.parse(init.body) as SentBody);
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

    expect(bodies[0].provider?.allow_fallbacks).toBe(true);
  });

  it('keeps both the pin and the reasoning level on one request', async () => {
    // OpenRouter has a reasoning control too, so the routing hook and the
    // reasoning hook meet on the same request. They must compose: a level set
    // for the model must not cost the endpoint pin, and vice versa.
    setModelPref('openrouter', 'anthropic/claude-sonnet-4.6', { reasoning: 'high' });
    const bodies = stubFetch();
    const provider = new OpenAICompatProvider(
      config({ model: 'anthropic/claude-sonnet-4.6', routing: { order: ['inference-net'] } }),
      { useChatApi: true },
    );

    await provider.generateText('17+25 ?', 'one word');

    expect(bodies.length).toBe(1);
    expect(bodies[0].provider).toEqual({ order: ['inference-net'], allow_fallbacks: false });
    expect(bodies[0].reasoning).toEqual({ effort: 'high' });
  });
});
