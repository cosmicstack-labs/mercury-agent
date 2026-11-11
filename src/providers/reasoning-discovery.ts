/**
 * Ask an OpenAI-compatible server which models take a reasoning effort,
 * where it can say (see utils/reasoning-caps.ts for how the answer is used):
 *
 *   Ollama      POST /api/show → capabilities includes "thinking"
 *               (gpt-oss takes low/medium/high; other thinking models on/off)
 *   LiteLLM     GET  /model/info → model_info.supports_reasoning
 *   OpenRouter  GET  /api/v1/models → supported_parameters includes "reasoning"
 *
 * Anything else has no way to tell: the model's name decides, and a 400
 * from the server settles it (openai-compat.ts). Never throws; a slow or
 * missing endpoint just leaves the guess in place.
 */
import type { ProviderConfig } from '../utils/config.js';
import type { ReasoningLevel } from '../utils/model-prefs.js';
import { isOpenRouterUrl } from '../utils/model-prefs.js';
import { capsKnown, COMPAT_CHAT_PROVIDERS, rememberCaps } from '../utils/reasoning-caps.js';
import { basicAuthHeaders } from './basic-auth.js';
import { logger } from '../utils/logger.js';

const TIMEOUT_MS = 2500;
const inFlight = new Map<string, Promise<void>>();

function root(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '');
}

function authHeaders(pc: ProviderConfig): Record<string, string> {
  const basic = basicAuthHeaders(pc);
  if (basic) return basic;
  return pc.apiKey ? { Authorization: `Bearer ${pc.apiKey}` } : {};
}

async function getJson(url: string, init: RequestInit, fetchImpl: typeof fetch): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { ...init, signal: ctrl.signal });
    if (!res.ok) return undefined;
    return await res.json();
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** What the server says about this model; undefined when it can't say. */
export async function probeReasoningLevels(pc: ProviderConfig, model: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<ReasoningLevel[] | undefined> {
  if (!pc.baseUrl) return undefined;
  if (pc.name === 'ollamaLocal' || pc.name === 'ollamaCloud') {
    const info = await getJson(`${root(pc.baseUrl)}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(pc) },
      body: JSON.stringify({ model }),
    }, fetchImpl) as { capabilities?: unknown } | undefined;
    if (!info || !Array.isArray(info.capabilities)) return undefined;
    if (!info.capabilities.includes('thinking')) return [];
    return /gpt-oss/i.test(model) ? ['low', 'medium', 'high'] : ['off', 'high'];
  }
  if (isOpenRouterUrl(pc.baseUrl)) {
    const list = await getJson('https://openrouter.ai/api/v1/models', { headers: authHeaders(pc) }, fetchImpl) as { data?: Array<{ id?: string; supported_parameters?: unknown }> } | undefined;
    const entry = list?.data?.find((m) => m.id === model);
    if (!entry || !Array.isArray(entry.supported_parameters)) return undefined;
    return entry.supported_parameters.includes('reasoning') ? ['low', 'medium', 'high'] : [];
  }
  if (pc.name === 'litellm') {
    const info = await getJson(`${root(pc.baseUrl)}/model/info`, { headers: authHeaders(pc) }, fetchImpl) as { data?: Array<{ model_name?: string; model_info?: { supports_reasoning?: unknown } }> } | undefined;
    const entry = info?.data?.find((m) => m.model_name === model);
    const supports = entry?.model_info?.supports_reasoning;
    if (typeof supports !== 'boolean') return undefined;
    return supports ? ['low', 'medium', 'high'] : [];
  }
  return undefined;
}

/**
 * Learn this model's levels from its server once a day (no-op where the
 * server can't say, or it is already known). Safe to call on every picker
 * open: concurrent calls share one request.
 */
export async function discoverReasoningCaps(pc: ProviderConfig, model: string = pc.model, fetchImpl?: typeof fetch): Promise<void> {
  if (!COMPAT_CHAT_PROVIDERS.has(pc.name) || !model || capsKnown(pc.name, model)) return;
  const key = `${pc.name}::${model}`;
  const running = inFlight.get(key);
  if (running) return running;
  const job = (async () => {
    const levels = await probeReasoningLevels(pc, model, fetchImpl);
    if (levels) {
      rememberCaps(pc.name, model, levels, 'discovered');
      logger.debug({ provider: pc.name, model, levels }, 'Reasoning levels discovered');
    }
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, job);
  return job;
}
