import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import pluginRoutes from './plugins.js';
import { authGuard } from '../middleware.js';
import { pluginVersionDir, readState, writeState } from '../../plugins/store.js';
import { tempHome } from '../../plugins/test-fixtures.js';
import type { PluginManifest, PluginsState } from '../../plugins/types.js';

/**
 * The two routes behind a plugin renderer, and the one line of the auth guard that decides
 * who may read them. The asset has to be reachable by a frame with an opaque origin (no
 * cookie, so no session), and the listing has to stay behind the session — a guard test
 * that only proved "the route answers" would let either half regress unnoticed.
 */
const ASSET = '<!doctype html><title>demo</title><p>drawn</p>';

let env: ReturnType<typeof tempHome>;

beforeEach(() => {
  env = tempHome();
});
afterEach(() => env.restore());

function installRendererPlugin(id = 'demo', language = 'openui') {
  const dir = pluginVersionDir(id, '1.0.0');
  mkdirSync(join(dir, 'renderer'), { recursive: true });
  const manifest: PluginManifest = {
    manifestVersion: 1,
    id,
    name: `${id} plugin`,
    version: '1.0.0',
    description: 'a plugin with a renderer',
    kind: 'in-process',
    engines: { mercury: '>=1.0.0 <2.0.0', pluginApi: '^1.3.0' },
    entry: 'index.mjs',
    contributes: { tools: [], commands: [], renderers: [{ language, asset: 'renderer/demo.html', sandbox: 'iframe' }] },
    permissions: { network: [], secrets: [] },
  } as PluginManifest;
  writeFileSync(join(dir, 'mercury-plugin.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(dir, 'index.mjs'), 'export async function activate() {}\n');
  writeFileSync(join(dir, 'renderer/demo.html'), ASSET);
  const state = readState();
  const next: PluginsState = {
    ...state,
    plugins: {
      ...state.plugins,
      [id]: {
        version: '1.0.0',
        enabled: true,
        kind: 'in-process',
        source: { type: 'path', ref: dir },
        verified: false,
        installedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    },
  };
  writeState(next);
}

function guardedApp() {
  const app = new Hono();
  app.use('*', authGuard);
  app.route('/', pluginRoutes);
  app.get('/api/other', (c) => c.json({ ok: true }));
  return app;
}

describe('renderer routes', () => {
  it('serves the asset to a frame with no session, with the CSP attached', async () => {
    installRendererPlugin();
    const res = await guardedApp().request('/api/ui/renderers/demo/openui');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(ASSET);
    expect(res.headers.get('Content-Security-Policy')).toContain("connect-src 'none'");
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('keeps the listing behind the session: only the asset is public', async () => {
    installRendererPlugin();
    const app = guardedApp();
    expect((await app.request('/api/ui/renderers')).status).toBe(401);
    expect((await app.request('/api/other')).status).toBe(401);
  });

  it('answers 404 for a language the plugin does not claim', async () => {
    installRendererPlugin();
    const res = await guardedApp().request('/api/ui/renderers/demo/mermaid');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'No such renderer' });
  });

  it('answers 404 for a plugin that is not installed', async () => {
    const res = await guardedApp().request('/api/ui/renderers/ghost/openui');
    expect(res.status).toBe(404);
  });
});
