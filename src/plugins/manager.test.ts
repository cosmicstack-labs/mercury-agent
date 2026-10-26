import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Tool } from 'ai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PermissionManager } from '../capabilities/permissions.js';
import { CIRCUIT_BREAKER_FAILURES, PluginManager } from './manager.js';
import { IN_PROCESS_TIMEOUTS } from './runtime/in-process.js';
import { OUT_OF_PROCESS } from './runtime/out-of-process.js';
import { readState, updateState, pluginDir } from './store.js';
import { getPluginCommand, getPluginTools, listLiveTools, resetToolBridge } from './tool-bridge.js';
import { inProcessPlugin, outOfProcessPlugin, sleep, tempHome, waitFor } from './test-fixtures.js';

let env: ReturnType<typeof tempHome>;
let src: string;
let mgr: PluginManager;
let notices: string[];
const savedTimeouts = { ...IN_PROCESS_TIMEOUTS };
const savedOop = { ...OUT_OF_PROCESS };

beforeEach(() => {
  env = tempHome();
  src = join(env.home, 'src');
  mkdirSync(src, { recursive: true });
  resetToolBridge();
  notices = [];
  mgr = new PluginManager({ safeMode: false, notify: (m) => { notices.push(m); } });
});

afterEach(async () => {
  await mgr.shutdown();
  Object.assign(IN_PROCESS_TIMEOUTS, savedTimeouts);
  Object.assign(OUT_OF_PROCESS, savedOop);
  resetToolBridge();
  env.restore();
});

async function call(tools: Record<string, Tool>, name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const t = tools[name] as Tool & { execute: (a: unknown, o: unknown) => Promise<unknown> };
  expect(t, `tool ${name}`).toBeDefined();
  return t.execute(args, { toolCallId: 't1', messages: [] });
}

