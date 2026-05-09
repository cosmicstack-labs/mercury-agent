import type { ProviderConfig, ProviderName } from './config.js';
import { fetchChatGPTModels } from '../auth/chatgpt-models.js';
import { fetchGitHubModels } from '../auth/github-models.js';

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
  'llama3.2',
  'llama3.1',
  'llama3',
  'mistral',
  'codellama',
  'gemma2',
  'phi3',
  'qwen2',
  'deepseek-r1',
  'deepseek-coder-v2',
] as const;

const MIMO_PREFERRED_MODELS = [
  'mimo-v2.5-pro',
  'mimo-v2.5',
  'mimo-v2-pro',
  'mimo-v2-omni',
  'mimo-v2-flash',
] as const;

const MIMO_TOKEN_PLAN_PREFERRED_MODELS = MIMO_PREFERRED_MODELS;

const OPENAI_COMPAT_PREFERRED_MODELS = [] as const;

const CHATGPT_WEB_PREFERRED_MODELS = [
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex',
  'gpt-5.2',
] as const;

const GITHUB_COPILOT_PREFERRED_MODELS = [
  'claude-sonnet-4.6',
  'gpt-4o',
  'gpt-5.4',
  'claude-opus-4.6',
  'claude-opus-4.7',
  'gpt-4.1',
  'gpt-4o-mini',
  'gemini-3.1-pro-preview',
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
    openaiCompat: OPENAI_COMPAT_PREFERRED_MODELS,
    mimo: MIMO_PREFERRED_MODELS,
    mimoTokenPlan: MIMO_TOKEN_PLAN_PREFERRED_MODELS,
    chatgptWeb: CHATGPT_WEB_PREFERRED_MODELS,
    githubCopilot: GITHUB_COPILOT_PREFERRED_MODELS,
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
    openaiCompat: OPENAI_COMPAT_PREFERRED_MODELS,
    mimo: MIMO_PREFERRED_MODELS,
    mimoTokenPlan: MIMO_TOKEN_PLAN_PREFERRED_MODELS,
    chatgptWeb: CHATGPT_WEB_PREFERRED_MODELS,
    githubCopilot: GITHUB_COPILOT_PREFERRED_MODELS,
  };

  const withoutRecommended = filtered.filter((model) => model !== recommendedModel);
  const prioritized = prioritizeModels(withoutRecommended, preferredByProvider[provider]);

  return {
    recommendedModel,
    models: limitModels(prioritized),
  };
}

async function fetchOpenAICompatModels(provider: ProviderName, config: ProviderConfig): Promise<ProviderModelCatalog> {
  const headers: Record<string, string> = {};
  if (config.apiKey) {
    headers['Authorization'] = `Bearer ${config.apiKey}`;
  }

  let errorMessage: string;
  if (provider === 'grok') {
    errorMessage = 'Mercury could not fetch models for this Grok key. Please re-enter it.';
  } else if (provider === 'deepseek') {
    errorMessage = 'Mercury could not fetch models for this DeepSeek key. Please re-enter it.';
  } else if (provider === 'openaiCompat') {
    errorMessage = 'Mercury could not fetch models from this server. Please check the base URL and try again.';
  } else {
    errorMessage = 'Mercury could not fetch models for this OpenAI key. Please re-enter it.';
  }

  const data = await fetchJson<OpenAIModelResponse>(
    `${trimTrailingSlash(config.baseUrl)}/models`,
    { headers },
    errorMessage,
  );

  const ids = (data.data ?? [])
    .map((model) => model.id?.trim() ?? '')
    .filter((id) => {
      if (provider === 'deepseek') {
        return id.startsWith('deepseek-');
      }
      if (provider === 'openaiCompat') {
        return id.length > 0;
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

async function fetchOllamaCloudModels(config: ProviderConfig): Promise<ProviderModelCatalog> {
  const data = await fetchJson<OpenAIModelResponse>(
    `${trimTrailingSlash(config.baseUrl)}/models`,
    {
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
      },
    },
    'Mercury could not fetch models for this Ollama Cloud key. Please re-enter it.',
  );

  const ids = (data.data ?? [])
    .map((model) => model.id?.trim() ?? '')
    .filter(Boolean);

  return buildModelCatalog('ollamaCloud', ids, config.model);
}

async function fetchOllamaLocalModels(config: ProviderConfig): Promise<ProviderModelCatalog> {
  const data = await fetchJson<OllamaTagsResponse>(
    `${trimTrailingSlash(config.baseUrl)}/tags`,
    {},
    'Mercury could not fetch models from this Ollama Local server. Please check the base URL and try again.',
  );

  const ids = (data.models ?? [])
    .map((model) => model.model?.trim() || model.name?.trim() || '')
    .filter(Boolean);

  return buildModelCatalog('ollamaLocal', ids, config.model);
}

async function fetchMiMoModels(config: ProviderConfig): Promise<ProviderModelCatalog> {
  const data = await fetchJson<OpenAIModelResponse>(
    `${trimTrailingSlash(config.baseUrl)}/models`,
    {
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
      },
    },
    'Mercury could not fetch models for this MiMo key. Please re-enter it.',
  );

  const ids = (data.data ?? [])
    .map((model) => model.id?.trim() ?? '')
    .filter((id) => {
      const lower = id.toLowerCase();
      return lower.startsWith('mimo-') && !lower.includes('tts');
    });

  return buildModelCatalog('mimo', ids, config.model);
}

async function fetchMiMoTokenPlanModels(config: ProviderConfig): Promise<ProviderModelCatalog> {
  const data = await fetchJson<OpenAIModelResponse>(
    `${trimTrailingSlash(config.baseUrl)}/models`,
    {
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
      },
    },
    'Mercury could not fetch models for this MiMo Token Plan key. Please re-enter it.',
  );

  const ids = (data.data ?? [])
    .map((model) => model.id?.trim() ?? '')
    .filter((id) => {
      const lower = id.toLowerCase();
      return lower.startsWith('mimo-') && !lower.includes('tts');
    });

  return buildModelCatalog('mimoTokenPlan', ids, config.model);
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

  if (provider === 'ollamaCloud') {
    return fetchOllamaCloudModels(config);
  }

  if (provider === 'ollamaLocal') {
    return fetchOllamaLocalModels(config);
  }

  if (provider === 'openaiCompat') {
    return fetchOpenAICompatModels(provider, config);
  }

  if (provider === 'mimo') {
    return fetchMiMoModels(config);
  }

  if (provider === 'mimoTokenPlan') {
    return fetchMiMoTokenPlanModels(config);
  }

  if (provider === 'chatgptWeb') {
    // chatgptWeb uses OAuth session token, not apiKey
    const { getValidChatGPTSession } = await import('../auth/chatgpt-session.js');
    const session = await getValidChatGPTSession();
    if (!session?.accessToken || !session?.accountId) {
      throw new ProviderModelFetchError(
        'ChatGPT Web is not authenticated. Run `mercury doctor` to set up OAuth.',
      );
    }
    return fetchChatGPTModels(session.accessToken, session.accountId);
  }

  if (provider === 'githubCopilot') {
    const { loadGitHubSession } = await import('../auth/github-session.js');
    const session = loadGitHubSession();
    if (!session?.accessToken) {
      throw new ProviderModelFetchError(
        'GitHub Copilot is not authenticated. Run `mercury doctor` to set up OAuth.',
      );
    }
    return fetchGitHubModels(session.accessToken);
  }

  return fetchOpenAICompatModels(provider, config);
}
