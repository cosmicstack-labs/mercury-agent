import { describe, expect, it } from 'vitest';
import { createProvider } from './registry.js';
import { OpenAICompatProvider } from './openai-compat.js';
import type { ProviderConfig } from '../utils/config.js';

/**
 * OpenRouter is a second OpenAI-compatible slot, not a new wire format: the
 * whole point of the copy is that a user can point it at the gateway without
 * spending the `openaiCompat` entry their local rig already owns.
 */
describe('openrouter provider', () => {
  function config(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
    return {
      name: 'openrouter',
      apiKey: 'sk-or-test',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'deepseek/deepseek-chat',
      enabled: true,
      ...overrides,
    };
  }

  it('is served by the OpenAI-compatible provider', async () => {
    const provider = await createProvider(config());
    expect(provider).toBeInstanceOf(OpenAICompatProvider);
    expect(provider.name).toBe('openrouter');
    expect(provider.getModel()).toBe('deepseek/deepseek-chat');
  });

  it('keeps the namespaced model id intact', async () => {
    // The id is passed straight through: `deepseek/deepseek-chat` is the model's
    // name at the gateway, and prefixing or trimming it would 404.
    const provider = await createProvider(config({ model: 'anthropic/claude-sonnet-4.6' }));
    expect(provider.getModel()).toBe('anthropic/claude-sonnet-4.6');
  });

  it('is unavailable without a key, unlike the keyless local proxies', async () => {
    const provider = await createProvider(config({ apiKey: '' }));
    expect(provider.isAvailable()).toBe(false);
  });

  it('is available with a key, even before the gateway answers', async () => {
    const provider = await createProvider(config());
    expect(provider.isAvailable()).toBe(true);
  });
});
