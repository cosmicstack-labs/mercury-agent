/**
 * PluginManager: the one place that decides which plugins run.
 *
 * Every surface (/plugins in chat, Telegram buttons, the dashboard, the
 * `mercury plugins` CLI, the HTTP API) goes through this class, so they
 * always agree. Only the process that owns the runtime (the daemon, or a
 * standalone foreground runtime) runs plugins (ADR-024).
 *
 * Fault handling, in order of escalation:
 *  - a tool call fails      → error returned to the model, failure counted
 *  - 5 failures in a row    → plugin disabled ("errors"), owner notified
 *  - activation fails       → plugin disabled ("activation"), owner notified
 *  - server crashes 6× / 10m→ plugin disabled ("crashed"), owner notified
 *  - uncaught error whose stack is inside a plugin folder → that plugin
 *    disabled; the daemon keeps running instead of exiting
 *  - daemon fails to boot twice right after a plugin change → that plugin
 *    disabled ("boot-guard") on the next start
 *  - `mercury --safe-mode` or MERCURY_PLUGINS=off → no plugins load at all
 */
import { existsSync } from 'node:fs';
import { sep } from 'node:path';
import semver from 'semver';
import { logger } from '../utils/logger.js';
import { findCatalogEntry, getCatalog } from './catalog.js';
import {
  cleanStaging, installedManifest, installPackage, packageSize, parseSource, rollbackPackage, uninstallPackage, verifyPackage,
  type InstallResult,
} from './installer.js';
import {
  incompatibility, mercuryVersion, pluginDataDir, pluginDir, pluginVersionDir, readState, resolvedSettings, updateState, writeSettings, migrateSettings, secretValue, setPluginKey,
} from './store.js';
import { setToolOutcomeSink, unpublishPlugin, listLiveTools, listPluginCommands } from './tool-bridge.js';
import { InProcessRuntime, inProcessLogger } from './runtime/in-process.js';
import { OutOfProcessRuntime } from './runtime/out-of-process.js';
import { PluginChannel, type ChannelStatus } from './channel-bridge.js';
import { transcribeAudio } from './transcribe.js';
import { CallScheduler, registerCallScheduler } from './call-schedule.js';
import type { PluginRuntime } from './runtime/types.js';
import { providerSecretNames, whenMatches, type WhenCondition, type CatalogEntry, type DisabledCode, type PluginListItem, type PluginManifest, type PluginProviderId, type PluginsState } from './types.js';
import { loadConfig } from '../utils/config.js';

export const CIRCUIT_BREAKER_FAILURES = 5;
export const BOOT_HEALTHY_AFTER_MS = 60_000;
/** How long after start the missing-secret notice is sent (mutable for tests). */
export const SECRET_NOTICE_DELAY = { ms: 15_000 };
/** Channel-plugin settings read by Mercury on every message, so changing them needs no restart. */
const LIVE_CHANNEL_SETTINGS = new Set(['access', 'memberAccess', 'members', 'allowGroups']);
const BOOT_GUARD_WINDOW_MS = 24 * 60 * 60 * 1000;

interface Running {
  runtime: PluginRuntime;
  manifest: PluginManifest;
  version: string;
  startedAt: number;
  consecutiveFailures: number;
  lastError?: string;
  /** Plugin API 1.1: the chat channel this plugin provides. */
  channel?: PluginChannel;
}

export interface PluginManagerOptions {
  safeMode?: boolean;
  /**
   * Whether this process runs plugins. Only the process that owns the
   * runtime does (ADR-024); others change state on disk or forward to it.
   */
  runsPlugins?: boolean;
  /** How to tell the owner something happened (e.g. agent.notifyAllChannels). */
  notify?: (message: string) => void | Promise<void>;
}

export type ChangeListener = () => void;

export class PluginManager {
  private running = new Map<string, Running>();
  private lastErrors = new Map<string, string>();
  private starting = new Set<string>();
  private listeners = new Set<ChangeListener>();
  private readonly safeMode: boolean;
  private notifyFn: (message: string) => void | Promise<void>;
  private reconciling: Promise<void> | null = null;
  private reconcileAgain = false;
  private passSeq = 0;
  private healthyTimer: ReturnType<typeof setTimeout> | null = null;
  private booted = false;
  private runs: boolean;

