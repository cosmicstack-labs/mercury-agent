import type { ProviderConfig, ProviderName } from './config.js';

export interface ProviderModelCatalog {
  models: string[];
  recommendedModel: string;
}

const MAX_MODEL_OPTIONS = 7;

const OPENAI_PREFERRED_MODELS = [
  'gpt-5.2',
  'gpt-5.2-chat-latest',
  'gpt-5.2-pro',
  'gpt-5-mini',
  'gpt-5-nano',
  'gpt-4.1',
  'gpt-4.1-mini',
  'gpt-oss-120b',
  'gpt-oss-20b',
] as const;

const ANTHROPIC_PREFERRED_MODELS = [
  'claude-sonnet-4-20250514',
  'claude-opus-4-20250514',
  'claude-3-7-sonnet-latest',
  'claude-3-5-sonnet-latest',
  'claude-3-5-haiku-latest',
] as const;

const DEEPSEEK_PREFERRED_MODELS = [
  'deepseek-chat',
  'deepseek-reasoner',
] as const;

const GROK_PREFERRED_MODELS = [
  'grok-4',
  'grok-4-latest',
  'grok-4.20',
  'grok-3',
  'grok-3-latest',
] as const;

const OLLAMA_CLOUD_PREFERRED_MODELS = [
  'gpt-oss:120b',
  'gpt-oss:120b-cloud',
  'gpt-oss:20b',
] as const;

const OLLAMA_LOCAL_PREFERRED_MODELS = [
  'gpt-oss:20b',
  'gpt-oss:120b',
] as const;

const MINIMAX_PREFERRED_MODELS = [
  'MiniMax-M2.7',
  'MiniMax-M2.7-highspeed',
  'MiniMax-M2.5',
  'MiniMax-M2.1',
] as const;

export class ProviderModelFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderModelFetchError';
  }
}

interface OpenAIModelResponse {
  data?: Array<{ id?: string }>;
}

interface AnthropicModelResponse {
  data?: Array<{ id?: string }>;
}

interface XAIModelResponse {
  data?: Array<{
    id?: string;
    input_modalities?: string[];
    output_modalities?: string[];
  }>;
}

interface OllamaTagsResponse {
  models?: Array<{ name?: string; model?: string }>;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

async function fetchJson<T>(url: string, init: RequestInit, invalidMessage: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new ProviderModelFetchError(invalidMessage);
  }

  if (!response.ok) {
    throw new ProviderModelFetchError(invalidMessage);
  }

  try {
    return await response.json() as T;
  } catch {
    throw new ProviderModelFetchError('Mercury could not read the model list returned by this provider.');
  }
}

