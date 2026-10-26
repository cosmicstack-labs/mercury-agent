/**
 * In-process plugin runtime: loads the plugin's bundled ES module into the
 * daemon and hands it a PluginContext.
 *
 * Containment, since the code shares our process:
 * - loading, activate() and deactivate() each have a timeout;
 * - tools/commands can only be registered under names the manifest
 *   declared, so the install prompt always tells the truth;
 * - timers go through ctx.timers, which catches their errors and clears
 *   them on stop; fetches go through ctx.fetch (declared hosts, SSRF guard,
 *   aborted on stop);
 * - stop() tears down everything registered, however activate() ended.
 * What try/catch cannot contain (a busy loop, process.exit) is why
 * untrusted code belongs in an out-of-process plugin.
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { assertFetchableTarget, MAX_REDIRECTS } from '../../utils/ssrf.js';
import { logger } from '../../utils/logger.js';
import { PLUGIN_API_VERSION, providerSecretNames, type PluginManifest, type PluginProviderId } from '../types.js';
import type { Disposable, PluginCommandDefinition, PluginContext, PluginModule, PluginToolDefinition } from '../sdk.js';
import { publishCommand, publishTool, unpublishPlugin } from '../tool-bridge.js';
import type { PluginRuntime, RuntimeDeps } from './types.js';

export const IN_PROCESS_TIMEOUTS = { load: 10_000, activate: 15_000, deactivate: 5_000, dispose: 3_000 };

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.finally(() => timer && clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
    }),
  ]);
}

/** Host may match exactly, or a "*.example.com" entry matches subdomains (not the apex). */
export function hostAllowed(host: string, allowed: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return allowed.some((rule) => {
    const r = rule.toLowerCase();
    if (r.startsWith('*.')) return h.endsWith(r.slice(1)) && h.length > r.length - 1;
    return h === r;
  });
}

let loadCounter = 0;

export class InProcessRuntime implements PluginRuntime {
  readonly kind = 'in-process' as const;
  private ac = new AbortController();
  private disposables: Array<() => void | Promise<void>> = [];
  private module: PluginModule | null = null;
  private running = false;
  private registered = new Set<string>();

