import { describe, expect, it } from 'vitest';
import { createProvider } from './registry.js';

const config = (name: string, model: string) => ({
  name,
  apiKey: 'test-key',
  baseUrl: 'https://example.invalid/v1',
  model,
  enabled: true,
});

describe('supportsToolResultImages', () => {
  it('allows images in tool results only where the API sends them as images', async () => {
    const expected: Array<[string, string, boolean]> = [
      ['anthropic', 'claude-sonnet-4-5', true],
      ['openai', 'gpt-5', true],
      ['grok', 'grok-4', false],
      ['chatgptWeb', 'gpt-5', false],
      ['githubCopilot', 'gpt-5', false],
      ['mercuryCloud', 'gpt-5', false],
      ['deepseek', 'deepseek-chat', false],
      ['ollamaLocal', 'llava', false],
      ['ollamaCloud', 'qwen2.5-vl', false],
      ['atomicChat', 'llava', false],
      ['aimlapi', 'gpt-4o', false],
      ['atlascloud', 'gpt-4o', false],
      ['openaiCompat', 'gpt-4o', false],
      ['litellm', 'gpt-4o', false],
      ['lmStudio', 'llava', false],
      ['mimo', 'mimo-vl', false],
    ];
    for (const [name, model, supported] of expected) {
      const provider = await createProvider(config(name, model), null);
      expect([name, provider.supportsToolResultImages()]).toEqual([name, supported]);
    }
  });
});
