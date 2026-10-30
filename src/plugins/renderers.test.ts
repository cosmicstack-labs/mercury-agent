import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Plugin API 1.3 — fenced-block renderers.
 *
 * A renderer is an HTML document a plugin ships and Mercury hosts in a
 * sandboxed iframe. Two things are being pinned here: that the document is
 * served with a CSP that leaves it nothing to reach, and that only an asset the
 * manifest declares can be fetched — a route that reads files out of a plugin
 * folder without that check is a file-read primitive.
 */
const env = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-renderers-'));
  process.env.MERCURY_HOME = home;
  process.env.MERCURY_PLUGIN_CATALOG_URL = 'off';
  return { home };
});

import pluginRoutes from '../web/api/plugins.js';
import { installPackage, loadManifest } from './installer.js';
import { getPluginManager } from './manager.js';

const RENDERER_HTML = '<!doctype html><title>Diff</title><script>parent.postMessage({v:1,type:"ready"},"*")</script>';

function rendererPlugin(): string {
  const dir = join(env.home, 'src', 'diff-view-0.1.0');
  mkdirSync(join(dir, 'renderer'), { recursive: true });
  writeFileSync(join(dir, 'mercury-plugin.json'), JSON.stringify({
    manifestVersion: 1,
    id: 'diff-view',
    name: 'Diff View',
    version: '0.1.0',
    description: 'Draws a diff fence',
    kind: 'in-process',
    engines: { mercury: '>=1.0.0', pluginApi: '^1.3.0' },
    entry: 'index.mjs',
    contributes: {
      tools: [],
      commands: [],
      renderers: [{ language: 'diff', title: 'Unified diff', asset: 'renderer/diff.html' }],
    },
    permissions: { network: [], secrets: [] },
  }, null, 2));
  writeFileSync(join(dir, 'index.mjs'), 'export async function activate() {}\n');
  writeFileSync(join(dir, 'renderer', 'diff.html'), RENDERER_HTML);
  // Not declared anywhere: the route must not hand it out.
  writeFileSync(join(dir, 'private.txt'), 'secret');
  return dir;
}

async function fetchAsset(asset: string) {
  return pluginRoutes.request(`http://127.0.0.1/api/plugins/diff-view/renderer/${asset}`);
}

beforeEach(async () => {
  await installPackage({ type: 'path', path: rendererPlugin() }, { force: true });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('renderer manifests', () => {
  it('accepts a declared renderer and defaults the sandbox to iframe', () => {
    const manifest = loadManifest(rendererPlugin());

    expect(manifest.contributes.renderers).toEqual([
      { language: 'diff', title: 'Unified diff', asset: 'renderer/diff.html', sandbox: 'iframe' },
    ]);
  });

  it('still refuses a contribution it does not know', async () => {
    const dir = rendererPlugin();
    const raw = JSON.parse((await import('node:fs')).readFileSync(join(dir, 'mercury-plugin.json'), 'utf8'));
    raw.contributes.widgets = [];
    (await import('node:fs')).writeFileSync(join(dir, 'mercury-plugin.json'), JSON.stringify(raw));

    expect(() => loadManifest(dir)).toThrow(/Unrecognized key/);
  });
});

describe('renderer route', () => {
  it('serves the declared asset as a document nothing can escape', async () => {
    const res = await fetchAsset('renderer/diff.html');

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(RENDERER_HTML);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const csp = res.headers.get('content-security-policy') ?? '';
    // The document may draw; it may not call, submit, or pivot.
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'unsafe-inline'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("form-action 'none'");
  });

  it('refuses a file the manifest does not declare', async () => {
    const res = await fetchAsset('private.txt');

    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('secret');
  });

  it('refuses a path that climbs out of the plugin folder', async () => {
    for (const attempt of ['../mercury-plugin.json', 'renderer/../../mercury-plugin.json', '%2e%2e%2fmercury-plugin.json']) {
      const res = await fetchAsset(attempt);
      expect(res.status, attempt).toBe(404);
    }
  });

  it('answers 404 for a plugin that is not installed', async () => {
    const res = await pluginRoutes.request('http://127.0.0.1/api/plugins/nope/renderer/renderer/diff.html');
    expect(res.status).toBe(404);
  });
});

describe('renderers in the plugin list', () => {
  it('hands the dashboard a URL that carries the installed version', async () => {
    const { items } = await getPluginManager().list();

    const item = items.find((entry) => entry.id === 'diff-view');
    expect(item?.renderers).toEqual([
      { language: 'diff', title: 'Unified diff', url: '/api/plugins/diff-view/renderer/renderer/diff.html?v=0.1.0' },
    ]);
  });
});
