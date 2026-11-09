import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildModelCatalog, fetchProviderModelCatalog, ProviderModelFetchError } from './provider-models.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

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
      ...Array.from({ length: 55 }, (_, index) => `claude-test-${String(index).padStart(2, '0')}`),
    ]);

    expect(catalog.models).toHaveLength(50);
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

  it('prefers the Atlas Cloud fast Qwen model when available', () => {
    const catalog = buildModelCatalog('atlascloud', [
      'deepseek-ai/deepseek-v4-pro',
      'qwen/qwen3.5-flash',
      'another-chat-model',
    ]);

    expect(catalog.recommendedModel).toBe('qwen/qwen3.5-flash');
    expect(catalog.models).toContain('deepseek-ai/deepseek-v4-pro');
    expect(catalog.models).toContain('another-chat-model');
  });

  it('prefers the Runcrate DeepSeek V4.1 Flash model when available', () => {
    const catalog = buildModelCatalog('runcrate', [
      'moonshotai/Kimi-K2.6',
      'deepseek-ai/DeepSeek-V4.1-Flash',
      'zai-org/GLM-5.3-Flash',
      'another-chat-model',
    ]);

    expect(catalog.recommendedModel).toBe('deepseek-ai/DeepSeek-V4.1-Flash');
    expect(catalog.models[0]).toBe('zai-org/GLM-5.3-Flash');
    expect(catalog.models).toContain('moonshotai/Kimi-K2.6');
    expect(catalog.models).toContain('another-chat-model');
  });

  it('prefers the CloudGPU DeepSeek V4.1 Flash model when available', () => {
    const catalog = buildModelCatalog('cloudgpu', [
      'kimi-k3',
      'deepseek-v4.1-flash',
      'deepseek-v4-pro',
      'another-chat-model',
    ]);

    expect(catalog.recommendedModel).toBe('deepseek-v4.1-flash');
    expect(catalog.models[0]).toBe('deepseek-v4-pro');
    expect(catalog.models).toContain('kimi-k3');
    expect(catalog.models).toContain('another-chat-model');
  });

  it('prefers the routed Standard Compute model when available', () => {
    const catalog = buildModelCatalog('standardcompute', [
      'z-ai/glm-5.3',
      'StandardCompute',
      'anthropic/claude-sonnet-5.5',
      'another-chat-model',
    ]);

    expect(catalog.recommendedModel).toBe('StandardCompute');
    expect(catalog.models[0]).toBe('anthropic/claude-sonnet-5.5');
    expect(catalog.models).toContain('z-ai/glm-5.3');
    expect(catalog.models).toContain('another-chat-model');
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

  it('uses the first model as recommended for Atomic Chat when no preferred list exists', () => {
    const catalog = buildModelCatalog('atomicChat', [
      'ornith-9b',
      'qwen3-coder',
    ]);

    expect(catalog.recommendedModel).toBe('ornith-9b');
    expect(catalog.models).toContain('qwen3-coder');
  });
});