describe('in-process plugins', () => {
  it('install → enabled → tools are live, namespaced and callable', async () => {
    await mgr.install(inProcessPlugin(src));
    const tools = getPluginTools(new PermissionManager());
    expect(Object.keys(tools)).toEqual(['echo-tools__echo']);
    expect(await call(tools, 'echo-tools__echo', { text: 'hi' })).toBe('echo: hi');
    const { items } = await mgr.list();
    expect(items.find((i) => i.id === 'echo-tools')).toMatchObject({ status: 'enabled', running: true, enabled: true });
  });

  it('disable removes the tools; enable brings them back with a fresh instance', async () => {
    await mgr.install(inProcessPlugin(src));
    await mgr.disable('echo-tools');
    expect(listLiveTools()).toHaveLength(0);
    expect(readState().plugins['echo-tools']).toMatchObject({ enabled: false, disabled: { code: 'user' } });
    await mgr.enable('echo-tools');
    expect(listLiveTools().map((t) => t.name)).toEqual(['echo']);
  });

  it('activate() that throws disables the plugin with the reason and keeps Mercury running', async () => {
    const dir = inProcessPlugin(src, { id: 'throws', code: 'export async function activate() { throw new Error("boom in activate"); }' });
    await expect(mgr.install(dir)).rejects.toThrow(/boom in activate/);
    expect(readState().plugins.throws).toMatchObject({ enabled: false, disabled: { code: 'activation' } });
    expect(notices.join('\n')).toMatch(/throws.*boom in activate/);
    expect(listLiveTools()).toHaveLength(0);
  });

  it('activate() that hangs times out', async () => {
    IN_PROCESS_TIMEOUTS.activate = 200;
    const dir = inProcessPlugin(src, { id: 'hangs', code: 'export function activate() { return new Promise(() => {}); }' });
    await expect(mgr.install(dir)).rejects.toThrow(/activate\(\) timed out/);
    expect(readState().plugins.hangs.disabled?.code).toBe('activation');
  });

  it('a module without activate() is rejected', async () => {
    const dir = inProcessPlugin(src, { id: 'noact', code: 'export const x = 1;' });
    await expect(mgr.install(dir)).rejects.toThrow(/does not export an activate/);
  });

  it('registering an undeclared tool fails activation', async () => {
    const dir = inProcessPlugin(src, {
      id: 'sneaky-tool',
      code: `export function activate(ctx) { ctx.tools.register({ name: 'rm_everything', inputSchema: { type: 'object' }, execute: () => 'x' }); }`,
    });
    await expect(mgr.install(dir)).rejects.toThrow(/"rm_everything" is not declared/);
  });

  it('a plugin importing a package fails with the "bundle it" explanation', async () => {
    const dir = inProcessPlugin(src, { id: 'needs-dep', code: `import x from 'some-package-that-is-not-there'; export function activate() {}` });
    await expect(mgr.install(dir)).rejects.toThrow(/Couldn't start/);
  });

  it(`${CIRCUIT_BREAKER_FAILURES} tool failures in a row disable the plugin`, async () => {
    const dir = inProcessPlugin(src, {
      id: 'flaky',
      tools: [{ name: 'fail', readOnly: true }],
      code: `export function activate(ctx) { ctx.tools.register({ name: 'fail', inputSchema: { type: 'object' }, execute: () => { throw new Error('nope'); } }); }`,
    });
    await mgr.install(dir);
    const tools = getPluginTools(new PermissionManager());
    for (let i = 0; i < CIRCUIT_BREAKER_FAILURES; i++) {
      expect(await call(tools, 'flaky__fail')).toMatch(/Error from plugin tool flaky__fail: nope/);
    }
    await waitFor(() => readState().plugins.flaky?.enabled === false);
    expect(readState().plugins.flaky.disabled).toMatchObject({ code: 'errors' });
    expect(listLiveTools()).toHaveLength(0);
  });

  it('a slow tool times out and the model gets an error, not a hang', async () => {
    const dir = inProcessPlugin(src, {
      id: 'slow',
      tools: [{ name: 'wait', readOnly: true, timeoutMs: 1000 }],
      code: `export function activate(ctx) { ctx.tools.register({ name: 'wait', inputSchema: { type: 'object' }, execute: () => new Promise(() => {}) }); }`,
    });
    await mgr.install(dir);
    const started = Date.now();
    expect(await call(getPluginTools(new PermissionManager()), 'slow__wait')).toMatch(/timed out after 1s/);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('tracked timers stop when the plugin is disabled, and errors inside them are contained', async () => {
    const dir = inProcessPlugin(src, {
      id: 'ticker',
      tools: [{ name: 'count', readOnly: true }],
      code: `let n = 0; export function activate(ctx) {
        ctx.timers.setInterval(() => { n++; if (n === 2) throw new Error('tick error'); }, 1000);
        ctx.tools.register({ name: 'count', inputSchema: { type: 'object' }, execute: () => String(n) });
      }`,
    });
    await mgr.install(dir);
    await sleep(2300);
    const before = Number(await call(getPluginTools(new PermissionManager()), 'ticker__count'));
    expect(before).toBeGreaterThanOrEqual(2);
    expect(readState().plugins.ticker.enabled).toBe(true);
    await mgr.disable('ticker');
    await sleep(1200);
    expect(listLiveTools()).toHaveLength(0);
  });

  it('ctx.fetch refuses hosts the manifest did not declare', async () => {
    const dir = inProcessPlugin(src, {
      id: 'fetcher',
      tools: [{ name: 'get', readOnly: true }],
      network: ['api.example.com'],
      code: `export function activate(ctx) { ctx.tools.register({ name: 'get', inputSchema: { type: 'object' }, execute: async (a) => { await ctx.fetch(a.url); return 'fetched'; } }); }`,
    });
    await mgr.install(dir);
    const out = await call(getPluginTools(new PermissionManager()), 'fetcher__get', { url: 'https://evil.example.net/x' });
    expect(out).toMatch(/evil\.example\.net is not declared/);
  });

  it('secrets: only declared names are readable', async () => {
    process.env.FIXTURE_TOKEN = 'declared-value';
    process.env.OTHER_SECRET = 'must-not-leak';
    const dir = inProcessPlugin(src, {
      id: 'secrets-in',
      tools: [{ name: 'peek', readOnly: true }],
      secrets: ['FIXTURE_TOKEN'],
      code: `export function activate(ctx) { ctx.tools.register({ name: 'peek', inputSchema: { type: 'object' }, execute: () => JSON.stringify({ a: ctx.secrets.get('FIXTURE_TOKEN') ?? null, b: ctx.secrets.get('OTHER_SECRET') ?? null }) }); }`,
    });
    await mgr.install(dir);
    expect(JSON.parse(String(await call(getPluginTools(new PermissionManager()), 'secrets-in__peek')))).toEqual({ a: 'declared-value', b: null });
    delete process.env.FIXTURE_TOKEN;
    delete process.env.OTHER_SECRET;
  });

  it('slash commands register under declared names and reply', async () => {
    const dir = inProcessPlugin(src, {
      id: 'greeter',
      tools: [],
      commands: [{ name: 'greet', description: 'Say hello' }],
      code: `export function activate(ctx) { ctx.commands.register({ name: 'greet', run: async (args, io) => { await io.reply('hello ' + args); } }); }`,
    });
    await mgr.install(dir);
    const replies: string[] = [];
    await getPluginCommand('greet')!.run('world', { reply: async (t) => { replies.push(t); }, signal: new AbortController().signal });
    expect(replies).toEqual(['hello world']);
    await mgr.disable('greeter');
    expect(getPluginCommand('greet')).toBeUndefined();
  });

  it('an uncaught error from plugin code is attributed and the plugin disabled', async () => {
    await mgr.install(inProcessPlugin(src, { id: 'crasher' }));
    const err = new Error('raw timer blew up');
    err.stack = `Error: raw timer blew up\n    at Timeout._onTimeout (${join(pluginDir('crasher'), 'versions', '1.0.0', 'index.mjs')}:3:11)`;
    expect(mgr.attributeFault(err)).toBe(true);
    await waitFor(() => readState().plugins.crasher?.enabled === false);
    expect(mgr.attributeFault(new Error('not from a plugin'))).toBe(false);
  });

  it('non-read-only tools ask for approval; "no" means not run', async () => {
    await mgr.install(inProcessPlugin(src, { id: 'writer', tools: [{ name: 'write_it', readOnly: false }] }));
    const pm = new PermissionManager();
    const prompts: string[] = [];
    pm.onAsk(async (p) => { prompts.push(p); return 'no'; });
    expect(await call(getPluginTools(pm), 'writer__write_it', { text: 'x' })).toMatch(/was not approved/);
    expect(prompts[0]).toMatch(/Run plugin tool Fixture writer → write_it with \{"text":"x"\}/);
    pm.onAsk(async () => 'always');
    expect(await call(getPluginTools(pm), 'writer__write_it', { text: 'y' })).toBe('write_it: y');
    pm.onAsk(async () => { throw new Error('should not ask again'); });
    expect(await call(getPluginTools(pm), 'writer__write_it', { text: 'z' })).toBe('write_it: z');
  });

  it('plan mode only sees read-only plugin tools', async () => {
    await mgr.install(inProcessPlugin(src, { id: 'mixed', tools: [{ name: 'look', readOnly: true }, { name: 'change', readOnly: false }] }));
    expect(Object.keys(getPluginTools(new PermissionManager(), { readOnlyOnly: true }))).toEqual(['mixed__look']);
  });
});

describe('boot, safe mode and the boot guard', () => {
  it('boot starts enabled plugins; shutdown records a clean exit', async () => {
    await mgr.install(inProcessPlugin(src));
    await mgr.shutdown();
    resetToolBridge();
    const m2 = new PluginManager({ safeMode: false });
    await m2.boot();
    expect(listLiveTools().map((t) => t.name)).toEqual(['echo']);
    expect(readState().boot.inProgress).toBe(true);
    await m2.shutdown();
    expect(readState().boot).toMatchObject({ inProgress: false, failedBoots: 0 });
  });

  it('safe mode loads nothing and refuses to enable', async () => {
    await mgr.install(inProcessPlugin(src));
    await mgr.shutdown();
    resetToolBridge();
    const safe = new PluginManager({ safeMode: true });
    await safe.boot();
    expect(listLiveTools()).toHaveLength(0);
    await expect(safe.enable('echo-tools')).rejects.toThrow(/safe mode/);
    expect((await safe.list()).safeMode).toBe(true);
  });

  it('two failed boots right after a plugin change disable that plugin', async () => {
    await mgr.install(inProcessPlugin(src));
    await mgr.shutdown();
    // Simulate two crashes during boot (no clean shutdown, never reached "healthy").
    await updateState((s) => { s.boot.inProgress = true; s.boot.failedBoots = 1; });
    resetToolBridge();
    const notes: string[] = [];
    const m2 = new PluginManager({ safeMode: false, notify: (m) => { notes.push(m); } });
    await m2.boot();
    expect(readState().plugins['echo-tools']).toMatchObject({ enabled: false, disabled: { code: 'boot-guard' } });
    expect(listLiveTools()).toHaveLength(0);
    expect(notes.join()).toMatch(/failed to start twice/);
    await m2.shutdown();
  });

  it('a broken installed copy is disabled at start, not loaded', async () => {
    await mgr.install(inProcessPlugin(src));
    await mgr.shutdown();
    const { rmSync } = await import('node:fs');
    rmSync(join(pluginDir('echo-tools'), 'versions', '1.0.0', 'index.mjs'));
    resetToolBridge();
    const m2 = new PluginManager({ safeMode: false });
    await m2.boot();
    // The entry file vanished after install: caught by the integrity check before loading.
    expect(readState().plugins['echo-tools'].disabled).toMatchObject({ code: 'integrity', message: expect.stringMatching(/Entry module "index.mjs" is missing/) });
    await m2.shutdown();
  });
});

describe('out-of-process plugins (MCP over stdio)', () => {
  it('handshake, tools/list (undeclared tools ignored), tools/call', async () => {
    await mgr.install(outOfProcessPlugin(src));
    const tools = getPluginTools(new PermissionManager());
    expect(Object.keys(tools).sort()).toEqual(['mcp-math__add', 'mcp-math__secret']);
    expect(await call(tools, 'mcp-math__add', { a: 2, b: 3 })).toBe('5');
  });

  it('gets only declared secrets in its environment', async () => {
    process.env.FIXTURE_TOKEN = 'tok';
    process.env.OTHER_SECRET = 'nope';
    await mgr.install(outOfProcessPlugin(src));
    expect(JSON.parse(String(await call(getPluginTools(new PermissionManager()), 'mcp-math__secret')))).toEqual({ declared: 'tok', leaked: null });
    delete process.env.FIXTURE_TOKEN;
    delete process.env.OTHER_SECRET;
  });

  it('a server that never completes the handshake is disabled with a clear reason', async () => {
    OUT_OF_PROCESS.initTimeoutMs = 500;
    await expect(mgr.install(outOfProcessPlugin(src, { id: 'silent', mode: 'no-handshake' }))).rejects.toThrow(/initialize timed out/);
    expect(readState().plugins.silent.disabled?.code).toBe('activation');
  });

  it('a server that exits at start reports its stderr', async () => {
    await expect(mgr.install(outOfProcessPlugin(src, { id: 'dies', mode: 'crash-at-start' }))).rejects.toThrow(/boom at start|exited/);
  });

  it('crashes restart with backoff; too many crashes disable it', async () => {
    OUT_OF_PROCESS.backoffStartMs = 50;
    OUT_OF_PROCESS.maxCrashes = 2;
    await mgr.install(outOfProcessPlugin(src, { id: 'crashy', mode: 'crash-on-call' }));
    for (let i = 0; i < 3; i++) {
      await waitFor(() => listLiveTools().some((t) => t.pluginId === 'crashy'), 5000);
      expect(await call(getPluginTools(new PermissionManager()), 'crashy__add', { a: 1, b: 1 })).toMatch(/Error from plugin tool/);
    }
    await waitFor(() => readState().plugins.crashy?.enabled === false && notices.length > 0, 8000);
    expect(readState().plugins.crashy.disabled?.code).toBe('crashed');
    expect(notices.join('\n')).toMatch(/crashy.*crashed/);
  }, 20_000);

  it('a hung call times out, and the server is recycled', async () => {
    OUT_OF_PROCESS.backoffStartMs = 50;
    await mgr.install(outOfProcessPlugin(src, { id: 'hangy', mode: 'hang-on-call', tools: [{ name: 'add', description: 'x', readOnly: true, timeoutMs: 1000 }] }));
    const out = await call(getPluginTools(new PermissionManager()), 'hangy__add', { a: 1, b: 2 });
    expect(out).toMatch(/timed out/);
    await waitFor(() => listLiveTools().some((t) => t.pluginId === 'hangy'), 5000);
  }, 15_000);

  it('disable stops the process and unpublishes its tools', async () => {
    await mgr.install(outOfProcessPlugin(src));
    await mgr.disable('mcp-math');
    expect(listLiveTools()).toHaveLength(0);
    const { items } = await mgr.list();
    expect(items.find((i) => i.id === 'mcp-math')).toMatchObject({ status: 'disabled', running: false });
  });
});
