import { describe, expect, it } from 'vitest';
import type { BaseProvider } from './base.js';
import { ProviderRegistry } from './registry.js';

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
