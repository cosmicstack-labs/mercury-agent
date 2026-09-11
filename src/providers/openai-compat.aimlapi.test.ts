import { describe, it, expect, vi, beforeEach } from 'vitest';

type ClientOptions = { baseURL?: string; headers?: Record<string, string> };

const createOpenAI = vi.fn((_options: ClientOptions) => {
  const client: any = vi.fn(() => ({ id: 'model' }));
  client.chat = vi.fn(() => ({ id: 'model' }));
  return client;
});

vi.mock('@ai-sdk/openai', () => ({ createOpenAI: (options: ClientOptions) => createOpenAI(options) }));

import { OpenAICompatProvider } from './openai-compat.js';
import type { ProviderConfig } from '../utils/config.js';

const config = (name: string, baseUrl: string): ProviderConfig => ({
  name,
  apiKey: 'test-key',
  baseUrl,
  model: 'some-model',
  enabled: true,
});

describe('OpenAICompatProvider header wiring', () => {
  beforeEach(() => createOpenAI.mockClear());

  it('hands the attribution headers to the client for AI/ML API', () => {
    // The unit tests next door prove which headers are chosen; this proves
    // they actually reach the SDK, which is the half a refactor would drop.
    new OpenAICompatProvider(config('aimlapi', 'https://api.aimlapi.com/v1'), { useChatApi: true });

    const options = createOpenAI.mock.calls[0]![0];
    expect(options.baseURL).toBe('https://api.aimlapi.com/v1');
    expect(options.headers?.['X-AIMLAPI-Partner-ID']).toMatch(/^part_[A-Za-z0-9]{1,64}$/);
    expect(options.headers?.['X-AIMLAPI-Source']).toBe('agent/mercury-agent');
  });

  it('hands no headers to any other provider served by the same class', () => {
    new OpenAICompatProvider(config('openaiCompat', 'https://api.openai.com/v1'), { useChatApi: true });

    const options = createOpenAI.mock.calls[0]![0];
    expect(options.headers).toBeUndefined();
  });
});
