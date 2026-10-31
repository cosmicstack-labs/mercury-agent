import { Hono } from 'hono';
import { getActiveProviders, isProviderConfigured, loadConfig, saveConfig, type MercuryConfig, type ProviderConfig, type ProviderName } from '../../utils/config.js';
import { PROVIDER_META, validateApiKey, validateBaseUrl, validateModelName } from '../../providers/provider-meta.js';
import { logger } from '../../utils/logger.js';

function maskApiKey(key: string): string {
  if (!key || key.length < 8) return key ? '••••••' : '';
  return key.slice(0, 4) + '••••' + key.slice(-4);
}

/**
 * Surfaced as a badge in the UI. One name rather than a list, so the claim
 * stays reviewable and reverting it is a one-line change.
 */
const RECOMMENDED_PROVIDER = 'mercuryCloud';

const NAMES = Object.keys(PROVIDER_META) as ProviderName[];

/**
 * How a save reaches the running agent. Registered by the runtime; without
 * it (setup mode, tests) a save is durable and applies on the next start.
 */
type Reloader = () => Promise<{ ok: boolean; providers: string[]; default: string; model: string }>;
let reloader: Reloader | null = null;
export function setProvidersReload(fn: Reloader | null): void { reloader = fn; }

/** Setup mode: the runtime came up with no provider. The first working one restarts it into normal mode. */
let onFirstProvider: (() => void) | null = null;
export function setFirstProviderHandler(fn: (() => void) | null): void { onFirstProvider = fn; }
export function isSetupRequired(): boolean { return !!onFirstProvider; }

