import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PluginManager, resetPluginManager } from './manager.js';
import { installedManifest } from './installer.js';
import { pluginDir, pluginSettingsPath, readState, resolvedSettings } from './store.js';
import { listLiveTools, resetToolBridge } from './tool-bridge.js';
import { runConformance, unresolvableImports } from './conformance.js';
import { manifestSchema } from './types.js';
import pluginRoutes from '../web/api/plugins.js';
import { inProcessPlugin, outOfProcessPlugin, tempHome } from './test-fixtures.js';

let env: ReturnType<typeof tempHome>;
let src: string;
let mgr: PluginManager;

beforeEach(() => {
  env = tempHome();
  src = join(env.home, 'src');
  mkdirSync(src, { recursive: true });
  resetToolBridge();
  mgr = new PluginManager({ safeMode: false, notify: () => {} });
});

afterEach(async () => {
  await mgr.shutdown();
  resetToolBridge();
  resetPluginManager();
  env.restore();
});

const v1Settings = {
  settings: {
    version: 1,
    fields: { units: { type: 'enum', options: ['celsius', 'fahrenheit'], default: 'celsius' }, city: { type: 'string', default: '' } },
  },
};
const v2Settings = {
  settings: {
    version: 2,
    fields: { unit: { type: 'enum', options: ['c', 'f'], default: 'c' }, city: { type: 'string', default: '' } },
    migrations: [{ to: 2, rename: { units: 'unit' }, mapValues: { unit: { celsius: 'c', fahrenheit: 'f' } } }],
  },
};

describe('settings migrations', () => {
  it('upgrades saved settings on update and restores the old ones on rollback', async () => {
    await mgr.install(inProcessPlugin(src, { id: 'weather', version: '1.0.0', manifest: v1Settings }));
    await mgr.setSetting('weather', 'units', 'fahrenheit');
    await mgr.setSetting('weather', 'city', 'Lahore');

    await mgr.install(inProcessPlugin(src, { id: 'weather', version: '2.0.0', manifest: v2Settings }));
    expect(readState().plugins.weather.version).toBe('2.0.0');
    const saved = JSON.parse(readFileSync(pluginSettingsPath('weather'), 'utf8'));
    expect(saved).toEqual({ settingsVersion: 2, values: { unit: 'f', city: 'Lahore' } });
    expect(resolvedSettings(installedManifest('weather', '2.0.0')!)).toEqual({ unit: 'f', city: 'Lahore' });
    expect(existsSync(join(pluginDir('weather'), 'settings.v1.json'))).toBe(true);

    await mgr.rollback('weather');
    expect(readState().plugins.weather.version).toBe('1.0.0');
    expect(resolvedSettings(installedManifest('weather', '1.0.0')!)).toEqual({ units: 'fahrenheit', city: 'Lahore' });
  });

  it('a corrupt settings file never stops the plugin: it starts on defaults', async () => {
    await mgr.install(inProcessPlugin(src, { id: 'weather', manifest: v1Settings }));
    writeFileSync(pluginSettingsPath('weather'), '{not json');
    await mgr.disable('weather');
    await mgr.enable('weather');
    expect(listLiveTools().some((t) => t.pluginId === 'weather')).toBe(true);
    expect(resolvedSettings(installedManifest('weather', '1.0.0')!)).toEqual({ units: 'celsius', city: '' });
  });

  it('rejects migrations that skip past the settings version or go backwards', () => {
    const base = JSON.parse(readFileSync(join(inProcessPlugin(src, { id: 'bad-mig' }), 'mercury-plugin.json'), 'utf8'));
    const bad = { ...base, settings: { version: 2, fields: {}, migrations: [{ to: 3 }] } };
    expect(manifestSchema.safeParse(bad).success).toBe(false);
    const backwards = { ...base, settings: { version: 3, fields: {}, migrations: [{ to: 3 }, { to: 2 }] } };
    expect(manifestSchema.safeParse(backwards).success).toBe(false);
  });
});

