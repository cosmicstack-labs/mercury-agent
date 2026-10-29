import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// mercury.yaml's path is fixed when config.ts loads: point MERCURY_HOME at a
// temp dir with one working provider before importing the routes.
const home = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'GROK_API_KEY', 'AIMLAPI_API_KEY', 'DEFAULT_PROVIDER']) delete process.env[k];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-providers-route-'));
  fs.writeFileSync(path.join(dir, 'mercury.yaml'), [
    'identity:',
    '  owner: Test',
    'providers:',
    '  default: deepseek',
    '  deepseek:',
    '    name: deepseek',
    '    apiKey: sk-saveddeepseekkey0000000000',
    '    baseUrl: https://api.deepseek.com/v1',
    '    model: deepseek-chat',
    '    enabled: true',
    '',
  ].join('\n'));
  process.env.MERCURY_HOME = dir;
  return dir;
});

const catalog = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('../../utils/provider-models.js', () => ({ fetchProviderModelCatalog: catalog.fn }));

import providers, { setFirstProviderHandler, setProvidersReload } from './providers.js';

function call(method: string, path: string, body?: unknown) {
  return providers.request(`http://127.0.0.1${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const yaml = () => readFileSync(join(home, 'mercury.yaml'), 'utf-8');

interface ProviderRow { id: string; apiKey?: string; signInOnly?: boolean }
interface ProviderSettingsBody {
  default: { provider: string; model: string };
  providers: ProviderRow[];
  roles: Record<string, string | null>;
  setupRequired: boolean;
}
interface CheckBody { ok: boolean; error?: string; field?: string; models: string[] }

afterEach(() => {
  catalog.fn.mockReset();
  setProvidersReload(null);
  setFirstProviderHandler(null);
});

describe('providers settings', () => {
  it('lists every provider with masked keys, the default and roles', async () => {
    const res = await call('GET', '/api/providers/settings');
    const body = await res.json() as ProviderSettingsBody;
    expect(body.default).toEqual({ provider: 'deepseek', model: 'deepseek-chat' });
    const ds = body.providers.find((p: { id: string }) => p.id === 'deepseek');
    expect(ds).toMatchObject({ label: 'DeepSeek', kind: 'cloud', configured: true, isDefault: true, hasKey: true });
    expect(ds?.apiKey).toBe('sk-s••••0000');
    expect(JSON.stringify(body)).not.toContain('saveddeepseekkey');
    expect(body.providers.find((p: { id: string }) => p.id === 'chatgptWeb')?.signInOnly).toBe(true);
    expect(body.setupRequired).toBe(false);
  });

  it('checks an unsaved key: shape first, with no network call', async () => {
    const res = await call('POST', '/api/providers/anthropic/check', { apiKey: 'sk-wrong-shape-1234567890' });
    const body = await res.json() as CheckBody;
    expect(body).toMatchObject({ ok: false, field: 'apiKey' });
    expect(body.error).toMatch(/sk-ant-/);
    expect(catalog.fn).not.toHaveBeenCalled();
  });

  it('never accepts the masked form of a key', async () => {
    const res = await call('POST', '/api/providers/deepseek/check', { apiKey: 'sk-s••••0000' });
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/hidden form/) });
    const save = await call('POST', '/api/providers/deepseek', { apiKey: 'sk-s••••0000' });
    expect(save.status).toBe(400);
    expect(yaml()).toContain('sk-saveddeepseekkey0000000000');
  });

  it('checks live and returns every model, recommended first, without saving', async () => {
    const many = Array.from({ length: 120 }, (_, i) => `claude-model-${i}`);
    catalog.fn.mockResolvedValue({ recommendedModel: 'claude-sonnet-x', models: many });
    const res = await call('POST', '/api/providers/anthropic/check', { apiKey: 'sk-ant-abcdefghijklmnopqrstuvwx' });
    const body = await res.json() as CheckBody;
    expect(body.ok).toBe(true);
    expect(body.models[0]).toBe('claude-sonnet-x');
    expect(body.models.length).toBe(121);
    expect(catalog.fn.mock.calls[0][1].apiKey).toBe('sk-ant-abcdefghijklmnopqrstuvwx');
    expect(catalog.fn.mock.calls[0][2]).toEqual({ limit: 5000 });
    expect(yaml()).not.toContain('sk-ant-abcdefghijklmnopqrstuvwx');
  });

  it('points a vendor rejection at the key field', async () => {
    catalog.fn.mockRejectedValue(new Error('Anthropic rejected the API key (401). Please re-enter it.'));
    const body = await (await call('POST', '/api/providers/anthropic/check', { apiKey: 'sk-ant-abcdefghijklmnopqrstuvwx' })).json();
    expect(body).toMatchObject({ ok: false, field: 'apiKey' });
  });

  it('saves, then applies live through the reloader', async () => {
    const reload = vi.fn().mockResolvedValue({ ok: true, providers: ['deepseek', 'anthropic'], default: 'deepseek', model: 'deepseek-chat' });
    setProvidersReload(reload);
    const res = await call('POST', '/api/providers/anthropic', { apiKey: 'sk-ant-abcdefghijklmnopqrstuvwx', model: 'claude-sonnet-x', enabled: true });
    const body: unknown = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ success: true, applied: true, restartRequired: false });
    expect(body).toMatchObject({ provider: { configured: true, model: 'claude-sonnet-x' } });
    expect(reload).toHaveBeenCalledOnce();
    expect(yaml()).toContain('sk-ant-abcdefghijklmnopqrstuvwx');
  });

  it('rejects a bad model and a bad URL with the field to fix', async () => {
    const m = await call('POST', '/api/providers/anthropic', { model: 'has spaces in it' });
    expect(await m.json()).toMatchObject({ field: 'model' });
    const u = await call('POST', '/api/providers/openaiCompat', { baseUrl: 'ftp://nope', model: 'x', enabled: true });
    expect(u.status).toBe(400);
    expect(await u.json()).toMatchObject({ field: 'baseUrl' });
  });

  it('sets the default model and job roles, only to connected providers', async () => {
    const bad = await call('PUT', '/api/providers/roles', { default: { provider: 'grok', model: 'grok-4' } });
    expect(bad.status).toBe(400);
    const ok = await call('PUT', '/api/providers/roles', { default: { provider: 'anthropic', model: 'claude-opus-x' }, learning: 'deepseek', crew: null });
    expect(ok.status).toBe(200);
    const s = await (await call('GET', '/api/providers/settings')).json() as ProviderSettingsBody;
    expect(s.default).toEqual({ provider: 'anthropic', model: 'claude-opus-x' });
    expect(s.roles.learning).toBe('deepseek');
  });

  it('forgetting the default key hands the default to another working provider', async () => {
    const res = await call('DELETE', '/api/providers/anthropic/key');
    expect(res.status).toBe(200);
    const s = await (await call('GET', '/api/providers/settings')).json() as ProviderSettingsBody;
    expect(s.default.provider).toBe('deepseek');
    expect(s.providers.find((p: { id: string }) => p.id === 'anthropic')).toMatchObject({ hasKey: false, enabled: false, configured: false });
  });

  it('refuses keys for sign-in providers', async () => {
    const res = await call('POST', '/api/providers/chatgptWeb', { apiKey: 'sk-abcdefghijklmnopqrstuvwx' });
    expect(res.status).toBe(400);
  });

  it('in setup mode, the first working provider restarts the runtime', async () => {
    vi.useFakeTimers();
    const restart = vi.fn();
    setFirstProviderHandler(restart);
    expect(await (await call('GET', '/api/providers/settings')).json()).toMatchObject({ setupRequired: true });
    const body = await (await call('POST', '/api/providers/grok', { apiKey: 'xai-abcdefghijklmnopqrstuvwxyz123456', model: 'grok-4', enabled: true })).json();
    expect(body).toMatchObject({ success: true, restarting: true });
    vi.advanceTimersByTime(400);
    expect(restart).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