async function apply(): Promise<{ applied: boolean; restarting?: boolean; error?: string }> {
  if (onFirstProvider) {
    if (getActiveProviders(loadConfig()).length === 0) return { applied: false };
    const restart = onFirstProvider;
    onFirstProvider = null;
    setTimeout(restart, 300);
    return { applied: false, restarting: true };
  }
  if (!reloader) return { applied: false };
  try {
    const r = await reloader();
    return { applied: r.ok };
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Provider reload failed; the save applies on restart');
    return { applied: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function isName(name: unknown): name is ProviderName {
  return typeof name === 'string' && (NAMES as string[]).includes(name);
}

function describe(name: ProviderName, p: ProviderConfig, config: MercuryConfig) {
  const meta = PROVIDER_META[name];
  return {
    id: name,
    name: p.name || name,
    label: meta.label,
    kind: meta.kind,
    blurb: meta.blurb,
    needsKey: meta.needsKey,
    needsBaseUrl: meta.needsBaseUrl,
    signInOnly: !!meta.signInOnly,
    keyUrl: meta.keyUrl ?? null,
    keyHint: meta.keyHint ?? null,
    apiKey: p.apiKey ? maskApiKey(p.apiKey) : '',
    hasKey: !!p.apiKey,
    baseUrl: p.baseUrl,
    model: p.model,
    enabled: p.enabled,
    configured: isProviderConfigured(p),
    isDefault: config.providers.default === name,
    recommended: name === RECOMMENDED_PROVIDER,
  };
}

/** A pasted mask ("sk-a••••b3c4") is never a key. */
function looksMasked(key: string): boolean {
  return key.includes('•');
}

/** Merge what the user typed over what is saved; an omitted key keeps the saved one. */
function draft(saved: ProviderConfig, body: { apiKey?: unknown; baseUrl?: unknown; model?: unknown }): ProviderConfig {
  return {
    ...saved,
    apiKey: typeof body.apiKey === 'string' && body.apiKey.trim() ? body.apiKey.trim() : saved.apiKey,
    baseUrl: typeof body.baseUrl === 'string' && body.baseUrl.trim() ? body.baseUrl.trim().replace(/\/+$/, '') : saved.baseUrl,
    model: typeof body.model === 'string' ? body.model.trim() : saved.model,
  };
}

type Problem = { field: 'apiKey' | 'baseUrl'; error: string };

/** Field-level problems before any network call. */
function problems(name: ProviderName, pc: ProviderConfig, body: { apiKey?: unknown }): Problem[] {
  const meta = PROVIDER_META[name];
  const out: Problem[] = [];
  if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
    const key = body.apiKey.trim();
    if (looksMasked(key)) out.push({ field: 'apiKey', error: 'That is the hidden form of the saved key. Paste the full key, or leave the field empty to keep the saved one.' });
    else if (/\s/.test(key)) out.push({ field: 'apiKey', error: 'The key has spaces in it. Copy it again without spaces or line breaks.' });
    else {
      const shape = validateApiKey(name, key);
      if (shape) out.push({ field: 'apiKey', error: shape.replace(/`/g, '"') });
    }
  }
  if (meta.needsKey && !pc.apiKey && !out.some((p) => p.field === 'apiKey')) out.push({ field: 'apiKey', error: `${meta.label} needs an API key.` });
  if (pc.baseUrl || meta.needsBaseUrl) {
    const bad = pc.baseUrl ? validateBaseUrl(pc.baseUrl) : 'A base URL is required.';
    if (bad) out.push({ field: 'baseUrl', error: bad });
  }
  return out;
}

/** Which field a failed live check points at, from the vendor's message. */
function blame(message: string): 'apiKey' | 'baseUrl' | undefined {
  if (/key|auth|401|403|unauthori[sz]ed|forbidden|credential/i.test(message)) return 'apiKey';
  if (/url|connect|reach|ECONN|ENOTFOUND|fetch failed|timed? ?out|abort/i.test(message)) return 'baseUrl';
  return undefined;
}

const providers = new Hono();

/** Every provider, with masked keys. The array shape is what the web dashboard reads. */
providers.get('/api/providers', (c) => {
  const config = loadConfig();
  const list = NAMES.filter((n) => config.providers[n]).map((n) => describe(n, config.providers[n], config));
  return c.json(list);
});

/** Everything the Settings screen needs in one call: providers, the default, and roles. */
providers.get('/api/providers/settings', (c) => {
  const config = loadConfig();
  const def = config.providers.default;
  return c.json({
    providers: NAMES.filter((n) => config.providers[n]).map((n) => describe(n, config.providers[n], config)),
    default: { provider: def, model: config.providers[def]?.model ?? '' },
    roles: {
      learning: config.memory.learning?.provider ?? null,
      crew: config.bots?.fleets?.crewProvider ?? null,
    },
    setupRequired: isSetupRequired(),
  });
});

/**
 * Check a key or URL before saving: its shape first, then a live call that
 * lists the models it can use. Nothing is written. The full list comes back
 * (not the terminal picker's 50) so the model menu can offer every model.
 */
providers.post('/api/providers/:name/check', async (c) => {
  const name = c.req.param('name');
  if (!isName(name)) return c.json({ ok: false, error: 'Unknown provider' }, 400);
  const body = (await c.req.json().catch(() => ({}))) as { apiKey?: unknown; baseUrl?: unknown };
  const config = loadConfig();
  const pc = draft(config.providers[name], body);
  const issues = PROVIDER_META[name].signInOnly ? [] : problems(name, pc, body);
  if (issues.length) return c.json({ ok: false, error: issues[0].error, field: issues[0].field, problems: issues });
  const started = Date.now();
  try {
    const { fetchProviderModelCatalog } = await import('../../utils/provider-models.js');
    const catalog = await fetchProviderModelCatalog(name, pc, { limit: 5000 });
    const models = [...new Set([catalog.recommendedModel, ...catalog.models].filter(Boolean))];
    return c.json({ ok: true, models, recommendedModel: catalog.recommendedModel, ms: Date.now() - started });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Connection failed';
    return c.json({ ok: false, error: message, field: blame(message), ms: Date.now() - started });
  }
});

/** Forget a provider's key and turn it off. */
providers.delete('/api/providers/:name/key', async (c) => {
  const name = c.req.param('name');
  if (!isName(name) || PROVIDER_META[name].signInOnly) return c.json({ error: 'Unknown provider' }, 400);
  const config = loadConfig();
  const p = config.providers[name];
  p.apiKey = '';
  p.enabled = false;
  handOverDefault(config, name);
  saveConfig(config);
  const result = await apply();
  return c.json({ success: true, provider: describe(name, p, config), ...result });
});

/**
 * Who does what: the default chat model, the model Mercury learns about you
 * with, and the one bot crews use. `null` for a role means "same as chat".
 */
providers.put('/api/providers/roles', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { default?: { provider?: unknown; model?: unknown }; learning?: unknown; crew?: unknown };
  const config = loadConfig();
  const active = new Set(getActiveProviders(config).map((p) => p.name));
  const usable = (v: unknown): v is ProviderName => isName(v) && active.has(v);

  if (body.default !== undefined) {
    const { provider, model } = body.default ?? {};
    if (!usable(provider)) return c.json({ error: 'Connect that provider before making it the default.', field: 'default' }, 400);
    if (model !== undefined) {
      const bad = typeof model === 'string' ? validateModelName(model) : 'Pick a model.';
      if (bad) return c.json({ error: bad, field: 'default' }, 400);
      config.providers[provider].model = (model as string).trim();
    }
    config.providers.default = provider;
  }
  for (const role of ['learning', 'crew'] as const) {
    const v = body[role];
    if (v === undefined) continue;
    if (v !== null && v !== '' && !usable(v)) return c.json({ error: 'Connect that provider before giving it a job.', field: role }, 400);
    const value = v ? (v as string) : undefined;
    if (role === 'learning') config.memory.learning = { ...config.memory.learning, provider: value };
    else if (config.bots?.fleets) config.bots.fleets.crewProvider = value;
  }
  saveConfig(config);
  const result = await apply();
  return c.json({ success: true, ...result, restartRequired: !result.applied && !result.restarting });
});

/**
 * Save a provider. Validates the fields (never stores a masked key), writes
 * mercury.yaml, then applies it to the running agent with no restart.
 */
providers.post('/api/providers/:name', async (c) => {
  const name = c.req.param('name');
  if (!isName(name)) return c.json({ error: 'Unknown provider' }, 400);
  const body = (await c.req.json().catch(() => ({}))) as { apiKey?: unknown; baseUrl?: unknown; model?: unknown; enabled?: unknown };
  const config = loadConfig();
  const p = config.providers[name];
  const meta = PROVIDER_META[name];
  if (meta.signInOnly && (body.apiKey !== undefined || body.baseUrl !== undefined)) {
    return c.json({ error: `${meta.label} signs in with your account (run \`mercury doctor\`); it has no key to set.` }, 400);
  }

  const next = draft(p, body);
  if (body.apiKey === '' || body.apiKey === null) next.apiKey = '';
  if (body.baseUrl === '' || body.baseUrl === null) next.baseUrl = '';
  if (body.model !== undefined) {
    const bad = typeof body.model === 'string' && body.model.trim() ? validateModelName(body.model) : 'Pick a model.';
    if (bad) return c.json({ error: bad, field: 'model' }, 400);
  }
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') return c.json({ error: 'enabled must be true or false' }, 400);
  const willBeOn = typeof body.enabled === 'boolean' ? body.enabled : p.enabled;
  if (willBeOn && !meta.signInOnly) {
    const issues = problems(name, next, body);
    if (issues.length) return c.json({ error: issues[0].error, field: issues[0].field, problems: issues }, 400);
  }

  p.apiKey = next.apiKey;
  p.baseUrl = next.baseUrl;
  p.model = next.model;
  if (typeof body.enabled === 'boolean') p.enabled = body.enabled;
  if (!p.enabled) handOverDefault(config, name);
  // The first provider anyone connects becomes the default.
  if (p.enabled && isProviderConfigured(p) && !isProviderConfigured(config.providers[config.providers.default])) config.providers.default = name;
  saveConfig(config);
  const result = await apply();
  return c.json({ success: true, provider: describe(name, p, config), ...result, restartRequired: !result.applied && !result.restarting });
});

/** Turning off (or forgetting) the default hands the default to another working provider. */
function handOverDefault(config: MercuryConfig, name: ProviderName): void {
  if (config.providers.default !== name) return;
  const other = getActiveProviders(config).find((x) => x.name !== name);
  if (other) config.providers.default = other.name as ProviderName;
}

/** The old test route: checks what is saved. Kept for the web dashboard; new clients use /check. */
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
