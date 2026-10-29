import { Hono } from 'hono';
import {
  loadConfig,
  saveConfig,
  type ProviderConfig,
  type ProviderName,
  type ProviderRouting,
} from '../../utils/config.js';

/**
 * OpenRouter's endpoint pin, read from a request body. Unknown keys are
 * dropped rather than stored: `mercury.yaml` is hand-editable, and a typo that
 * sat there unread would look like a routing setting that does nothing.
 *
 * Returns null for a body that cannot be honoured, so the route can answer 400
 * instead of writing half a pin.
 */
function parseRouting(raw: unknown): ProviderRouting | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const routing: ProviderRouting = {};

  for (const key of ['order', 'quantizations'] as const) {
    const value = source[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)) {
      return null;
    }
    const cleaned = value.map((entry) => (entry as string).trim());
    if (cleaned.length > 0) routing[key] = cleaned;
  }

  if (source.allowFallbacks !== undefined) {
    if (typeof source.allowFallbacks !== 'boolean') return null;
    routing.allowFallbacks = source.allowFallbacks;
  }

  return routing;
}

function maskApiKey(key: string): string {
  if (!key || key.length < 8) return key ? '••••••' : '';
  return key.slice(0, 4) + '••••' + key.slice(-4);
}

/**
 * Surfaced as a badge in the UI. One name rather than a list, so the claim
 * stays reviewable and reverting it is a one-line change.
 */
const RECOMMENDED_PROVIDER = 'aimlapi';

const providers = new Hono();

providers.get('/api/providers', (c) => {
  const config = loadConfig();
  const list = Object.entries(config.providers).filter(([k]) => k !== 'default').map(([name, p]: [string, any]) => ({
    name: p.name || name,
    apiKey: p.apiKey ? maskApiKey(p.apiKey) : '',
    hasKey: !!p.apiKey,
    baseUrl: p.baseUrl,
    model: p.model,
    enabled: p.enabled,
    // OpenRouter only, and absent when nothing is pinned.
    ...(p.routing ? { routing: p.routing } : {}),
    recommended: name === RECOMMENDED_PROVIDER,
  }));
  return c.json(list);
});

providers.post('/api/providers/:name', async (c) => {
  const providerName = c.req.param('name') as ProviderName;
  const body = await c.req.json();
  const config = loadConfig();

  const validNames: ProviderName[] = ['aimlapi', 'mercuryCloud', 'openai', 'anthropic', 'deepseek', 'grok', 'atlascloud', 'ollamaCloud', 'ollamaLocal', 'atomicChat', 'openaiCompat', 'openrouter', 'litellm', 'lmStudio', 'mimo', 'mimoTokenPlan'];
  if (!validNames.includes(providerName)) {
    return c.json({ error: 'Unknown provider' }, 400);
  }

  const p = config.providers[providerName];
  if (body.routing !== undefined) {
    // A pin on a gateway that does not read it would be a config line that
    // never applies, so it is refused rather than stored.
    if (providerName !== 'openrouter') {
      return c.json({ error: 'Endpoint routing is OpenRouter-only' }, 400);
    }
    const routing = parseRouting(body.routing);
    if (routing === null) {
      return c.json({ error: 'Invalid routing: order and quantizations are lists of names' }, 400);
    }
    if (Object.keys(routing).length === 0) delete p.routing;
    else p.routing = routing;
  }

  if (body.apiKey !== undefined) p.apiKey = body.apiKey;
  if (body.baseUrl !== undefined) p.baseUrl = body.baseUrl;
  if (body.model !== undefined) p.model = body.model;
  if (body.enabled !== undefined) p.enabled = body.enabled;

  saveConfig(config);
  // Keys and models are read at boot — the save is durable, not live.
  return c.json({ success: true, restartRequired: true });
});

providers.post('/api/providers/:name/test', async (c) => {
  const providerName = c.req.param('name') as ProviderName;
  const config = loadConfig();
  const p = config.providers[providerName];

  if (!p) {
    return c.json({ error: 'Provider not found' }, 400);
  }

  // LiteLLM proxies, local Ollama, LM Studio, and Atomic Chat are keyless - only require baseUrl
  const needsKey = providerName !== 'litellm' && providerName !== 'ollamaLocal' && providerName !== 'lmStudio' && providerName !== 'atomicChat';
  if (needsKey && !p.apiKey) {
    return c.json({ error: 'No API key configured' }, 400);
  }
  if (!needsKey && !p.baseUrl) {
    return c.json({ error: 'No base URL configured' }, 400);
  }

  try {
    const { fetchProviderModelCatalog } = await import('../../utils/provider-models.js');
    const catalog = await fetchProviderModelCatalog(providerName, p as ProviderConfig);
    return c.json({ success: true, models: catalog.models.slice(0, 10), recommendedModel: catalog.recommendedModel });
  } catch (err: any) {
    return c.json({ success: false, error: err.message || 'Connection failed' }, 400);
  }
});

export default providers;
