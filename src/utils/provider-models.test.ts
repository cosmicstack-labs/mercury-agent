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

  it('prefers gpt-oss:120b for Ollama Cloud when available', () => {
    const catalog = buildModelCatalog('ollamaCloud', [
      'gpt-oss:120b',
      'gpt-oss:20b',
      'gpt-oss:120b-cloud',
    ]);

    expect(catalog.recommendedModel).toBe('gpt-oss:120b');
    expect(catalog.models).toContain('gpt-oss:120b-cloud');
    expect(catalog.models).toContain('gpt-oss:20b');
  });

  it('falls back to the current Ollama Cloud model when no preferred default is available', () => {
    const catalog = buildModelCatalog(
      'ollamaCloud',
      ['other-model:8b'],
      'other-model:8b',
    );

    expect(catalog.recommendedModel).toBe('other-model:8b');
  });

  it('uses the first model as recommended for OpenAI Compilations when no preferred list exists', () => {
    const catalog = buildModelCatalog('openaiCompat', [
      'my-custom-model',
      'another-model',
    ]);

    expect(catalog.recommendedModel).toBe('my-custom-model');
    expect(catalog.models).toContain('another-model');
  });

  it('falls back to the current model for OpenAI Compilations', () => {
    const catalog = buildModelCatalog(
      'openaiCompat',
      ['model-a', 'model-b'],
      'model-a',
    );

    expect(catalog.recommendedModel).toBe('model-a');
  });

  it('uses the first model as recommended for LM Studio when no preferred list exists', () => {
    const catalog = buildModelCatalog(
      'lmStudio',
      ['llama-3.2-3b-instruct', 'mistral-7b-instruct-v0.3'],
    );

    expect(catalog.recommendedModel).toBe('llama-3.2-3b-instruct');
    expect(catalog.models).toContain('mistral-7b-instruct-v0.3');
  });

  it('falls back to the current model for LM Studio when no preferred list exists', () => {
    const catalog = buildModelCatalog(
      'lmStudio',
      ['qwen2.5-7b-instruct'],
      'qwen2.5-7b-instruct',
    );

    expect(catalog.recommendedModel).toBe('qwen2.5-7b-instruct');
  });
});