describe('conformance kit', () => {
  it('passes a well-formed in-process plugin, including stop and restart', async () => {
    const report = await runConformance(inProcessPlugin(src, { id: 'good-one', tools: [{ name: 'echo', description: 'Echo the input back to the caller.' }] }));
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.checks.map((c) => c.name)).toEqual(expect.arrayContaining(['manifest', 'self-contained bundle', 'start', 'tools', 'start: stop', 'restart (hot plug)', 'restart (hot plug): stop']));
    expect(listLiveTools()).toEqual([]);
  });

  it('passes an out-of-process MCP plugin', async () => {
    const report = await runConformance(outOfProcessPlugin(src, { id: 'mcp-ok' }));
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
  });

  it('flags a plugin that imports packages instead of bundling them', async () => {
    const dir = inProcessPlugin(src, {
      id: 'unbundled',
      code: `import { z } from 'zod';\nexport async function activate(ctx) {}`,
    });
    const report = await runConformance(dir);
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === 'self-contained bundle')?.ok).toBe(false);
  });

  it('flags a declared tool the plugin never registers', async () => {
    const dir = inProcessPlugin(src, { id: 'liar', code: 'export async function activate() {}' });
    const report = await runConformance(dir);
    expect(report.checks.find((c) => c.name === 'tools')).toMatchObject({ ok: false });
  });

  it('import scanner allows builtins and relative files only', () => {
    expect(unresolvableImports(`import fs from 'node:fs'; import path from "path"; import x from './x.js'; const y = await import('../y.mjs');`)).toEqual([]);
    expect(unresolvableImports(`import a from 'lodash'; export { b } from '@scope/pkg'; require('left-pad')`)).toEqual(['lodash', '@scope/pkg', 'left-pad']);
  });
});

describe('web API', () => {
  const loopback = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };
  const lan = { incoming: { socket: { remoteAddress: '192.168.1.20' } } };
  const post = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

  it('only accepts changes from this machine', async () => {
    const dir = inProcessPlugin(src, { id: 'web-test' });
    const denied = await pluginRoutes.request('/api/plugins/install', post({ source: dir }), lan);
    expect(denied.status).toBe(403);
    expect(readState().plugins['web-test']).toBeUndefined();

    const ok = await pluginRoutes.request('/api/plugins/install', post({ source: dir }), loopback);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { id: string }).id).toBe('web-test');

    const list = await pluginRoutes.request('/api/plugins', {}, lan);
    expect(list.status).toBe(200);
    expect(((await list.json()) as { items: Array<{ id: string }> }).items.map((i: { id: string }) => i.id)).toContain('web-test');

    expect((await pluginRoutes.request('/api/plugins/web-test/disable', post({}), lan)).status).toBe(403);
    expect((await pluginRoutes.request('/api/plugins/web-test', { method: 'DELETE' }, lan)).status).toBe(403);
    expect((await pluginRoutes.request('/api/plugins/web-test', { method: 'DELETE' }, loopback)).status).toBe(200);
    expect(readState().plugins['web-test']).toBeUndefined();
  });

  it('returns 404 for an unknown plugin and 400 for a bad source', async () => {
    expect((await pluginRoutes.request('/api/plugins/nope-nope/enable', post({}), loopback)).status).toBe(404);
    expect((await pluginRoutes.request('/api/plugins/install', post({ source: '' }), loopback)).status).toBe(400);
    expect((await pluginRoutes.request('/api/plugins/install', post({ source: 'http://insecure.example/p.tgz' }), loopback)).status).toBe(400);
  });
});

