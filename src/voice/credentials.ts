/**
 * OpenAI credential resolution for voice (TTS + STT).
 *
 * Order of precedence (matches the agreed spec):
 *   1. ChatGPT OAuth access token        (if `/v1/audio/*` reachable)
 *   2. providers.openai.apiKey           (mercury config)
 *   3. OPENAI_API_KEY env var
 *
 * The OAuth probe is best-effort: if the access token is rejected by the
 * audio endpoints, we silently fall through to the next source so the
 * agent voice stays usable for ChatGPT-only users.
 *
 * Result objects expose `{ kind, value }` so call-sites can pick the right
 * header — OAuth uses `Authorization: Bearer …` against `chatgpt.com`'s
 * passthrough, key auth uses `Authorization: Bearer sk-…` against
 * `api.openai.com`. We surface both pieces and let the provider decide.
 *
 * Resolution is cached for 5 minutes to avoid repeated network probes
 * during normal voice usage; refresh() forces a re-check.
 */
import { loadConfig } from '../utils/config.js';
import { getValidChatGPTSession } from '../auth/chatgpt-session.js';
import { logger } from '../utils/logger.js';

export type OpenAICredentialKind = 'oauth' | 'apiKey' | 'env';

export interface OpenAICredential {
  kind: OpenAICredentialKind;
  /** Bearer token value (without the "Bearer " prefix). */
  token: string;
  /** Base URL appropriate for this credential. */
  baseUrl: string;
  /** Optional headers required alongside the bearer (e.g. account id). */
  extraHeaders?: Record<string, string>;
}

const STANDARD_OPENAI_BASE = 'https://api.openai.com/v1';
const CHATGPT_AUDIO_BASE   = 'https://api.openai.com/v1'; // OAuth tokens
// also flow through the official API base; the ChatGPT backend-api host
// is for chat completions only. Audio endpoints use the standard host.

const CACHE_TTL_MS = 5 * 60 * 1000;
let cached: { value: OpenAICredential | null; at: number } | null = null;

export async function resolveOpenAICredential(
  forceRefresh = false,
): Promise<OpenAICredential | null> {
  if (!forceRefresh && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }

  // 1. ChatGPT OAuth: probe quickly. If `getValidChatGPTSession` returns a
  // session we attempt a HEAD/GET against the models endpoint to confirm
  // audio scope. Failures fall through silently.
  try {
    const session = await getValidChatGPTSession();
    if (session?.accessToken) {
      const ok = await probeOAuthAudio(session.accessToken);
      if (ok) {
        const cred: OpenAICredential = {
          kind: 'oauth',
          token: session.accessToken,
          baseUrl: CHATGPT_AUDIO_BASE,
          extraHeaders: session.accountId
            ? { 'chatgpt-account-id': session.accountId }
            : undefined,
        };
        cache(cred);
        return cred;
      }
      logger.debug('voice.openai.oauth probe failed; falling back to api key');
    }
  } catch (err) {
    logger.debug({ err }, 'voice.openai.oauth resolution error');
  }

  // 2. providers.openai.apiKey from mercury config.
  try {
    const cfg = loadConfig();
    const key = cfg.providers?.openai?.apiKey?.trim();
    if (key) {
      const cred: OpenAICredential = {
        kind: 'apiKey',
        token: key,
        baseUrl: STANDARD_OPENAI_BASE,
      };
      cache(cred);
      return cred;
    }
  } catch (err) {
    logger.debug({ err }, 'voice.openai.config resolution error');
  }

  // 3. Environment variable.
  const envKey = process.env.OPENAI_API_KEY?.trim();
  if (envKey) {
    const cred: OpenAICredential = {
      kind: 'env',
      token: envKey,
      baseUrl: STANDARD_OPENAI_BASE,
    };
    cache(cred);
    return cred;
  }

  cache(null);
  return null;
}

export function invalidateOpenAICredentialCache(): void {
  cached = null;
}

/**
 * Resolve the Cartesia API key. Env wins (so production deployments can
 * inject without editing YAML), config falls in second place (so the
 * onboarding wizard's persisted value is honored). Whitespace is trimmed;
 * empty strings count as missing.
 */
export function getCartesiaApiKey(): string | null {
  const envKey = process.env.CARTESIA_API_KEY?.trim();
  if (envKey) return envKey;
  try {
    const cfg = loadConfig();
    const k = cfg.voice?.cartesiaApiKey?.trim();
    if (k) return k;
  } catch {
    /* config load errors fall through to null */
  }
  return null;
}

function cache(value: OpenAICredential | null): void {
  cached = { value, at: Date.now() };
}

async function probeOAuthAudio(accessToken: string): Promise<boolean> {
  // Cheap HEAD against /v1/models — if the token is unauthorized we get 401.
  // We deliberately do not call /v1/audio/speech here because that incurs
  // billing and produces audio. Models access is a reasonable proxy for
  // scope; if /v1/audio rejects later, the provider will surface the error.
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch(`${STANDARD_OPENAI_BASE}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  }
}
