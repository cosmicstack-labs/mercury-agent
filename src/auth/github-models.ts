import type { ProviderModelCatalog } from '../utils/provider-models.js';
import { getValidCopilotToken, COPILOT_HEADERS } from './github-session.js';

// Preferred models sorted by quality/usefulness for an agent
const GITHUB_PREFERRED_MODELS = [
  'claude-sonnet-4.6',
  'gpt-4o',
  'gpt-5.4',
  'claude-opus-4.6',
  'claude-opus-4.7',
  'claude-opus-4.5',
  'gpt-4.1',
  'gpt-4o-mini',
  'gemini-3.1-pro-preview',
] as const;

/**
 * Fetch available models from the Copilot API.
 * Requires a valid GitHub OAuth session — exchanges it for a Copilot token first.
 */
export async function fetchGitHubModels(
  _accessToken: string,
): Promise<ProviderModelCatalog> {
  const copilot = await getValidCopilotToken();
  if (!copilot) {
    throw new Error('Failed to get Copilot token. Is GitHub Copilot enabled for your account?');
  }

  const response = await fetch(`${copilot.apiEndpoint}/models`, {
    headers: {
      Authorization: `Bearer ${copilot.token}`,
      Accept: 'application/json',
      ...COPILOT_HEADERS,
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Copilot models: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { data?: Array<{ id: string }> };

  // Filter out embedding models and router/internal models
  const models = (data.data ?? [])
    .map((m) => m.id)
    .filter((id) => !id.includes('embedding') && !id.includes('accounts/'))
    .sort();

  if (models.length === 0) {
    throw new Error('No models available from Copilot API.');
  }

  return buildCatalog(models);
}

function buildCatalog(models: string[]): ProviderModelCatalog {
  const preferredSet = new Set<string>(GITHUB_PREFERRED_MODELS);

  // Pick the recommended model
  let recommendedModel = models[0]!;
  for (const preferred of GITHUB_PREFERRED_MODELS) {
    if (models.includes(preferred)) {
      recommendedModel = preferred;
      break;
    }
  }

  // Prioritize preferred models, then the rest
  const preferredMatches = GITHUB_PREFERRED_MODELS.filter((m) =>
    models.includes(m),
  ) as unknown as string[];
  const others = models
    .filter((m) => m !== recommendedModel && !preferredSet.has(m))
    .sort();

  const allModels = [
    ...preferredMatches.filter((m) => m !== recommendedModel),
    ...others,
  ].slice(0, 15);

  return {
    recommendedModel,
    models: allModels,
  };
}
