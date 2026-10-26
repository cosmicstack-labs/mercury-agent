import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_RENDERER_BYTES, RENDERER_HEADERS, duplicateLanguages, listRenderers, readRendererAsset } from './renderers.js';
import { pluginVersionDir, readState, writeState } from './store.js';
import { tempHome } from './test-fixtures.js';
import type { PluginManifest, PluginsState } from './types.js';

/**
 * The renderer seam: a plugin declares a fenced-block renderer, Mercury serves its asset,
 * the dashboard draws it sandboxed. The tests that matter are the refusals — a disabled
 * plugin, a path that leaves the folder, an oversized file — because each one is the
 * difference between "no renderer" and "someone else's bytes in your dashboard".
 */
let env: ReturnType<typeof tempHome>;

beforeEach(() => {
  env = tempHome();
});
afterEach(() => env.restore());

const ASSET = '<!doctype html><title>x</title><p>hello</p>';

function installPlugin(id: string, overrides: Partial<PluginManifest> = {}, options: { enabled?: boolean; asset?: string } = {}) {
  const version = overrides.version ?? '1.0.0';
  const dir = pluginVersionDir(id, version);
  mkdirSync(join(dir, 'renderer'), { recursive: true });
  const manifest: PluginManifest = {
    manifestVersion: 1,
    id,
    name: `${id} plugin`,
    version,
    description: 'a plugin with a renderer',
    kind: 'in-process',
    engines: { mercury: '>=1.0.0 <2.0.0', pluginApi: '^1.3.0' },
    entry: 'index.mjs',
    contributes: {
      tools: [],
      commands: [],
      renderers: [{ language: 'openui', asset: 'renderer/openui.html', sandbox: 'iframe' }],
    },
    permissions: { network: [], secrets: [] },
    ...overrides,
  } as PluginManifest;
  writeFileSync(join(dir, 'mercury-plugin.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(dir, 'index.mjs'), 'export async function activate() {}\n');
  writeFileSync(join(dir, options.asset ?? 'renderer/openui.html'), ASSET);

  const state = readState();
  const next: PluginsState = {
    ...state,
    plugins: {
      ...state.plugins,
      [id]: {
        version,
        enabled: options.enabled ?? true,
        kind: 'in-process',
        source: { type: 'path', ref: dir },
        verified: false,
        installedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    },
  };
  writeState(next);
  return dir;
}

describe('listRenderers', () => {
  it('lists nothing when no plugin declares a renderer', () => {
    expect(listRenderers()).toEqual([]);
  });

  it('lists a renderer with the URL the client should load', () => {
    installPlugin('openui-contract');
    expect(listRenderers()).toEqual([
      expect.objectContaining({
        pluginId: 'openui-contract',
        language: 'openui',
        sandbox: 'iframe',
        url: '/api/ui/renderers/openui-contract/openui',
      }),
    ]);
  });

  it('skips a disabled plugin: disabling must be the whole kill switch', () => {
    installPlugin('openui-contract', {}, { enabled: false });
    expect(listRenderers()).toEqual([]);
    expect(readRendererAsset('openui-contract', 'openui')).toBeNull();
  });

  it('reports two plugins claiming the same language', () => {
    installPlugin('openui-contract');
    installPlugin('openui-copy');
    expect(duplicateLanguages()).toEqual(['openui']);
    expect(listRenderers()).toHaveLength(2);
  });
});

describe('readRendererAsset', () => {
  it('serves the declared asset', () => {
    installPlugin('openui-contract');
    expect(readRendererAsset('openui-contract', 'openui')).toMatchObject({ html: ASSET, language: 'openui' });
  });

  it('refuses a language the plugin does not claim', () => {
    installPlugin('openui-contract');
    expect(readRendererAsset('openui-contract', 'mermaid')).toBeNull();
  });

  it('refuses an unknown plugin', () => {
    expect(readRendererAsset('nobody', 'openui')).toBeNull();
  });

  it('refuses an asset that left the plugin folder', () => {
    // The manifest says ../../../etc/passwd: the URL is a lookup key, not a file path.
    installPlugin('openui-contract', {
      contributes: {
        tools: [],
        commands: [],
        renderers: [{ language: 'openui', asset: 'renderer/openui.html', sandbox: 'iframe' }],
      },
    });
    const dir = pluginVersionDir('openui-contract', '1.0.0');
    const manifestPath = join(dir, 'mercury-plugin.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.contributes.renderers[0].asset = '../../../outside.html';
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(readRendererAsset('openui-contract', 'openui')).toBeNull();
  });

  it('refuses a missing asset instead of serving nothing', () => {
    installPlugin('openui-contract');
    const dir = pluginVersionDir('openui-contract', '1.0.0');
    const manifestPath = join(dir, 'mercury-plugin.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.contributes.renderers[0].asset = 'renderer/gone.html';
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(readRendererAsset('openui-contract', 'openui')).toBeNull();
  });

  it('refuses an asset over the size limit', () => {
    installPlugin('openui-contract');
    const dir = pluginVersionDir('openui-contract', '1.0.0');
    writeFileSync(join(dir, 'renderer/openui.html'), 'x'.repeat(MAX_RENDERER_BYTES + 1));
    expect(readRendererAsset('openui-contract', 'openui')).toBeNull();
  });
});

describe('/plugins info', () => {
  it('names the languages the plugin draws, so the owner sees what it claims', async () => {
    const { resetPluginManager } = await import('./manager.js');
    const { handlePluginsCommand } = await import('./commands.js');
    resetPluginManager();
    installPlugin('openui-contract');
    const sent: string[] = [];
    const channel = { type: 'cli', send: async (t: string) => { sent.push(t); } };
    const msg = { id: '1', channelId: 'cli:test', channelType: 'cli' as const, senderId: 'owner', content: '', timestamp: Date.now() };
    await handlePluginsCommand('/plugins info openui-contract', msg, channel as never);
    expect(sent.at(-1)).toMatch(/Dashboard blocks: openui/);
  });
});

describe('the headers a renderer is served with', () => {
  it('blocks every network call and every frame', () => {
    const csp = RENDERER_HEADERS['Content-Security-Policy'];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).not.toContain('unsafe-eval');
    expect(RENDERER_HEADERS['X-Content-Type-Options']).toBe('nosniff');
  });
});
