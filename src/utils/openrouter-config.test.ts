import { describe, expect, it } from 'vitest';
import { isProviderConfigured, type ProviderConfig } from './config.js';
import { getPreferredModelsForProvider } from './provider-models.js';

/**
 * The OpenRouter slot is a hosted gateway, so unlike `litellm` or a local
 * Ollama it is not "configured" without a key: a keyless entry would answer
 * 401 on every turn and read as a Mercury bug rather than a missing setting.
 */
describe('openrouter configuration', () => {
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

  it('needs a key, a base URL and a model', () => {
    expect(isProviderConfigured(config())).toBe(true);
    expect(isProviderConfigured(config({ apiKey: '' }))).toBe(false);
    expect(isProviderConfigured(config({ baseUrl: '' }))).toBe(false);
    expect(isProviderConfigured(config({ model: '' }))).toBe(false);
  });

  it('offers namespaced ids as its preferred models', () => {
    const preferred = getPreferredModelsForProvider('openrouter');
    expect(preferred.length).toBeGreaterThan(0);
    // Every id carries its lab prefix: a bare `claude-sonnet-4.6` 404s there.
    expect(preferred.every((id) => id.includes('/'))).toBe(true);
  });
});
