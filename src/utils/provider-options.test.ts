import { describe, expect, it } from 'vitest';
import { getReasoningProviderOptions } from './provider-options.js';
import { BaseProvider } from '../providers/base.js';

class FakeProvider extends BaseProvider {
  readonly name: string;
  readonly model: string;

  constructor(name: string, model: string, baseUrl: string = '') {
    super({ name, model, baseUrl, apiKey: 'x', enabled: true });
    this.name = name;
    this.model = model;
  }

  async generateText(): Promise<never> {
    throw new Error('not used');
  }

  async *streamText(): AsyncIterable<never> {
    throw new Error('not used');
  }

  isAvailable(): boolean {
    return true;
  }

  getModelInstance(): any {
    return null;
  }
}

describe('getReasoningProviderOptions', () => {
  it('enables thinking for deepseek reasoning models over openai-compat routes', () => {
    const provider = new FakeProvider('openaiCompat', 'deepseek-r1', 'https://api.deepseek.com/v1');
    expect(getReasoningProviderOptions(provider)).toEqual({ deepseek: { thinking: { type: 'enabled' } } });
  });

  it('does not enable thinking for non-deepseek routes even if model name is similar', () => {
    const provider = new FakeProvider('openaiCompat', 'deepseek-r1', 'https://example.com/v1');
    expect(getReasoningProviderOptions(provider)).toBeUndefined();
  });

  it('does not enable thinking for normal deepseek chat models', () => {
    const provider = new FakeProvider('deepseek', 'deepseek-chat', 'https://api.deepseek.com/v1');
    expect(getReasoningProviderOptions(provider)).toBeUndefined();
  });
});
