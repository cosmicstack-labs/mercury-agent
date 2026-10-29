import { describe, expect, it } from 'vitest';
import type { BaseProvider } from './base.js';
import { ProviderRegistry } from './registry.js';
import { getDefaultConfig } from '../utils/config.js';

function provider(name: string, model: string): BaseProvider {
  return {
    name,
    getModel: () => model,
  } as BaseProvider;
}

describe('ProviderRegistry live default', () => {
  it('switches the runtime default immediately and clears a previous fallback winner', () => {
    const registry = new (ProviderRegistry as any)('first') as ProviderRegistry;
    registry.set('first', provider('first', 'model-a'));
    registry.set('second', provider('second', 'model-b'));
    registry.markSuccess('first');

    registry.setDefault('second');

    expect(registry.getDefault().name).toBe('second');
    expect(registry.getDefault().getModel()).toBe('model-b');
  });
});

/**
 * Fallback order must respect the user's chosen default. Registration order
 * puts Mercury Cloud first in the map, so a failed attempt on a BYOK default
 * used to promote Mercury Cloud immediately — and markSuccess then stuck to
 * it for every following turn, silently overriding the doctor's choice.
 */
describe('ProviderRegistry fallback order', () => {
  function registryWithDefault(defaultName: string): ProviderRegistry {
    const registry = new (ProviderRegistry as any)(defaultName) as ProviderRegistry;
    // Registration order mirrors the real one: Mercury Cloud first.
    registry.set('mercuryCloud', provider('mercuryCloud', 'cloud-model'));
    registry.set('deepseek', provider('deepseek', 'deepseek-model'));
    registry.set('chatgptWeb', provider('chatgptWeb', 'gpt-web'));
    return registry;
  }

  const order = (registry: ProviderRegistry, preferred?: string): string[] => {
    const iterator = registry.getFallbackIterator(preferred);
    return [...iterator].map((p) => p.name);
  };

  it('puts Mercury Cloud LAST in the fallback chain when the default is a BYOK provider', () => {
    const registry = registryWithDefault('chatgptWeb');
    const names = order(registry);
    expect(names[0]).toBe('chatgptWeb');
    expect(names[names.length - 1]).toBe('mercuryCloud');
    expect(names).toContain('deepseek');
  });

  it('keeps Mercury Cloud first when it IS the chosen default', () => {
    const registry = registryWithDefault('mercuryCloud');
    expect(order(registry)[0]).toBe('mercuryCloud');
  });

  it('respects an explicit preferred provider (channel override) the same way', () => {
    const registry = registryWithDefault('mercuryCloud');
    const names = order(registry, 'deepseek');
    expect(names[0]).toBe('deepseek');
    expect(names[names.length - 1]).toBe('mercuryCloud');
  });

  it('never drops or duplicates the default provider', () => {
    const registry = registryWithDefault('chatgptWeb');
    const names = order(registry);
    expect(names.filter((n) => n === 'chatgptWeb')).toHaveLength(1);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('usable providers (a bot always gets a provider that can answer)', () => {
  function fake(name: string, available = true) {
    return { name, isAvailable: () => available, getModel: () => 'm', getModelInstance: () => ({}) } as never;
  }
  function registryWith(defaultName: string, providers: Array<[string, boolean]>) {
    const r = Object.create(ProviderRegistry.prototype) as ProviderRegistry;
    Object.assign(r, { providers: new Map(providers.map(([n, a]) => [n, fake(n, a)])), defaultName, lastSuccessful: null, authFailed: new Set(), warnedUnusableDefault: false });
    return r;
  }

  it('a default without credentials hands over to the first usable provider', () => {
    const r = registryWith('openai', [['openai', false], ['ollamaCloud', true]]);
    expect(r.getDefault().name).toBe('ollamaCloud');
    expect(r.isUsable('openai')).toBe(false);
  });

  it('a rejected key takes the provider out of defaults and fallbacks until the key changes', () => {
    const r = registryWith('openai', [['openai', true], ['anthropic', true]]);
    expect(r.getDefault().name).toBe('openai');
    r.markAuthFailure('openai');
    expect(r.getDefault().name).toBe('anthropic');
    expect([...r.getFallbackIterator()].map((p) => p.name)).toEqual(['anthropic']);
    expect(r.getUsable('openai')).toBeUndefined();
    r.updateApiKey('openai', 'sk-new');
    expect(r.getDefault().name).toBe('openai');
  });

  it('with nothing usable the configured default is still returned (its error is the honest one)', () => {
    const r = registryWith('openai', [['openai', false]]);
    expect(r.getDefault().name).toBe('openai');
  });
});

/**
 * `create` builds its candidate list by hand, so a provider wired everywhere
 * else (config schema, isProviderConfigured, createProvider, doctor, web UI)
 * can still be left out of it — which is exactly what happened to LM Studio:
 * a config with LM Studio as the only provider registered nothing and the CLI
 * exited with "No LLM providers available".
 */
describe('ProviderRegistry.create registration', () => {
  it('registers LM Studio when it is the only configured provider', async () => {
    const config = getDefaultConfig();
    config.providers.default = 'lmStudio';
    config.providers.lmStudio.baseUrl = 'http://127.0.0.1:1234/v1';
    config.providers.lmStudio.model = 'qwen3-8b';
    config.providers.lmStudio.enabled = true;

    const registry = await ProviderRegistry.create(config);

    expect(registry.hasProviders()).toBe(true);
    expect(registry.get('lmStudio')?.name).toBe('lmStudio');
  });
});