  constructor(private readonly manifest: PluginManifest, private readonly dir: string, private readonly deps: RuntimeDeps) {}

  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    this.ac = new AbortController();
    const entry = resolve(this.dir, this.manifest.entry!);
    const href = pathToFileURL(entry).href;
    loadCounter += 1;
    let mod: unknown;
    try {
      // A query string gives a fresh module instance after disable → enable.
      mod = await withTimeout(import(`${href}?instance=${loadCounter}`), IN_PROCESS_TIMEOUTS.load, 'Loading the plugin');
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (!/Cannot find (module|package)|ERR_MODULE_NOT_FOUND|not found/i.test(msg) || /Cannot find package/i.test(msg)) throw this.explainLoadError(err);
      mod = await withTimeout(import(href), IN_PROCESS_TIMEOUTS.load, 'Loading the plugin').catch((e) => { throw this.explainLoadError(e); });
    }
    const m = mod as Partial<PluginModule> & { default?: Partial<PluginModule> };
    const plugin = (typeof m.activate === 'function' ? m : m.default) as PluginModule | undefined;
    if (!plugin || typeof plugin.activate !== 'function') throw new Error('The plugin module does not export an activate(ctx) function.');
    this.module = plugin;
    this.running = true;
    try {
      await withTimeout(Promise.resolve().then(() => plugin.activate(this.context())), IN_PROCESS_TIMEOUTS.activate, 'activate()');
    } catch (err) {
      await this.stop();
      throw err;
    }
    const declared = this.manifest.contributes.tools.map((t) => t.name);
    const missing = declared.filter((n) => !this.registered.has(`tool:${n}`));
    if (missing.length > 0) this.deps.log.warn(`declared tools not registered by activate(): ${missing.join(', ')}`);
  }

  private explainLoadError(err: unknown): Error {
    const msg = (err as Error)?.message ?? String(err);
    if (/Cannot find package/i.test(msg)) {
      return new Error(`${msg.split('\n')[0]}. In-process plugins must be bundled into a single file; Mercury can't resolve packages for them.`);
    }
    return err instanceof Error ? err : new Error(msg);
  }

  async stop(): Promise<void> {
    const wasRunning = this.running;
    this.running = false;
    this.ac.abort(new Error('plugin stopped'));
    if (wasRunning && this.module?.deactivate) {
      try {
        await withTimeout(Promise.resolve().then(() => this.module!.deactivate!()), IN_PROCESS_TIMEOUTS.deactivate, 'deactivate()');
      } catch (err) {
        this.deps.log.warn(`deactivate() failed: ${(err as Error).message}`);
      }
    }
    const pending = this.disposables.splice(0).reverse();
    for (const d of pending) {
      try {
        await withTimeout(Promise.resolve().then(d), IN_PROCESS_TIMEOUTS.dispose, 'cleanup');
      } catch (err) {
        this.deps.log.warn(`cleanup failed: ${(err as Error).message}`);
      }
    }
    unpublishPlugin(this.manifest.id);
    this.registered.clear();
    this.module = null;
  }

  private track(fn: () => void | Promise<void>): Disposable {
    let done = false;
    const d = () => {
      if (done) return;
      done = true;
      return fn();
    };
    this.disposables.push(d);
    return { dispose: () => void d() };
  }

  /** Run plugin code from a timer or callback; failures count against the plugin instead of crashing us. */
  private guard(fn: () => void | Promise<void>, where: string): void {
    if (!this.running) return;
    Promise.resolve()
      .then(fn)
      .catch((err) => this.deps.onError(`${where}: ${(err as Error)?.message ?? String(err)}`));
  }

  private context(): PluginContext {
    const m = this.manifest;
    const declaredTools = new Map(m.contributes.tools.map((t) => [t.name, t]));
    const declaredCommands = new Map(m.contributes.commands.map((c) => [c.name, c]));
    const declaredSecrets = new Set([
      ...m.permissions.secrets,
      ...(Object.keys(m.permissions.providers ?? {}) as PluginProviderId[]).flatMap((p) => Object.values(providerSecretNames(p))),
    ]);
    const signal = this.ac.signal;

    const register = (def: PluginToolDefinition): Disposable => {
      if (!this.running) throw new Error('Plugin is not running.');
      const decl = declaredTools.get(def?.name);
      if (!decl) throw new Error(`Tool "${def?.name}" is not declared in mercury-plugin.json (contributes.tools).`);
      if (typeof def.execute !== 'function') throw new Error(`Tool "${def.name}" has no execute function.`);
      const schema = def.inputSchema ?? { type: 'object', properties: {} };
      if (typeof schema !== 'object' || (schema as { type?: unknown }).type !== 'object') {
        throw new Error(`Tool "${def.name}" needs an inputSchema with type "object".`);
      }
      const unpublish = publishTool({
        pluginId: m.id,
        pluginName: m.name,
        name: decl.name,
        description: decl.description,
        inputSchema: schema,
        readOnly: decl.readOnly,
        timeoutMs: decl.timeoutMs,
        invoke: async (args, toolSignal) => {
          if (!this.running) throw new Error('the plugin is not running');
          const combined = AbortSignal.any([toolSignal, signal]);
          return def.execute(args, { signal: combined });
        },
      });
      this.registered.add(`tool:${decl.name}`);
      return this.track(() => {
        unpublish();
        this.registered.delete(`tool:${decl.name}`);
      });
    };

    const registerCommand = (def: PluginCommandDefinition): Disposable => {
      if (!this.running) throw new Error('Plugin is not running.');
      const decl = declaredCommands.get(def?.name);
      if (!decl) throw new Error(`Command "${def?.name}" is not declared in mercury-plugin.json (contributes.commands).`);
      if (typeof def.run !== 'function') throw new Error(`Command "${def.name}" has no run function.`);
      const unpublish = publishCommand({
        pluginId: m.id,
        pluginName: m.name,
        name: decl.name,
        description: decl.description,
        run: async (args, io) => {
          if (!this.running) throw new Error('the plugin is not running');
          await def.run(args, { reply: io.reply, signal: AbortSignal.any([io.signal, signal]) });
        },
      });
      this.registered.add(`command:${decl.name}`);
      return this.track(() => {
        unpublish();
        this.registered.delete(`command:${decl.name}`);
      });
    };

    const pluginFetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
      if (!this.running) throw new Error('Plugin is not running.');
      let target = url;
      const reqSignal = init.signal ? AbortSignal.any([init.signal, signal]) : signal;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const parsed = new URL(target);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error(`Only http(s) requests are allowed (got ${parsed.protocol}).`);
        if (!hostAllowed(parsed.hostname, m.permissions.network)) {
          throw new Error(`Network access to ${parsed.hostname} is not declared in this plugin's permissions.network.`);
        }
        await assertFetchableTarget(parsed.href);
        const res = await fetch(parsed.href, { ...init, signal: reqSignal, redirect: 'manual' });
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
          try { void res.body?.cancel(); } catch { /* ignore */ }
          target = new URL(res.headers.get('location')!, parsed).href;
          continue;
        }
        return res;
      }
      throw new Error(`Too many redirects (more than ${MAX_REDIRECTS}).`);
    };

    const scoped = this.deps.log;
    return Object.freeze({
      apiVersion: PLUGIN_API_VERSION,
      mercuryVersion: this.deps.mercuryVersion,
      plugin: Object.freeze({ id: m.id, version: m.version, dataDir: this.deps.dataDir }),
      log: Object.freeze({
        debug: (msg: string, data?: Record<string, unknown>) => scoped.debug(msg, data),
        info: (msg: string, data?: Record<string, unknown>) => scoped.info(msg, data),
        warn: (msg: string, data?: Record<string, unknown>) => scoped.warn(msg, data),
        error: (msg: string, data?: Record<string, unknown>) => scoped.error(msg, data),
      }),
      settings: Object.freeze({
        get: <T,>(key: string) => this.deps.settings[key] as T | undefined,
        all: () => ({ ...this.deps.settings }),
      }),
      secrets: Object.freeze({
        get: (name: string) => (declaredSecrets.has(name) ? this.deps.secrets[name] : undefined),
      }),
      tools: Object.freeze({ register }),
      commands: Object.freeze({ register: registerCommand }),
      timers: Object.freeze({
        setTimeout: (fn: () => void | Promise<void>, ms: number): Disposable => {
          const h = setTimeout(() => this.guard(fn, 'timer'), Math.max(0, ms));
          return this.track(() => clearTimeout(h));
        },
        setInterval: (fn: () => void | Promise<void>, ms: number): Disposable => {
          const h = setInterval(() => this.guard(fn, 'interval'), Math.max(1000, ms));
          return this.track(() => clearInterval(h));
        },
      }),
      fetch: pluginFetch,
      signal,
      onDispose: (fn: () => void | Promise<void>) => {
        this.track(fn);
      },
    }) as PluginContext;
  }
}

export function inProcessLogger(pluginId: string): RuntimeDeps['log'] {
  const child = logger.child({ plugin: pluginId });
  return {
    debug: (msg, data) => child.debug(data ?? {}, msg),
    info: (msg, data) => child.info(data ?? {}, msg),
    warn: (msg, data) => child.warn(data ?? {}, msg),
    error: (msg, data) => child.error(data ?? {}, msg),
  };
}
