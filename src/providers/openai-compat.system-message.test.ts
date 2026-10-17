import { generateText } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatProvider } from './openai-compat.js';
import type { ProviderConfig } from '../utils/config.js';

const config = (name: string): ProviderConfig => ({
  name,
  apiKey: '',
  baseUrl: 'http://ollama.test/v1',
  model: 'ternary-bonsai:27b-q2',
  enabled: true,
});

describe('OpenAICompatProvider system messages', () => {
  let sent: Record<string, unknown>[];

  beforeEach(() => {
    sent = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({
        id: 'c1', object: 'chat.completion', created: 0, model: 'm',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
  });

  afterEach(() => vi.unstubAllGlobals());

  async function send(name: string) {
    const provider = new OpenAICompatProvider(config(name), { useChatApi: true });
    await generateText({
      model: provider.getModelInstance(),
      allowSystemInMessages: true,
      // Like the agent's withCachedSystem: cached prompt, then per-turn block.
      messages: [
        { role: 'system', content: 'You are Vega.' },
        { role: 'system', content: 'Per-turn context.' },
        { role: 'user', content: 'hello' },
      ],
    } as Parameters<typeof generateText>[0]);
    return sent[0]!.messages as { role: string; content: string }[];
  }

  it('sends Ollama a single leading system message (strict Qwen templates)', async () => {
    const messages = await send('ollamaLocal');
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(messages[0]!.content).toBe('You are Vega.\n\nPer-turn context.');
  });

  it('leaves official APIs untouched', async () => {
    const messages = await send('openai');
    expect(messages.map((m) => m.role)).toEqual(['system', 'system', 'user']);
  });
});