  constructor(opts: PluginManagerOptions = {}) {
    this.safeMode = opts.safeMode ?? isSafeModeRequested();
    this.runs = opts.runsPlugins ?? true;
    this.notifyFn = opts.notify ?? (() => {});
    setToolOutcomeSink((pluginId, outcome) => {
      if (outcome.ok) this.recordSuccess(pluginId);
      else this.recordFailure(pluginId, outcome.timeout ? `timed out: ${outcome.error}` : outcome.error);
    });
  }

  setNotifier(fn: (message: string) => void | Promise<void>): void {
    this.notifyFn = fn;
  }

  isSafeMode(): boolean {
    return this.safeMode;
  }

  runsPlugins(): boolean {
    return this.runs;
  }

  /** Called once by the process that owns the runtime, before boot(). */
  setRunsPlugins(value: boolean): void {
    this.runs = value;
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const l of this.listeners) {
      try { l(); } catch { /* listeners never break us */ }
    }
  }

  private notify(message: string): void {
    try {
      void Promise.resolve(this.notifyFn(message)).catch(() => {});
    } catch { /* never throw from a notification */ }
  }

  // ── boot / shutdown ──────────────────────────────────────────────────

  /** Daemon start: crash guard, then start every enabled plugin. Never throws. */
  async boot(): Promise<void> {
    if (this.booted || !this.runs) return;
    this.booted = true;
    cleanStaging();
    if (this.safeMode) {
      logger.warn('Safe mode: plugins are not loaded');
      return;
    }
    try {
      let guarded: string | undefined;
      await updateState((s) => {
        s.boot.failedBoots = s.boot.inProgress ? s.boot.failedBoots + 1 : 0;
        const change = s.boot.lastChange;
        const recent = change && Date.now() - Date.parse(change.at) < BOOT_GUARD_WINDOW_MS;
        if (s.boot.failedBoots >= 2 && change && recent && s.plugins[change.id]?.enabled) {
          const entry = s.plugins[change.id];
          entry.enabled = false;
          entry.disabled = { code: 'boot-guard', message: 'Mercury failed to start twice right after this plugin was enabled or updated.', at: new Date().toISOString() };
          guarded = change.id;
          s.boot.failedBoots = 0;
          s.boot.lastChange = undefined;
        }
        s.boot.inProgress = true;
      });
      if (guarded) {
        logger.warn({ plugin: guarded }, 'Boot guard disabled a plugin');
        this.notify(`⚠️ Plugin "${guarded}" was disabled: Mercury failed to start twice right after it was enabled or updated. Re-enable it with /plugins enable ${guarded} once it's fixed.`);
      }
    } catch (err) {
      logger.warn({ err }, 'Plugin boot guard could not read state');
    }
    await this.reconcile();
    this.healthyTimer = setTimeout(() => {
      void updateState((s) => {
        s.boot.inProgress = false;
        s.boot.failedBoots = 0;
      }).catch(() => {});
    }, BOOT_HEALTHY_AFTER_MS);
    this.healthyTimer.unref?.();
  }

  /** Graceful shutdown: stop plugins and record a clean exit (not a crash). */
  async shutdown(): Promise<void> {
    if (this.healthyTimer) clearTimeout(this.healthyTimer);
    const ids = [...this.running.keys()];
    await Promise.all(ids.map((id) => this.stopRuntime(id)));
    if (this.booted && !this.safeMode) {
      await updateState((s) => {
        s.boot.inProgress = false;
        s.boot.failedBoots = 0;
      }).catch(() => {});
    }
  }

  // ── reconcile ────────────────────────────────────────────────────────

  /** Make the running set match state.json. Serialised; never throws. */
  async reconcile(): Promise<void> {
    if (this.safeMode || !this.runs) return;
    // A request that arrives mid-pass may be for a change that pass already
    // read past (e.g. an install): ask for one more pass instead of reusing it.
    this.reconcileAgain = true;
    if (this.reconciling) return this.reconciling;
    const passId = ++this.passSeq;
    const pass = (async () => {
      // Yield first: a pass with nothing to await must not finish before
      // `this.reconciling` is assigned, or the settled promise would stick
      // there and every later reconcile would silently do nothing.
      await Promise.resolve();
      try {
        while (this.reconcileAgain) {
          this.reconcileAgain = false;
          await this.reconcileOnce();
        }
      } finally {
        if (this.passSeq === passId) this.reconciling = null;
        this.changed();
      }
    })();
    this.reconciling = pass;
    return pass;
  }

  private async reconcileOnce(): Promise<void> {
    try {
      const state = readState();
      for (const [id, run] of [...this.running]) {
        const entry = state.plugins[id];
        if (!entry || !entry.enabled || entry.version !== run.version) await this.stopRuntime(id);
      }
      for (const [id, entry] of Object.entries(state.plugins)) {
        if (entry.enabled && !this.running.has(id)) await this.startRuntime(id, entry.version);
      }
    } catch (err) {
      logger.error({ err }, 'Plugin reconcile failed');
    }
  }

  private async startRuntime(id: string, version: string): Promise<void> {
    if (this.starting.has(id)) return;
    this.starting.add(id);
    try {
      const dir = pluginVersionDir(id, version);
      const manifest = installedManifest(id, version);
      if (!manifest || !existsSync(dir)) {
        await this.disableWith(id, 'activation', 'The installed files are missing or the manifest is broken. Reinstall the plugin.');
        return;
      }
      const why = incompatibility(manifest);
      if (why) {
        await this.disableWith(id, 'incompatible', why);
        return;
      }
      try {
        await verifyPackage(dir, manifest);
      } catch (err) {
        await this.disableWith(id, 'integrity', (err as Error).message);
        return;
      }
      try {
        const moved = migrateSettings(manifest);
        if (moved) logger.info({ plugin: id, ...moved }, 'Plugin settings migrated');
      } catch (err) {
        // Never fatal: the plugin starts with defaults for anything unreadable.
        logger.warn({ plugin: id, err }, 'Plugin settings migration failed');
      }
      // Plugin API 1.1: a channel plugin. One provider per channel type.
      let channel: PluginChannel | undefined;
      let runtimeRef: OutOfProcessRuntime | undefined;
      const channelType = manifest.contributes.channel?.type;
      if (channelType) {
        const other = [...this.running.entries()].find(([oid, r]) => oid !== id && r.manifest.contributes.channel?.type === channelType);
        if (other) {
          await this.disableWith(id, 'activation', `The ${channelType} channel is already provided by "${other[0]}". Disable that plugin first.`);
          return;
        }
        channel = new PluginChannel(
          manifest,
          {
            request: (method, params, timeoutMs) => runtimeRef ? runtimeRef.channelRequest(method, params, timeoutMs) : Promise.reject(new Error('not running')),
            notify: (method, params) => runtimeRef?.channelNotify(method, params),
          },
          () => resolvedSettings(manifest),
          (m) => { void this.notifyFn(m); },
          (key, value) => this.setSetting(id, key, value),
          // Voice notes: transcribed with the owner's OpenAI provider, when there is one.
          (() => {
            const openai = providerLookup('openai');
            return openai?.apiKey ? (path: string) => transcribeAudio(path, { apiKey: openai.apiKey!, baseUrl: openai.baseUrl }) : null;
          })(),
        );
      }
      const deps = {
        onNotification: channel ? (method: string, params: unknown) => channel!.handleNotification(method, params) : undefined,
        onRequest: channel ? (method: string, params: unknown) => channel!.handleRequest(method, params) : undefined,
        onReady: channel ? () => channel!.attach() : undefined,
        onDown: channel ? () => channel!.down() : undefined,
        mercuryVersion: mercuryVersion(),
        dataDir: pluginDataDir(id),
        settings: resolvedSettings(manifest),
        secrets: { ...Object.fromEntries(manifest.permissions.secrets.map((k) => [k, secretValue(k)])), ...providerCredentials(manifest) },
        log: inProcessLogger(id),
        onError: (message: string) => this.recordFailure(id, message),
        onFatal: (code: 'crashed' | 'activation', message: string) => {
          void this.disableWith(id, code, message);
        },
      };
      const runtime: PluginRuntime = manifest.kind === 'in-process'
        ? new InProcessRuntime(manifest, dir, deps)
        : (runtimeRef = new OutOfProcessRuntime(manifest, dir, deps));
      try {
        await runtime.start();
      } catch (err) {
        try { await runtime.stop(); } catch { /* already down */ }
        channel?.detach();
        await this.disableWith(id, 'activation', `Couldn't start: ${(err as Error).message}`);
        return;
      }
      this.running.set(id, { runtime, manifest, version, startedAt: Date.now(), consecutiveFailures: 0, channel });
      // A channel plugin that can call the owner gets scheduled calls ("call me at 9pm").
      if (channel && manifest.contributes.tools.some((t) => t.name === 'call_owner')) {
        const sched = new CallScheduler(id, (text) => channel!.send(text));
        registerCallScheduler(id, sched);
        sched.start();
      }
      this.lastErrors.delete(id);
      logger.info({ plugin: id, version, kind: manifest.kind }, 'Plugin started');
      this.noticeMissingSecrets(id, manifest);
    } finally {
      this.starting.delete(id);
    }
  }

  private async stopRuntime(id: string): Promise<void> {
    const run = this.running.get(id);
    this.running.delete(id);
    if (!run) {
      unpublishPlugin(id);
      return;
    }
    try {
      await run.runtime.stop();
    } catch (err) {
      logger.warn({ err, plugin: id }, 'Plugin did not stop cleanly');
    } finally {
      unpublishPlugin(id);
      run.channel?.detach();
      registerCallScheduler(id, null);
    }
  }

  /**
   * Tell the owner, once per plugin version, about optional secrets that
   * aren't set (e.g. "Voice calls need OPENAI_API_KEY"). Delayed a little
   * so it lands after channels have connected at startup.
   */
  private noticeMissingSecrets(id: string, manifest: PluginManifest): void {
    const missing = missingRequirements(manifest);
    if (!missing.length) return;
    const entry = readState().plugins[id];
    const fresh = missing.filter((m) => entry?.secretNotices?.[m.key] !== manifest.version);
    if (!fresh.length) return;
    const timer = setTimeout(() => {
      if (!this.running.has(id)) return;
      void this.notifyFn([
        `🧩 ${manifest.name} is running, but some features are off:`,
        ...fresh.map((m) => `• ${m.unlocks} needs ${m.needs}. ${m.fix}`),
      ].join('\n'));
      void updateState((s) => {
        const e = s.plugins[id];
        if (!e) return;
        e.secretNotices = { ...(e.secretNotices ?? {}) };
        for (const m of fresh) e.secretNotices[m.key] = manifest.version;
      }).catch(() => {});
    }, SECRET_NOTICE_DELAY.ms);
    timer.unref?.();
  }

  // ── health ───────────────────────────────────────────────────────────

  private recordSuccess(id: string): void {
    const run = this.running.get(id);
    if (run) run.consecutiveFailures = 0;
  }

  recordFailure(id: string, message: string): void {
    this.lastErrors.set(id, message);
    const run = this.running.get(id);
    if (!run) return;
    run.consecutiveFailures += 1;
    run.lastError = message;
    if (run.consecutiveFailures >= CIRCUIT_BREAKER_FAILURES) {
      void this.disableWith(id, 'errors', `${CIRCUIT_BREAKER_FAILURES} failures in a row. Last: ${message}`);
    }
  }

  private async disableWith(id: string, code: DisabledCode, message: string): Promise<void> {
    this.lastErrors.set(id, message);
    await this.stopRuntime(id);
    await updateState((s) => {
      const entry = s.plugins[id];
      if (!entry) return;
      entry.enabled = false;
      entry.disabled = { code, message: message.slice(0, 500), at: new Date().toISOString() };
    }).catch((err) => logger.error({ err, plugin: id }, 'Could not record plugin disable'));
    logger.warn({ plugin: id, code, message }, 'Plugin disabled');
    if (code !== 'user') this.notify(`⚠️ Plugin "${id}" was disabled: ${message}`);
    this.changed();
  }

  /**
   * Called from the process-level uncaughtException / unhandledRejection
   * handlers. If the error came from a plugin's files, disable that plugin
   * and report true so the daemon keeps running.
   */
  attributeFault(err: unknown): boolean {
    const stack = err instanceof Error ? `${err.stack ?? ''}` : '';
    if (!stack) return false;
    for (const id of this.running.keys()) {
      const dir = pluginDir(id) + sep;
      const asUrl = dir.split(sep).join('/');
      if (stack.includes(dir) || stack.includes(asUrl)) {
        logger.error({ plugin: id, err }, 'Uncaught error from a plugin');
        void this.disableWith(id, 'errors', `Uncaught error: ${(err as Error).message}`);
        return true;
      }
    }
    return false;
  }

  // ── owner actions ────────────────────────────────────────────────────

  /** Install from a catalog id, folder, .tgz, https URL or github:owner/repo. Enables it unless told not to. */
  async install(input: string, opts: { enable?: boolean; force?: boolean; onProgress?: (m: string) => void } = {}): Promise<InstallResult & { tier: 'official' | 'community' | 'local' }> {
    const parsed = parseSource(input);
    let result: InstallResult;
    let tier: 'official' | 'community' | 'local' = 'local';
    if ('kind' in parsed) {
      const entry = await findCatalogEntry(parsed.id, { force: true });
      if (!entry) {
        const folder = existsSync(parsed.id) ? ` There is a folder called "${parsed.id}" here: to install it, use ./${parsed.id}` : ' Try /plugins to see what\'s available.';
        throw new Error(`No plugin called "${parsed.id}" in the catalog.${folder}`);
      }
      const why = incompatibility({ engines: entry.engines, platforms: entry.artifacts ? Object.keys(entry.artifacts) as PluginManifest['platforms'] : undefined });
      if (why) throw new Error(`${entry.name} can't be installed here: ${why}.`);
      result = await installPackage({ type: 'catalog', entry }, { force: opts.force, onProgress: opts.onProgress });
      tier = entry.tier;
    } else {
      result = await installPackage(parsed, { force: opts.force, onProgress: opts.onProgress });
    }
    if (opts.enable !== false) {
      await this.enable(result.id);
    } else {
      await this.reconcile();
    }
    return { ...result, tier };
  }

  async enable(id: string): Promise<void> {
    if (this.safeMode) throw new Error('Mercury is in safe mode: plugins are off for this run. Restart without --safe-mode to use them.');
    await updateState((s) => {
      const entry = s.plugins[id];
      if (!entry) throw new Error(`Plugin "${id}" is not installed.`);
      entry.enabled = true;
      entry.disabled = undefined;
      s.boot.lastChange = { id, at: new Date().toISOString() };
    });
    this.lastErrors.delete(id);
    await this.reconcile();
    const after = readState().plugins[id];
    if (after && !after.enabled && after.disabled) throw new Error(after.disabled.message);
  }

  async disable(id: string): Promise<void> {
    await updateState((s) => {
      const entry = s.plugins[id];
      if (!entry) throw new Error(`Plugin "${id}" is not installed.`);
      entry.enabled = false;
      entry.disabled = { code: 'user', message: 'Disabled by the owner.', at: new Date().toISOString() };
    });
    await this.reconcile();
  }

  async uninstall(id: string, opts: { purge?: boolean } = {}): Promise<void> {
    await this.stopRuntime(id);
    await uninstallPackage(id, opts.purge === true);
    this.lastErrors.delete(id);
    await this.reconcile();
  }

  /** Update one plugin, or every catalog plugin with a newer version. Returns what changed. */
  async update(id?: string, opts: { onProgress?: (m: string) => void } = {}): Promise<Array<{ id: string; from: string; to: string }>> {
    const state = readState();
    const { entries } = await getCatalog({ force: true });
    const targets = id ? [id] : Object.keys(state.plugins);
    const done: Array<{ id: string; from: string; to: string }> = [];
    for (const pid of targets) {
      const entry = state.plugins[pid];
      if (!entry) {
        if (id) throw new Error(`Plugin "${pid}" is not installed.`);
        continue;
      }
      if (entry.source.type !== 'catalog') {
        if (id) throw new Error(`"${pid}" was installed from ${entry.source.type === 'path' ? 'a local path' : entry.source.ref}; reinstall it from there to update.`);
        continue;
      }
      const latest = entries.find((e) => e.id === pid);
      if (!latest || !isNewer(latest.version, entry.version)) continue;
      const r = await installPackage({ type: 'catalog', entry: latest }, { onProgress: opts.onProgress });
      done.push({ id: pid, from: entry.version, to: r.version });
    }
    await this.reconcile();
    return done;
  }

  async rollback(id: string): Promise<{ from: string; to: string }> {
    const r = await rollbackPackage(id);
    await this.reconcile();
    return r;
  }

  async setSetting(id: string, key: string, value: unknown): Promise<void> {
    const entry = readState().plugins[id];
    if (!entry) throw new Error(`Plugin "${id}" is not installed.`);
    const manifest = installedManifest(id, entry.version);
    const field = manifest?.settings?.fields?.[key];
    if (!manifest || !field) throw new Error(`"${id}" has no setting called "${key}".`);
    if (field.type === 'secret') {
      // Keys go to Mercury's key store, never the plugin's settings file; the
      // plugin gets them at start, so restart it if it's running.
      const v = typeof value === 'string' ? value.trim() : '';
      if (v && v.length < 8) throw new Error('That doesn\'t look like an API key.');
      setPluginKey(field.secret!, v || null);
      if (this.running.has(id)) {
        await this.stopRuntime(id);
        await this.reconcile();
      }
      return;
    }
    const coerced = coerceSetting(field.type, field.options, value, field.format);
    const values = { ...resolvedSettings(manifest), [key]: coerced };
    writeSettings(id, values, manifest.settings?.version ?? 1);
    // Settings are read at start: restart a running plugin so it sees them.
    // Channel settings Mercury itself reads (who may talk, at what level) apply
    // live: restarting would drop the plugin's connection for nothing.
    if (this.running.has(id) && !(manifest.contributes.channel && LIVE_CHANNEL_SETTINGS.has(key))) {
      await this.stopRuntime(id);
      await this.reconcile();
    }
  }

  // ── channels (plugin API 1.1) ────────────────────────────────────────

  private liveChannel(id: string): PluginChannel {
    const run = this.running.get(id);
    if (!run) {
      if (!readState().plugins[id]) throw new Error(`Plugin "${id}" is not installed.`);
      throw new Error(this.runs ? `"${id}" is not running. Enable it first: /plugins enable ${id}` : 'Mercury is not running. Start it (mercury start), then pair.');
    }
    if (!run.channel) throw new Error(`"${id}" doesn't provide a chat channel.`);
    return run.channel;
  }

  channelStatus(id: string): ChannelStatus | null {
    return this.running.get(id)?.channel?.getStatus() ?? null;
  }

  /**
   * Start linking: QR (scan in the app) or a pairing code for a phone
   * number (type it in the app). Resolves with the first status that has
   * something to show, or the current one after 25 seconds.
   */
  async pair(id: string, opts: { method: 'qr' | 'code'; phone?: string }): Promise<ChannelStatus> {
    const channel = this.liveChannel(id);
    if (opts.method === 'code' && !opts.phone) throw new Error('A pairing code needs the phone number of the WhatsApp account being linked (the spare number).');
    if (channel.getStatus().state === 'connected') return channel.getStatus();
    const ready = new Promise<ChannelStatus>((resolve) => {
      const timer = setTimeout(() => { off(); resolve(channel.getStatus()); }, 25_000);
      const off = channel.onStatus((st) => {
        if (st.qr || st.pairCode || st.state === 'connected' || st.state === 'error') {
          clearTimeout(timer);
          off();
          resolve(st);
        }
      });
    });
    await channel.pair(opts.method, opts.phone);
    return ready;
  }

  /** Send the owner a test message through a channel plugin. */
  async testChannel(id: string): Promise<string> {
    const channel = this.liveChannel(id);
    const st = channel.getStatus();
    if (st.state !== 'connected') throw new Error(`"${id}" isn't linked yet (${st.state}). Pair it first: mercury plugins pair ${id}`);
    await channel.send(`☿ Hi, it's Mercury. This is a test message from ${channel.type === 'whatsapp' ? 'WhatsApp' : channel.type}: reply to chat with me${channel.type === 'whatsapp' ? ', or call this number to talk' : ''}.`);
    return `Sent a test message to the owner${st.account ? ` from +${st.account}` : ''}.`;
  }

  async unlinkChannel(id: string): Promise<void> {
    await this.liveChannel(id).unlink();
  }

  // ── views ────────────────────────────────────────────────────────────

  /** Catalog + installed plugins, merged into one list for every surface. */
  async list(opts: { refresh?: boolean } = {}): Promise<{ items: PluginListItem[]; catalogError?: string; stale: boolean; safeMode: boolean }> {
    const state = readState();
    const catalog = await getCatalog({ force: opts.refresh });
    const byId = new Map<string, CatalogEntry>(catalog.entries.map((e) => [e.id, e]));
    const items: PluginListItem[] = [];
    const ids = new Set([...Object.keys(state.plugins), ...byId.keys()]);
    for (const id of ids) items.push(this.describe(id, state, byId.get(id)));
    items.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    return { items, catalogError: catalog.error, stale: catalog.stale, safeMode: this.safeMode };
  }

  async info(id: string): Promise<PluginListItem | null> {
    const state = readState();
    const entry = (await getCatalog()).entries.find((e) => e.id === id);
    if (!state.plugins[id] && !entry) return null;
    const item = this.describe(id, state, entry);
    const inst = state.plugins[id];
    const manifest = inst ? installedManifest(id, inst.version) : null;
    const fields = manifest?.settings?.fields ?? {};
    if (manifest && Object.keys(fields).length) {
      const values = resolvedSettings(manifest);
      item.settings = Object.entries(fields).map(([key, f]) => ({
        key, type: f.type, description: f.description, options: f.options,
        value: f.type === 'secret' ? undefined : values[key],
        isSet: f.type === 'secret' ? !!secretValue(f.secret!) : undefined,
        label: f.label, setup: f.setup, required: f.required, optionLabels: f.optionLabels, examples: f.examples, format: f.format, when: f.when,
        group: f.group, setupWhenMissing: f.setupWhenMissing,
      }));
      const missingKeys = new Set((item.missing ?? []).map((m) => m.key));
      // A section is ready when none of its requirements are missing and every
      // required setting that applies (e.g. the key for the chosen engine) is filled in.
      const filled = (k: string) => {
        const f = fields[k];
        return f.type === 'secret' ? !!secretValue(f.secret!) : values[k] !== undefined && values[k] !== '';
      };
      item.settingGroups = Object.entries(manifest.settings?.groups ?? {}).map(([gid, g]) => ({
        id: gid, label: g.label, description: g.description,
        ready: !(g.readyUnless ?? []).some((k) => missingKeys.has(k))
          && Object.entries(fields).every(([k, f]) => f.group !== gid || !f.required || !whenMatches(f.when, values) || filled(k)),
      }));
    }
    return item;
  }

  private describe(id: string, state: PluginsState, cat?: CatalogEntry): PluginListItem {
    const inst = state.plugins[id];
    const manifest = inst ? installedManifest(id, inst.version) : null;
    const run = this.running.get(id);
    const catIncompat = cat ? incompatibility({ engines: cat.engines, platforms: cat.artifacts ? Object.keys(cat.artifacts) as PluginManifest['platforms'] : undefined }) : null;
    const instIncompat = manifest ? incompatibility(manifest) : null;
    let status: PluginListItem['status'];
    if (!inst) status = catIncompat ? 'incompatible' : 'available';
    else if (!manifest) status = 'error';
    else if (cat && inst.source.type === 'catalog' && isNewer(cat.version, inst.version)) status = 'update-available';
    else if (inst.enabled && run) status = 'enabled';
    // Not running here: in safe mode it's off; in a process that doesn't run
    // plugins (CLI, attached terminal) it's enabled and runs in the daemon.
    else if (inst.enabled && !run) status = !this.runs ? 'enabled' : this.safeMode ? 'disabled' : 'error';
    else if (instIncompat) status = 'incompatible';
    else status = 'disabled';
    return {
      id,
      name: manifest?.name ?? cat?.name ?? id,
      description: manifest?.description ?? cat?.description ?? '',
      kind: manifest?.kind ?? cat?.kind ?? 'in-process',
      tier: inst && inst.source.type !== 'catalog' ? 'local' : cat?.tier ?? 'local',
      status,
      installedVersion: inst?.version,
      latestVersion: cat?.version,
      sizeBytes: inst ? packageSize(id, inst.version) : (cat?.artifacts ? Object.values(cat.artifacts)[0]?.size : cat?.artifact?.size),
      enabled: inst?.enabled ?? false,
      running: !!run && run.runtime.isRunning(),
      verified: inst?.verified ?? false,
      tools: manifest ? manifest.contributes.tools.map((t) => `${id}__${t.name}`) : (cat?.tools ?? []),
      commands: manifest ? manifest.contributes.commands.map((c) => `/${c.name}`) : [],
      channel: manifest?.contributes.channel
        ? (() => {
          const st = run?.channel?.getStatus();
          return { type: manifest.contributes.channel!.type, state: st?.state, detail: st?.detail, account: st?.account };
        })()
        : undefined,
      permissions: manifest?.permissions ?? (cat ? { network: cat.permissions.network, secrets: cat.permissions.secrets } : undefined),
      disabled: inst?.disabled,
      missing: manifest ? missingRequirements(manifest) : undefined,
      lastError: run?.lastError ?? this.lastErrors.get(id),
      incompatibleReason: instIncompat ?? catIncompat ?? undefined,
    };
  }

  /** Short health summary for /api/health and `mercury doctor`. */
  health(): { safeMode: boolean; running: number; tools: number; commands: number; plugins: Array<{ id: string; version: string; kind: string; failures: number; lastError?: string }> } {
    return {
      safeMode: this.safeMode,
      running: this.running.size,
      tools: listLiveTools().length,
      commands: listPluginCommands().length,
      plugins: [...this.running.entries()].map(([id, r]) => ({ id, version: r.version, kind: r.runtime.kind, failures: r.consecutiveFailures, lastError: r.lastError })),
    };
  }
}