describe('optional secrets', () => {
  it('tells the owner once per version when an optional secret is missing', async () => {
    const { SECRET_NOTICE_DELAY } = await import('./manager.js');
    const saved = SECRET_NOTICE_DELAY.ms;
    SECRET_NOTICE_DELAY.ms = 20;
    const prev = process.env.FIXTURE_VOICE_KEY;
    delete process.env.FIXTURE_VOICE_KEY;
    const notices: string[] = [];
    const m = new PluginManager({ safeMode: false, notify: (n) => { notices.push(n); } });
    try {
      const manifest = { permissions: { network: [], secrets: ['FIXTURE_VOICE_KEY'], optionalSecrets: { FIXTURE_VOICE_KEY: 'Voice calls' } } };
      await m.install(inProcessPlugin(src, { id: 'voicey', manifest }));
      await new Promise((r) => setTimeout(r, 80));
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatch(/Voice calls needs FIXTURE_VOICE_KEY/);
      expect((await m.info('voicey'))?.missing).toMatchObject([{ key: 'secret:FIXTURE_VOICE_KEY', unlocks: 'Voice calls' }]);
      // Restarting the same version doesn't repeat it.
      await m.disable('voicey');
      await m.enable('voicey');
      await new Promise((r) => setTimeout(r, 80));
      expect(notices).toHaveLength(1);
      // With the key set, nothing is missing.
      process.env.FIXTURE_VOICE_KEY = 'k';
      expect((await m.info('voicey'))?.missing).toEqual([]);
    } finally {
      await m.shutdown();
      SECRET_NOTICE_DELAY.ms = saved;
      if (prev === undefined) delete process.env.FIXTURE_VOICE_KEY; else process.env.FIXTURE_VOICE_KEY = prev;
    }
  });

  it('an optional secret must also be declared in permissions.secrets', () => {
    const base = JSON.parse(readFileSync(join(inProcessPlugin(src, { id: 'bad-secret' }), 'mercury-plugin.json'), 'utf8'));
    const bad = { ...base, permissions: { network: [], secrets: [], optionalSecrets: { OPENAI_API_KEY: 'Voice calls' } } };
    expect(manifestSchema.safeParse(bad).success).toBe(false);
  });
});

