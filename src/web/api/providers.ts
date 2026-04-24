import { Hono } from 'hono';
import { loadConfig, saveConfig, type ProviderConfig, type ProviderName } from '../../utils/config.js';

function maskApiKey(key: string): string {
  if (!key || key.length < 8) return key ? '••••••' : '';
  return key.slice(0, 4) + '••••' + key.slice(-4);
}

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
  }));
  return c.json(list);
});

providers.post('/api/providers/:name', async (c) => {
  const providerName = c.req.param('name') as ProviderName;
  const body = await c.req.json();
  const config = loadConfig();

  const validNames: ProviderName[] = ['openai', 'anthropic', 'deepseek', 'grok', 'ollamaCloud', 'ollamaLocal'];
  if (!validNames.includes(providerName)) {
    return c.json({ error: 'Unknown provider' }, 400);
  }

  const p = config.providers[providerName];
  if (body.apiKey !== undefined) p.apiKey = body.apiKey;
  if (body.baseUrl !== undefined) p.baseUrl = body.baseUrl;
  if (body.model !== undefined) p.model = body.model;
  if (body.enabled !== undefined) p.enabled = body.enabled;

  saveConfig(config);
  return c.json({ success: true });
});

providers.post('/api/providers/:name/test', async (c) => {
  const providerName = c.req.param('name') as ProviderName;
  const config = loadConfig();
  const p = config.providers[providerName];

  if (!p || !p.apiKey) {
    return c.json({ error: 'No API key configured' }, 400);
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