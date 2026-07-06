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

  const validNames: ProviderName[] = ['openai', 'anthropic', 'deepseek', 'grok', 'ollamaCloud', 'ollamaLocal', 'mimo', 'mimoTokenPlan', 'openrouter'];
  if (!validNames.includes(providerName)) {
    return c.json({ error: 'Unknown provider' }, 400);
  }

  const p = config.providers[providerName];
  if (body.apiKey !== undefined) p.apiKey = body.apiKey;
  if (body.baseUrl !== undefined) p.baseUrl = body.baseUrl;
  if (body.model !== undefined) {
    if (providerName === 'openrouter' && body.model) {
      try {
        const { fetchFullOpenRouterCatalog } = await import('../../utils/provider-models.js');
        const fullCatalog = await fetchFullOpenRouterCatalog(p as ProviderConfig);
        if (!fullCatalog.includes(body.model)) {
          let suggestion = '';
          const inputLower = (body.model as string).toLowerCase();
          for (const model of fullCatalog) {
            if (model.toLowerCase().includes(inputLower) || inputLower.includes(model.toLowerCase().split('/').pop() ?? '')) {
              suggestion = model;
              break;
            }
          }
          const detail = suggestion
            ? `Did you mean: ${suggestion}?`
            : 'Please select a model from the OpenRouter catalog.';
          return c.json({ error: `Model "${body.model}" not found in OpenRouter catalog. ${detail}` }, 400);
        }
      } catch {
        // Catalog fetch failed — allow the model through without validation
      }
    }
    p.model = body.model;
  }
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
    const maxModels = providerName === 'openrouter' ? 20 : 10;
    return c.json({ success: true, models: catalog.models.slice(0, maxModels), recommendedModel: catalog.recommendedModel });
  } catch (err: any) {
    return c.json({ success: false, error: err.message || 'Connection failed' }, 400);
  }
});

export default providers;