import type { ProviderModelCatalog } from '../utils/provider-models.js';
import { CHATGPT_BACKEND_API, type ChatGPTSession } from './chatgpt-session.js';

const CATALOG_TTL_MS = 10 * 60_000;
const RETRY_MS = 30_000;

interface CatalogLookup {
  sessionKey: string;
  expiresAt: number;
  result: Promise<ProviderModelCatalog>;
}

let lastLookup: CatalogLookup | undefined;

export function fetchChatGPTModels(
  session: ChatGPTSession,
  { forceRefresh = false } = {},
): Promise<ProviderModelCatalog> {
  const sessionKey = JSON.stringify([session.accountId, session.authenticatedAt]);
  if (lastLookup?.sessionKey === sessionKey &&
      (lastLookup.expiresAt === Infinity || (!forceRefresh && Date.now() < lastLookup.expiresAt))) {
    return lastLookup.result;
  }

  const lookup: CatalogLookup = {
    sessionKey,
    expiresAt: Infinity,
    result: requestCatalog(session),
  };
  lastLookup = lookup;
  void lookup.result.then(
    () => { lookup.expiresAt = Date.now() + CATALOG_TTL_MS; },
    () => { lookup.expiresAt = Date.now() + RETRY_MS; },
  );
  return lookup.result;
}

interface CodexModel {
  slug?: unknown;
  id?: unknown;
  visibility?: unknown;
  priority?: unknown;
}

async function requestCatalog(session: ChatGPTSession): Promise<ProviderModelCatalog> {
  // The Codex catalog and Responses requests use the same account. The
  // ChatGPT web catalog and the public OpenAI API have different model IDs.
  let response: Response;
  try {
    response = await fetch(`${CHATGPT_BACKEND_API}/codex/models?client_version=1.0.0`, {
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        'ChatGPT-Account-Id': session.accountId,
        'User-Agent': `mercury-agent/1.0 (${process.platform} ${process.arch})`,
      },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error('Could not reach the ChatGPT model catalog.');
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error('ChatGPT rejected the model catalog request. Check your ChatGPT sign-in.');
  }
  if (!response.ok) {
    throw new Error(`ChatGPT model catalog is unavailable (HTTP ${response.status}).`);
  }
  const data = await response.json().catch(() => null) as { models?: Array<CodexModel | null> } | null;
  const entries = (Array.isArray(data?.models) ? data.models : []).flatMap((model) => {
    if (!model || (model.visibility !== undefined && model.visibility !== 'list')) return [];
    const id = typeof model.slug === 'string' ? model.slug.trim() : '';
    const slug = id || (typeof model.id === 'string' ? model.id.trim() : '');
    const priority = typeof model.priority === 'number' && Number.isFinite(model.priority)
      ? model.priority
      : Infinity;
    return slug ? [{ slug, priority }] : [];
  });
  entries.sort((a, b) => a.priority === b.priority ? 0 : a.priority - b.priority);
  const [recommendedModel, ...models] = new Set(entries.map(({ slug }) => slug));
  if (!recommendedModel) throw new Error('ChatGPT returned no selectable models for this account.');
  return { recommendedModel, models };
}