function rank(i: PluginListItem): number {
  return { enabled: 0, 'update-available': 1, error: 2, disabled: 3, installed: 4, available: 5, incompatible: 6 }[i.status];
}

function isNewer(candidate: string, current: string): boolean {
  return semver.valid(candidate) !== null && semver.valid(current) !== null && semver.gt(candidate, current);
}

function coerceSetting(type: string, options: string[] | undefined, value: unknown, format: 'text' | 'phone' = 'text'): unknown {
  if (type === 'string' && format === 'phone') {
    if (value === '' || value === null || value === undefined) return '';
    const digits = String(value).replace(/[^\d]/g, '');
    if (digits.length < 7 || digits.length > 15) throw new Error('Expected a phone number with country code, like +15551234567.');
    return `+${digits}`;
  }
  if (type === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === 'on' || value === 'yes') return true;
    if (value === 'false' || value === 'off' || value === 'no') return false;
    throw new Error('Expected true or false.');
  }
  if (type === 'number') {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) throw new Error('Expected a number.');
    return n;
  }
  if (type === 'enum') {
    if (typeof value !== 'string' || !options?.includes(value)) throw new Error(`Expected one of: ${(options ?? []).join(', ')}.`);
    return value;
  }
  if (typeof value !== 'string') throw new Error('Expected text.');
  return value;
}