function uniq(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function prioritizeModels(models: string[], preferred: readonly string[]): string[] {
  const preferredSet = new Set(preferred);
  const preferredMatches = preferred.filter((model) => models.includes(model));
  const others = models
    .filter((model) => !preferredSet.has(model))
    .sort((a, b) => a.localeCompare(b));

  return [...preferredMatches, ...others];
}

function limitModels(models: string[]): string[] {
  return models.slice(0, MAX_MODEL_OPTIONS);
}

function isOpenAIChatModel(id: string): boolean {
  const lower = id.toLowerCase();
  if (
    lower.includes('image')
    || lower.includes('audio')
    || lower.includes('tts')
    || lower.includes('transcribe')
    || lower.includes('embedding')
    || lower.includes('moderation')
    || lower.includes('realtime')
    || lower.includes('whisper')
    || lower.includes('search')
    || lower.includes('computer')
  ) {
    return false;
  }

  return lower.startsWith('gpt-') || /^o\d/.test(lower);
}

function chooseRecommendedModel(
  provider: ProviderName,
  models: string[],
  currentModel?: string,
): string {
  const preferredByProvider: Record<ProviderName, readonly string[]> = {
    deepseek: DEEPSEEK_PREFERRED_MODELS,
    openai: OPENAI_PREFERRED_MODELS,
    anthropic: ANTHROPIC_PREFERRED_MODELS,
    grok: GROK_PREFERRED_MODELS,
    ollamaCloud: OLLAMA_CLOUD_PREFERRED_MODELS,
    ollamaLocal: OLLAMA_LOCAL_PREFERRED_MODELS,
    minimax: MINIMAX_PREFERRED_MODELS,
  };

  for (const candidate of preferredByProvider[provider]) {
    if (models.includes(candidate)) {
      return candidate;
    }
  }

  if (currentModel && models.includes(currentModel)) {
    return currentModel;
  }

  return models[0];
}

export function buildModelCatalog(
  provider: ProviderName,
  models: string[],
  currentModel?: string,
): ProviderModelCatalog {
  const filtered = uniq(models);
  if (filtered.length === 0) {
    throw new ProviderModelFetchError('Mercury could not find any supported chat models for this provider.');
  }

  const recommendedModel = chooseRecommendedModel(provider, filtered, currentModel);
  const preferredByProvider: Record<ProviderName, readonly string[]> = {
    deepseek: DEEPSEEK_PREFERRED_MODELS,
    openai: OPENAI_PREFERRED_MODELS,
    anthropic: ANTHROPIC_PREFERRED_MODELS,
    grok: GROK_PREFERRED_MODELS,
    ollamaCloud: OLLAMA_CLOUD_PREFERRED_MODELS,
    ollamaLocal: OLLAMA_LOCAL_PREFERRED_MODELS,
    minimax: MINIMAX_PREFERRED_MODELS,
  };

  const withoutRecommended = filtered.filter((model) => model !== recommendedModel);
  const prioritized = prioritizeModels(withoutRecommended, preferredByProvider[provider]);

  return {
    recommendedModel,
    models: limitModels(prioritized),
  };
}

async function fetchOpenAICompatModels(provider: ProviderName, config: ProviderConfig): Promise<ProviderModelCatalog> {
  const data = await fetchJson<OpenAIModelResponse>(
    `${trimTrailingSlash(config.baseUrl)}/models`,
    {
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
      },
    },
    `Mercury could not fetch models for this ${provider === 'grok' ? 'Grok' : provider === 'deepseek' ? 'DeepSeek' : provider === 'minimax' ? 'MiniMax' : 'OpenAI'} key. Please re-enter it.`,
  );

  const ids = (data.data ?? [])
    .map((model) => model.id?.trim() ?? '')
    .filter((id) => {
      if (provider === 'deepseek') {
        return id.startsWith('deepseek-');
      }
      if (provider === 'minimax') {
        return id.startsWith('MiniMax-');
      }
      return isOpenAIChatModel(id);
    });

  return buildModelCatalog(provider, ids, config.model);
}

async function fetchAnthropicModels(config: ProviderConfig): Promise<ProviderModelCatalog> {
  const data = await fetchJson<AnthropicModelResponse>(
    'https://api.anthropic.com/v1/models',
    {
      headers: {
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
    },
    'Mercury could not fetch models for this Anthropic key. Please re-enter it.',
  );

  const ids = (data.data ?? [])
    .map((model) => model.id?.trim() ?? '')
    .filter((id) => id.startsWith('claude-'));

  return buildModelCatalog('anthropic', ids, config.model);
}

async function fetchGrokModels(config: ProviderConfig): Promise<ProviderModelCatalog> {
  const data = await fetchJson<XAIModelResponse>(
    `${trimTrailingSlash(config.baseUrl)}/language-models`,
    {
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
      },
    },
    'Mercury could not fetch models for this Grok key. Please re-enter it.',
  );

  const ids = (data.data ?? [])
    .filter((model) => model.output_modalities?.includes('text') || model.output_modalities == null)
    .map((model) => model.id?.trim() ?? '')
    .filter((id) => id.startsWith('grok-'));

  return buildModelCatalog('grok', ids, config.model);
}

async function fetchOllamaModels(provider: ProviderName, config: ProviderConfig): Promise<ProviderModelCatalog> {
  const headers = config.apiKey
    ? { Authorization: `Bearer ${config.apiKey}` }
    : undefined;

  const data = await fetchJson<OllamaTagsResponse>(
    `${trimTrailingSlash(config.baseUrl)}/tags`,
    {
      headers,
    },
    provider === 'ollamaCloud'
      ? 'Mercury could not fetch models for this Ollama Cloud key. Please re-enter it.'
      : 'Mercury could not fetch models from this Ollama Local server. Please check the base URL and try again.',
  );

  const ids = (data.models ?? [])
    .map((model) => model.model?.trim() || model.name?.trim() || '')
    .filter(Boolean);

  return buildModelCatalog(provider, ids, config.model);
}

export async function fetchProviderModelCatalog(
  provider: ProviderName,
  config: ProviderConfig,
): Promise<ProviderModelCatalog> {
  if (provider === 'anthropic') {
    return fetchAnthropicModels(config);
  }

  if (provider === 'grok') {
    return fetchGrokModels(config);
  }

  if (provider === 'ollamaCloud' || provider === 'ollamaLocal') {
    return fetchOllamaModels(provider, config);
  }

  if (provider === 'minimax') {
    return buildModelCatalog(provider, [...MINIMAX_PREFERRED_MODELS], config.model);
  }

  return fetchOpenAICompatModels(provider, config);
}
