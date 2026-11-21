import { describe, expect, it, vi } from 'vitest';

const { createAnthropicMock } = vi.hoisted(() => ({ createAnthropicMock: vi.fn() }));
vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: createAnthropicMock }));

import { AnthropicProvider } from './anthropic.js';
import { anthropicApiRoot } from './anthropic-url.js';

describe('anthropicApiRoot', () => {
  it('adds /v1 to a bare host, the way ANTHROPIC_BASE_URL is usually written', () => {
    expect(anthropicApiRoot('https://api.anthropic.com')).toBe('https://api.anthropic.com/v1');
    expect(anthropicApiRoot('http://127.0.0.1:4000/anthropic/')).toBe('http://127.0.0.1:4000/anthropic/v1');
  });

  it('keeps a URL that already ends in /v1', () => {
    expect(anthropicApiRoot('https://gateway.example.com/v1/')).toBe('https://gateway.example.com/v1');
  });

  it('leaves an empty base URL to the SDK default', () => {
    expect(anthropicApiRoot('')).toBeUndefined();
    expect(anthropicApiRoot('   ')).toBeUndefined();
    expect(anthropicApiRoot(undefined)).toBeUndefined();
  });
});

describe('AnthropicProvider', () => {
  it('sends requests to the configured base URL, not always api.anthropic.com', () => {
    createAnthropicMock.mockReturnValue(vi.fn(() => ({ modelId: 'claude-sonnet-4-20250514' })));

    new AnthropicProvider({
      name: 'anthropic',
      apiKey: 'sk-ant-test-0000000000000000',
      baseUrl: 'https://gateway.example.com',
      model: 'claude-sonnet-4-20250514',
      enabled: true,
    });

    expect(createAnthropicMock).toHaveBeenCalledWith(expect.objectContaining({
      baseURL: 'https://gateway.example.com/v1',
    }));
  });
});