describe('Mercury providers for plugins', () => {
  const code = `export async function activate(ctx) {
  ctx.tools.register({ name: 'echo', inputSchema: { type: 'object' }, execute: async () => JSON.stringify({ key: ctx.secrets.get('MERCURY_PROVIDER_OPENAI_API_KEY') ?? null, url: ctx.secrets.get('MERCURY_PROVIDER_OPENAI_BASE_URL') ?? null, raw: ctx.secrets.get('OPENAI_API_KEY') ?? null }) });
}`;
  const manifest = { permissions: { network: [], secrets: [], providers: { openai: 'Voice calls' } } };

  async function callEcho(): Promise<{ key: string | null; url: string | null; raw: string | null }> {
    const t = listLiveTools().find((x) => x.pluginId === 'prov' && x.name === 'echo')!;
    return JSON.parse(String(await t.invoke({}, new AbortController().signal)));
  }

  it('uses the key from Mercury\'s OpenAI provider; no plugin-specific setup', async () => {
    const { setProviderLookup } = await import('./manager.js');
    setProviderLookup((id) => (id === 'openai' ? { apiKey: 'sk-from-providers', baseUrl: 'https://api.openai.com/v1' } : undefined));
    try {
      await mgr.install(inProcessPlugin(src, { id: 'prov', code, manifest }));
      const got = await callEcho();
      expect(got.key).toBe('sk-from-providers');
      expect(got.url).toMatch(/^https:\/\//);
      expect(got.raw).toBeNull(); // only the provider names, never arbitrary env
      expect((await mgr.info('prov'))?.missing).toEqual([]);
    } finally {
      setProviderLookup(() => undefined);
    }
  });

  it('without an OpenAI provider: runs, and says to add one in Providers (not .env)', async () => {
    const { setProviderLookup } = await import('./manager.js');
    setProviderLookup(() => undefined);
    {
      await mgr.install(inProcessPlugin(src, { id: 'prov', code, manifest }));
      expect((await callEcho()).key).toBeNull();
      const missing = (await mgr.info('prov'))?.missing ?? [];
      expect(missing).toHaveLength(1);
      expect(missing[0]).toMatchObject({ key: 'provider:openai', unlocks: 'Voice calls', needs: 'an OpenAI provider' });
      expect(missing[0].fix).toMatch(/Providers/);
      expect(missing[0].fix).not.toMatch(/\.env/);
    }
  });
});

describe('secret settings (API keys a plugin asks for)', () => {
  const manifest = {
    permissions: { network: [], secrets: ['FIXTURE_VOICE_KEY'] },
    settings: { version: 1, fields: {
      engine: { type: 'enum', options: ['openai', 'other'], default: 'openai', setup: true },
      otherKey: { type: 'secret', secret: 'FIXTURE_VOICE_KEY', label: 'Other key', setup: true, when: { engine: 'other' } },
    } },
  };
  const code = `export async function activate(ctx) {
  ctx.tools.register({ name: 'echo', inputSchema: { type: 'object' }, execute: async () => String(ctx.secrets.get('FIXTURE_VOICE_KEY') ?? 'none') });
}`;

  it('are kept in the key store, never in settings, shown only as set, and reach the plugin', async () => {
    const prev = process.env.FIXTURE_VOICE_KEY;
    delete process.env.FIXTURE_VOICE_KEY;
    try {
      await mgr.install(inProcessPlugin(src, { id: 'keyed', code, manifest }));
      await mgr.setSetting('keyed', 'otherKey', 'sk-test-1234567890');
      const settingsFile = existsSync(pluginSettingsPath('keyed')) ? readFileSync(pluginSettingsPath('keyed'), 'utf8') : '';
      expect(settingsFile).not.toContain('sk-test');
      const { readPluginKeys } = await import('./store.js');
      expect(readPluginKeys().FIXTURE_VOICE_KEY).toBe('sk-test-1234567890');
      const s = (await mgr.info('keyed'))?.settings?.find((x) => x.key === 'otherKey');
      expect(s).toMatchObject({ type: 'secret', isSet: true, value: undefined });
      const t = listLiveTools().find((x) => x.pluginId === 'keyed')!;
      expect(await t.invoke({}, new AbortController().signal)).toBe('sk-test-1234567890'); // restarted with the key
      await mgr.setSetting('keyed', 'otherKey', '');
      expect((await mgr.info('keyed'))?.settings?.find((x) => x.key === 'otherKey')?.isSet).toBe(false);
      await expect(mgr.setSetting('keyed', 'otherKey', 'short')).rejects.toThrow(/API key/);
    } finally {
      if (prev !== undefined) process.env.FIXTURE_VOICE_KEY = prev;
    }
  });

  it('a secret setting must name a declared secret; "when" must refer to a real setting', () => {
    const base = JSON.parse(readFileSync(join(inProcessPlugin(src, { id: 'bad-keys' }), 'mercury-plugin.json'), 'utf8'));
    expect(manifestSchema.safeParse({ ...base, settings: { version: 1, fields: { k: { type: 'secret', secret: 'UNDECLARED_KEY' } } } }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...base, settings: { version: 1, fields: { k: { type: 'secret' } } } }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...base, settings: { version: 1, fields: { a: { type: 'string', when: { nope: 'x' } } } } }).success).toBe(false);
  });

  it('setup skips settings that do not apply to the choices made so far', async () => {
    const { PluginDialog, renderPrompt } = await import('./dialog.js');
    const { localService } = await import('./service.js');
    await mgr.install(inProcessPlugin(src, { id: 'keyed', code, manifest }));
    const d = (await PluginDialog.setup(localService(mgr), 'keyed'))!;
    expect(renderPrompt((await d.current())!, false)).toMatch(/engine/);
    await d.answer('1'); // openai: the "Other key" question doesn't apply
    expect(renderPrompt((await d.current())!, false)).toMatch(/is set up/);
    const d2 = (await PluginDialog.setup(localService(mgr), 'keyed'))!;
    await d2.current();
    await d2.answer('2'); // other: now it asks for the key
    expect(renderPrompt((await d2.current())!, false)).toMatch(/Other key[\s\S]*Paste the key here/);
  });
});

