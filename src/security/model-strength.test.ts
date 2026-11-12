import { describe, expect, it } from 'vitest';
import { isStrongModel } from './model-strength.js';

describe('strong models', () => {
  it('frontier models are strong, however the id is spelled', () => {
    for (const m of ['claude-opus-5-5', 'claude-sonnet-4-5-20250929', 'anthropic/claude-sonnet-4.5', 'claude-3-7-sonnet-latest', 'claude-fable-5-1',
      'gpt-4o', 'gpt-5', 'openai/gpt-5.1', 'gpt-4.1', 'o3', 'o1-pro', 'gemini-2.5-pro', 'gemini-3-pro-preview', 'grok-4', 'deepseek-v3.1', 'deepseek-reasoner', 'mistral-large-latest', 'kimi-k2-instruct']) {
      expect(isStrongModel(m), m).toBe(true);
    }
  });

  it('small, local and unknown models are not', () => {
    for (const m of ['claude-haiku-4-5', 'claude-3-5-haiku', 'gpt-4o-mini', 'gpt-5-nano', 'gpt-4.1-mini', 'o4-mini', 'o3-mini', 'gemini-2.5-flash', 'gemini-2.0-flash-lite',
      'grok-3-mini', 'llama3.1:8b', 'qwen2.5:7b', 'gemma3:4b', 'phi-4', 'mistral-small', 'auto', 'free-router', 'my-custom-model', '', null]) {
      expect(isStrongModel(m), String(m)).toBe(false);
    }
  });
});