export function isSafeModeRequested(): boolean {
  return process.argv.includes('--safe-mode') || /^(off|0|false|no)$/i.test(process.env.MERCURY_PLUGINS ?? '');
}

// ── process-wide instance ──────────────────────────────────────────────

let instance: PluginManager | null = null;

/** The process-wide manager. It runs nothing until the runtime owner calls setRunsPlugins(true). */
export function getPluginManager(): PluginManager {
  if (!instance) instance = new PluginManager({ runsPlugins: false });
  return instance;
}

/** The manager only if one exists (crash handlers must not create one). */
export function peekPluginManager(): PluginManager | null {
  return instance;
}

/** Test hook. */
export function resetPluginManager(): void {
  instance = null;
}

const PROVIDER_LABEL: Record<PluginProviderId, string> = { openai: 'OpenAI', grok: 'xAI Grok' };

type ProviderLookup = (id: PluginProviderId) => { apiKey?: string; baseUrl?: string } | undefined;

let providerLookup: ProviderLookup = (id) => {
  try {
    return (loadConfig().providers as unknown as Record<string, { apiKey?: string; baseUrl?: string }>)[id];
  } catch {
    return undefined;
  }
};

/**
 * Where provider credentials come from. The runtime points this at its live
 * config, the same one its own model calls use; tests point it at a fake.
 */