describe('menu sections and "ask only while missing"', () => {
  const manifest = {
    permissions: { network: [], secrets: ['FIXTURE_GEM_KEY'], providers: { openai: { unlocks: 'Voice calls', when: { engine: 'openai' }, alternative: 'Or pick another voice in Voice calls.' } } },
    settings: {
      version: 1,
      groups: { voice: { label: '🎙 Voice calls', readyUnless: ['provider:openai'] } },
      fields: {
        owner: { type: 'string', label: 'Your number', setup: true },
        engine: { type: 'enum', options: ['openai', 'gemini'], default: 'openai', label: 'Who handles calls?', setup: true, setupWhenMissing: 'provider:openai', group: 'voice', optionLabels: { openai: '⭐ OpenAI: recommended', gemini: 'Gemini' } },
        gemKey: { type: 'secret', secret: 'FIXTURE_GEM_KEY', label: 'Gemini key', setup: true, required: true, group: 'voice', when: { engine: 'gemini' } },
      },
    },
  };

  async function open(kind: 'setup' | 'menu') {
    const { PluginDialog, renderPrompt } = await import('./dialog.js');
    const { localService } = await import('./service.js');
    const d = kind === 'setup' ? await PluginDialog.setup(localService(mgr), 'voicey') : await PluginDialog.menu(localService(mgr), 'voicey', true);
    return { d: d!, text: async () => renderPrompt((await d!.current())!, false) };
  }

  it('with an OpenAI key, setup never asks which voice to use', async () => {
    const { setProviderLookup } = await import('./manager.js');
    setProviderLookup((id) => (id === 'openai' ? { apiKey: 'sk-x' } : undefined));
    try {
      await mgr.install(inProcessPlugin(src, { id: 'voicey', manifest }));
      const { d, text } = await open('setup');
      expect(await text()).toMatch(/Your number/);
      await d.answer('+15550001111');
      expect(await text()).toMatch(/is set up/);
      const menu = await open('menu');
      expect(await menu.text()).toMatch(/🎙 Voice calls: OpenAI ✓/);
    } finally {
      setProviderLookup(() => undefined);
    }
  });

  it('without one, setup asks, recommends OpenAI first, and the menu shows the section as not set up', async () => {
    const { setProviderLookup } = await import('./manager.js');
    setProviderLookup(() => undefined);
    const prev = process.env.FIXTURE_GEM_KEY;
    delete process.env.FIXTURE_GEM_KEY;
    try {
      await mgr.install(inProcessPlugin(src, { id: 'voicey', manifest }));
      const { d, text } = await open('setup');
      await text();
      await d.answer('+15550001111');
      expect(await text()).toMatch(/Who handles calls\?[\s\S]*1\* · ⭐ OpenAI: recommended[\s\S]*2\* · Gemini/);
      expect((await mgr.info('voicey'))?.missing?.[0].fix).toMatch(/Or pick another voice in Voice calls\./);

      const menu = await open('menu');
      expect(await menu.text()).toMatch(/🎙 Voice calls: OpenAI ⚠ needs setup/);
      // Choosing Gemini in the section asks for its key; until then it isn't ready.
      await mgr.setSetting('voicey', 'engine', 'gemini');
      expect((await mgr.info('voicey'))?.settingGroups?.[0].ready).toBe(false);
      await mgr.setSetting('voicey', 'gemKey', 'gem-key-123456');
      expect((await mgr.info('voicey'))?.settingGroups?.[0].ready).toBe(true);
    } finally {
      if (prev !== undefined) process.env.FIXTURE_GEM_KEY = prev;
    }
  });

  it('the section lists what applies, and a new choice asks for what it needs', async () => {
    const { setProviderLookup } = await import('./manager.js');
    setProviderLookup(() => undefined);
    await mgr.install(inProcessPlugin(src, { id: 'voicey', manifest }));
    const { d, text } = await open('menu');
    expect(await text()).toMatch(/1\* · 🎙 Voice calls/);
    await d.answer('1');
    expect(await text()).toMatch(/🎙 Voice calls[\s\S]*1\* · Who handles calls\?: OpenAI[\s\S]*Set up step by step[\s\S]*← Back/);
    expect(await text()).not.toMatch(/Gemini key/); // doesn't apply to OpenAI
    await d.answer('1');
    expect(await text()).toMatch(/Who handles calls\?/);
    await d.answer('2'); // Gemini → now its key
    expect(await text()).toMatch(/Gemini key[\s\S]*Paste the key/);
  });
});