describe('fetchProviderModelCatalog', () => {
  const grokConfig = {
    name: 'grok' as const,
    apiKey: 'test-grok-key',
    baseUrl: 'https://api.x.ai/v1/',
    model: 'grok-4',
    enabled: true,
  };

  it.each(['models', 'data', 'nested data'] as const)('reads Grok language models from %s and includes chat aliases', async (shape) => {
    const models = [
      { id: ' grok-4-0709 ', aliases: ['grok-4', 'grok-4-latest', 'grok-4', 'other-model'], output_modalities: ['text'] },
      { id: 'grok-vision', input_modalities: ['text', 'image'], output_modalities: ['text'] },
      { id: 'grok-legacy' },
      { id: 'grok-picture', aliases: ['grok-picture-latest'], output_modalities: ['image'] },
    ];
    const payload = shape === 'nested data' ? { data: { data: models } } : { [shape]: models };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload)));
    vi.stubGlobal('fetch', fetchMock);

    const catalog = await fetchProviderModelCatalog('grok', grokConfig);

    expect(catalog).toEqual({
      recommendedModel: 'grok-4',
      models: ['grok-4-latest', 'grok-4-0709', 'grok-legacy', 'grok-vision'],
    });
    expect(fetchMock).toHaveBeenCalledWith('https://api.x.ai/v1/language-models', expect.objectContaining({
      headers: { Authorization: 'Bearer test-grok-key' },
      signal: expect.any(AbortSignal),
    }));
  });

  it('prefers the documented Grok models field and ignores malformed entries', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      models: [
        null, 'grok-invalid', { id: 42 },
        { id: 'grok-4', aliases: [null, 1, ' grok-4-latest ', ''] },
        { id: 'grok-malformed-aliases', aliases: 'grok-not-an-alias' },
        { id: 'grok-malformed-modality', output_modalities: 'text' },
        { id: 'grok-no-output', output_modalities: [] },
      ],
      data: [{ id: 'grok-stale' }],
    }))));

    expect(await fetchProviderModelCatalog('grok', grokConfig)).toEqual({
      recommendedModel: 'grok-4',
      models: ['grok-4-latest', 'grok-malformed-aliases'],
    });
  });

  it.each([null, {}, { models: {} }, { data: { data: 'invalid' } }, { models: [] }, { models: [{ id: 'other-model' }] }])(
    'reports an unsupported Grok catalog without a parsing crash: %j', async (payload) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(payload))));

      await expect(fetchProviderModelCatalog('grok', grokConfig)).rejects.toThrow(ProviderModelFetchError);
    },
  );

  it('excludes non-text Atlas Cloud models using output modality metadata', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [
        { id: 'qwen/qwen3.5-flash', output_modalities: ['text'] },
        { id: 'another-chat-model', output_modalities: ['text'] },
        { id: 'black-forest-labs/flux-kontext-pro', output_modalities: ['image'] },
      ],
    }), { status: 200 })));

    const catalog = await fetchProviderModelCatalog('atlascloud', {
      name: 'atlascloud',
      apiKey: 'test-key',
      baseUrl: 'https://api.atlascloud.ai/v1',
      model: 'qwen/qwen3.5-flash',
      enabled: true,
    });

    expect(catalog.recommendedModel).toBe('qwen/qwen3.5-flash');
    expect(catalog.models).toContain('another-chat-model');
    expect(catalog.models).not.toContain('black-forest-labs/flux-kontext-pro');
  });

  it('keeps only text-output Runcrate models and sends the key as a bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [
        { id: 'deepseek-ai/DeepSeek-V4.1-Flash', output_modalities: ['text'] },
        { id: 'zai-org/GLM-5.3-Flash', output_modalities: ['text'] },
        { id: 'Qwen/Qwen-Image', output_modalities: ['image'] },
        { id: 'BAAI/bge-m3', output_modalities: ['embeddings'] },
        { id: 'hexgrad/Kokoro-82M', output_modalities: ['audio'] },
      ],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const catalog = await fetchProviderModelCatalog('runcrate', {
      name: 'runcrate',
      apiKey: 'rc_live_test',
      baseUrl: 'https://api.runcrate.ai/v1/',
      model: 'deepseek-ai/DeepSeek-V4.1-Flash',
      enabled: true,
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.runcrate.ai/v1/models');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer rc_live_test' });
    expect(catalog.recommendedModel).toBe('deepseek-ai/DeepSeek-V4.1-Flash');
    expect(catalog.models).toEqual(['zai-org/GLM-5.3-Flash']);
  });

  it('keeps CloudGPU chat models and sends the key as a bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [
        { id: 'deepseek-v4.1-flash' },
        { id: 'glm-5.2' },
        { id: 'flux-1-schnell' },
        { id: 'kokoro-tts' },
        { id: 'whisper-v3' },
        { id: 'qwen3-asr' },
      ],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const catalog = await fetchProviderModelCatalog('cloudgpu', {
      name: 'cloudgpu',
      apiKey: 'cgw-sk-test',
      baseUrl: 'https://cloudgpu.app/v1/',
      model: 'deepseek-v4.1-flash',
      enabled: true,
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://cloudgpu.app/v1/models');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer cgw-sk-test' });
    expect(catalog.recommendedModel).toBe('deepseek-v4.1-flash');
    expect(catalog.models).toEqual(['glm-5.2']);
  });
});

describe('model lists behind Basic auth', () => {
  const expected = `Basic ${Buffer.from('alice:s3cret').toString('base64')}`;
  const cfg = (name: 'ollamaLocal' | 'openaiCompat' | 'lmStudio' | 'litellm' | 'atomicChat') => ({
    name, apiKey: '', baseUrl: 'https://ollama.example.test/v1', model: 'm', enabled: true,
    username: 'alice', password: 's3cret',
  });

  it.each([['ollamaLocal'], ['openaiCompat'], ['lmStudio'], ['litellm'], ['atomicChat']] as const)('%s sends the Basic header when listing models', async (name) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ models: [{ name: 'm' }], data: [{ id: 'm' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchProviderModelCatalog(name, cfg(name));

    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ Authorization: expected });
  });
});

describe('chat models only', () => {
  it('drops rerankers, embedders and speech models from model lists', async () => {
    const { isChatModelId, buildModelCatalog } = await import('./provider-models.js');
    for (const m of ['nemotron-3.5-rerank-8b:free', 'text-embedding-3-small', 'gpt-4o-mini-tts', 'whisper-1', 'omni-moderation-latest']) expect(isChatModelId(m)).toBe(false);
    for (const m of ['gpt-4o-mini', 'claude-sonnet-4.6', 'mercury-mini', 'deepseek-chat']) expect(isChatModelId(m)).toBe(true);
    const c = buildModelCatalog('openaiCompat', ['a-chat', 'b-rerank-1', 'c-embed'], 'b-rerank-1');
    expect([c.recommendedModel, ...c.models]).toEqual(['a-chat']);
  });
});
