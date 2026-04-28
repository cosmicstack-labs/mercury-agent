import { describe, expect, it } from 'vitest';
import { buildModelCatalog } from './provider-models.js';

describe('buildModelCatalog', () => {
  it('prefers the provider recommended OpenAI model when available', () => {
    const catalog = buildModelCatalog('openai', [
      'gpt-4.1',
      'gpt-5-mini',
      'gpt-5.2',
      'gpt-image-1',
    ]);

    expect(catalog.recommendedModel).toBe('gpt-5.2');
    expect(catalog.models).toContain('gpt-5-mini');
    expect(catalog.models).toContain('gpt-4.1');
    expect(catalog.models).not.toContain('gpt-5.2');
  });

  it('falls back to the current Ollama Local model when no preferred default is installed', () => {
    const catalog = buildModelCatalog(
      'ollamaLocal',
      ['qwen3:14b', 'llama3.2:latest'],
      'llama3.2:latest',
    );

    expect(catalog.recommendedModel).toBe('llama3.2:latest');
  });

  it('limits the list of displayed models', () => {
    const catalog = buildModelCatalog('anthropic', [
      'claude-sonnet-4-20250514',
      'claude-opus-4-20250514',
      'claude-3-7-sonnet-latest',
      'claude-3-5-sonnet-latest',
      'claude-3-5-haiku-latest',
      'claude-test-a',
      'claude-test-b',
      'claude-test-c',
      'claude-test-d',
    ]);

    expect(catalog.models).toHaveLength(7);
    expect(catalog.models).not.toContain('claude-sonnet-4-20250514');
  });

  it('prefers mimo-v2.5-pro for MiMo when available', () => {
    const catalog = buildModelCatalog('mimo', [
      'mimo-v2.5-pro',
      'mimo-v2-flash',
      'mimo-v2.5',
    ]);

    expect(catalog.recommendedModel).toBe('mimo-v2.5-pro');
    expect(catalog.models).toContain('mimo-v2.5');
    expect(catalog.models).toContain('mimo-v2-flash');
  });

  it('falls back to the first MiMo model when no preferred default is available', () => {
    const catalog = buildModelCatalog('mimo', [
      'mimo-v2-flash',
    ]);

    expect(catalog.recommendedModel).toBe('mimo-v2-flash');
  });

  it('prefers mimo-v2.5-pro for MiMo Token Plan when available', () => {
    const catalog = buildModelCatalog('mimoTokenPlan', [
      'mimo-v2.5-pro',
      'mimo-v2-flash',
      'mimo-v2.5',
    ]);

    expect(catalog.recommendedModel).toBe('mimo-v2.5-pro');
    expect(catalog.models).toContain('mimo-v2.5');
    expect(catalog.models).toContain('mimo-v2-flash');
  });
});
