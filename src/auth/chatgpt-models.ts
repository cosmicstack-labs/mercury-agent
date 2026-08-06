import type { ProviderModelCatalog } from '../utils/provider-models.js';
import { CHATGPT_BACKEND_API } from './chatgpt-session.js';

// Models available to ChatGPT Plus/Pro subscribers via OAuth.
// Sorted by preference (newest/best first).
// Only models supported on the ChatGPT codex/responses endpoint.
// gpt-4o, o3, o4-mini, gpt-5.4-nano etc. are NOT supported there.
const CHATGPT_PREFERRED_MODELS = [
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex',
  'gpt-5.2',
] as const;

/**
 * Build headers for ChatGPT backend-api/codex requests (OAuth-based).
 */
export function getChatGPTHeaders(accessToken: string, accountId: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'ChatGPT-Account-Id': accountId,
    'User-Agent': `mercury-agent/1.0 (${process.platform} ${process.arch})`,
  };
}

/**
 * Fetches available models from the ChatGPT codex API.
 * Uses the same endpoint structure as the Responses API.
 */
export async function fetchChatGPTModels(
  accessToken: string,
  accountId: string,
): Promise<ProviderModelCatalog> {
  // Try fetching from the models endpoint
  try {
    const response = await fetch(`${CHATGPT_BACKEND_API}/models`, {
      headers: getChatGPTHeaders(accessToken, accountId),
      signal: AbortSignal.timeout(15_000),
    });

    if (response.ok) {
      const data = (await response.json()) as Record<string, any>;
      const models = (data.models ?? [])
        .map((m: any) => (m.slug?.trim() ?? m.id?.trim() ?? '') as string)
        .filter((slug: string) => slug.length > 0);

      if (models.length > 0) {
        return buildCatalog(models);
      }
    }
  } catch {
    // Fall through to hardcoded list
  }

  // Fallback: return the known models for ChatGPT Plus/Pro
  return buildCatalog([...CHATGPT_PREFERRED_MODELS]);
}

function buildCatalog(models: string[]): ProviderModelCatalog {
  const preferredSet = new Set<string>(CHATGPT_PREFERRED_MODELS);

  // Pick the recommended model
  let recommendedModel = models[0]!;
  for (const preferred of CHATGPT_PREFERRED_MODELS) {
    if (models.includes(preferred)) {
      recommendedModel = preferred;
      break;
    }
  }

  // Prioritize preferred models, then the rest
  const preferredMatches = CHATGPT_PREFERRED_MODELS.filter((m) =>
    models.includes(m),
  ) as unknown as string[];
  const others = models
    .filter((m) => m !== recommendedModel && !preferredSet.has(m))
    .sort();

  const allModels = [
    ...preferredMatches.filter((m) => m !== recommendedModel),
    ...others,
  ].slice(0, 10);

  return {
    recommendedModel,
    models: allModels,
  };
}

export { CHATGPT_BACKEND_API };