export function setProviderLookup(fn: ProviderLookup): void {
  providerLookup = fn;
}

/** Credentials for the Mercury providers a plugin declared, from Mercury's own provider settings. */
export function providerCredentials(manifest: PluginManifest): Record<string, string> {
  const out: Record<string, string> = {};
  const declared = Object.keys(manifest.permissions.providers ?? {}) as PluginProviderId[];
  for (const id of declared) {
    const p = providerLookup(id);
    if (!p?.apiKey) continue;
    const names = providerSecretNames(id);
    out[names.apiKey] = p.apiKey;
    if (p.baseUrl) out[names.baseUrl] = p.baseUrl;
  }
  return out;
}

/** Optional providers and secrets this plugin declares that aren't set up. */
export function missingRequirements(manifest: PluginManifest): Array<{ key: string; unlocks: string; needs: string; fix: string }> {
  const creds = providerCredentials(manifest);
  const out: Array<{ key: string; unlocks: string; needs: string; fix: string }> = [];
  const values = resolvedSettings(manifest);
  for (const [id, spec] of Object.entries(manifest.permissions.providers ?? {}) as Array<[PluginProviderId, string | { unlocks: string; when?: WhenCondition | WhenCondition[]; alternative?: string }]>) {
    const unlocks = typeof spec === 'string' ? spec : spec.unlocks;
    if (typeof spec !== 'string' && !whenMatches(spec.when, values)) continue;
    if (creds[providerSecretNames(id).apiKey]) continue;
    const alt = typeof spec !== 'string' && spec.alternative ? ` ${spec.alternative}` : '';
    out.push({
      key: `provider:${id}`,
      unlocks,
      needs: `an ${PROVIDER_LABEL[id]} provider`,
      fix: `Add your ${PROVIDER_LABEL[id]} key once in the dashboard (Providers) or with \`mercury doctor\`; Mercury uses it for everything.${alt}`,
    });
  }
  for (const [name, unlocks] of Object.entries(manifest.permissions.optionalSecrets ?? {})) {
    if (process.env[name]) continue;
    out.push({ key: `secret:${name}`, unlocks, needs: name, fix: `Add ${name} to ~/.mercury/.env and restart Mercury.` });
  }
  return out;
}
