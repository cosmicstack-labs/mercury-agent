/**
 * Out-of-process plugin runtime: the plugin is a child process speaking MCP
 * (JSON-RPC 2.0, newline-delimited) over stdio. Mercury implements the
 * client side of the subset tools need: initialize, notifications/initialized,
 * tools/list, tools/call, ping, and notifications/tools/list_changed.
 *
 * Because it's a separate process, nothing it does can block or crash the
 * daemon. Supervision:
 * - every request has a timeout; a hung server is killed and restarted;
 * - crashes restart with exponential backoff (1s → 60s);
 * - more than 5 crashes in 10 minutes stops it and disables the plugin;
 * - the child gets a minimal environment: PATH/HOME-style basics, the
 *   plugin's own folders, and only the secrets its manifest declared.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { PLUGIN_API_VERSION, type PluginManifest } from '../types.js';
import { currentPlatform } from '../store.js';
import { PLUGIN_IMAGE_TYPES, publishTool, toolContent, unpublishPlugin } from '../tool-bridge.js';
import type { PluginRuntime, RuntimeDeps } from './types.js';

export const OUT_OF_PROCESS = {
  initTimeoutMs: 20_000,
  listTimeoutMs: 15_000,
  stopGraceMs: 3_000,
  maxCrashes: 5,
  crashWindowMs: 10 * 60 * 1000,
  backoffStartMs: 1_000,
  backoffMaxMs: 60_000,
  maxLineBytes: 8 * 1024 * 1024,
};

const MCP_PROTOCOL_VERSION = '2025-06-18';

/** Environment variables passed through to plugin processes; nothing else leaks. */
const PASS_ENV = ['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'COMSPEC', 'PATHEXT', 'WINDIR'];

interface Pending {
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export class OutOfProcessRuntime implements PluginRuntime {
  readonly kind = 'out-of-process' as const;
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private wanted = false;
  private ready = false;
  private crashes: number[] = [];
  private backoff = OUT_OF_PROCESS.backoffStartMs;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stderrTail: string[] = [];

  constructor(private readonly manifest: PluginManifest, private readonly dir: string, private readonly deps: RuntimeDeps) {}

  isRunning(): boolean {
    return this.ready;
  }

  /** Start and complete the MCP handshake. Throws if the first start fails. */
  async start(): Promise<void> {
    this.wanted = true;
    await this.launch();
  }

  async stop(): Promise<void> {
    this.wanted = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    await this.kill();
    unpublishPlugin(this.manifest.id);
  }

  private command(): { cmd: string; args: string[]; env: Record<string, string> } {
    const spec = this.manifest.server!.platforms?.[currentPlatform()] ?? this.manifest.server!;
    const extraEnv: Record<string, string> = {};
    if (spec.command === 'node') {
      // npm installs run on Node; standalone binaries are Bun and can run a
      // script themselves with BUN_BE_BUN=1 (no system Node needed).
      if (typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined') extraEnv.BUN_BE_BUN = '1';
      return { cmd: process.execPath, args: spec.args.map((a, i) => (i === 0 ? resolve(this.dir, a) : a)), env: extraEnv };
    }
    return { cmd: resolve(this.dir, spec.command), args: spec.args, env: extraEnv };
  }

  private buildEnv(extra: Record<string, string>): Record<string, string> {
    const env: Record<string, string> = {};
    for (const k of PASS_ENV) if (process.env[k]) env[k] = process.env[k]!;
    for (const [k, v] of Object.entries(this.deps.secrets)) if (v !== undefined) env[k] = v;
    env.MERCURY_PLUGIN_ID = this.manifest.id;
    env.MERCURY_PLUGIN_VERSION = this.manifest.version;
    env.MERCURY_PLUGIN_DATA_DIR = this.deps.dataDir;
    env.MERCURY_PLUGIN_API = PLUGIN_API_VERSION;
    env.MERCURY_PLUGIN_SETTINGS = JSON.stringify(this.deps.settings);
    return { ...env, ...extra };
  }

  private async launch(): Promise<void> {
    const { cmd, args, env } = this.command();
    const child = spawn(cmd, args, {
      cwd: this.dir,
      env: this.buildEnv(env),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    this.ready = false;
    this.stderrTail = [];

    const spawned = new Promise<void>((res, rej) => {
      child.once('spawn', () => res());
      child.once('error', (err) => rej(new Error(`Couldn't start the plugin process: ${err.message}`)));
    });

    const out = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    out.on('line', (line) => this.onLine(line));
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      for (const l of chunk.split('\n')) {
        if (!l.trim()) continue;
        this.stderrTail.push(l.slice(0, 500));
        if (this.stderrTail.length > 20) this.stderrTail.shift();
        this.deps.log.debug(`stderr: ${l.slice(0, 500)}`);
      }
    });
    child.stdin!.on('error', () => { /* broken pipe on crash; handled by exit */ });
    child.once('exit', (code, sig) => this.onExit(child, code, sig));

    await spawned;
    try {
      await this.request('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        // Plugin API 1.1: tell a channel plugin Mercury speaks the channel extension.
        capabilities: this.manifest.contributes.channel ? { experimental: { 'mercury/channel': { version: 1 } } } : {},
        clientInfo: { name: 'mercury', version: this.deps.mercuryVersion },
      }, OUT_OF_PROCESS.initTimeoutMs);
      this.notify('notifications/initialized', {});
      await this.refreshTools();
      this.ready = true;
      this.backoff = OUT_OF_PROCESS.backoffStartMs;
      try { this.deps.onReady?.(); } catch (err) { this.deps.log.warn(`onReady: ${(err as Error).message}`); }
    } catch (err) {
      const tail = this.stderrTail.slice(-3).join(' | ');
      await this.kill();
      throw new Error(`${(err as Error).message}${tail ? ` (stderr: ${tail})` : ''}`);
    }
  }

  private async refreshTools(): Promise<void> {
    const res = (await this.request('tools/list', {}, OUT_OF_PROCESS.listTimeoutMs)) as { tools?: McpTool[] };
    const offered = new Map((res?.tools ?? []).map((t) => [t.name, t]));
    unpublishPlugin(this.manifest.id);
    for (const decl of this.manifest.contributes.tools) {
      const t = offered.get(decl.name);
      if (!t) {
        this.deps.log.warn(`declared tool "${decl.name}" is not offered by the server`);
        continue;
      }
      const schema = t.inputSchema && t.inputSchema.type === 'object' ? t.inputSchema : { type: 'object', properties: {} };
      publishTool({
        pluginId: this.manifest.id,
        pluginName: this.manifest.name,
        name: decl.name,
        description: decl.description,
        inputSchema: schema,
        readOnly: decl.readOnly,
        timeoutMs: decl.timeoutMs,
        invoke: (args, signal) => this.callTool(decl.name, args, signal, decl.timeoutMs),
      });
    }
    for (const name of offered.keys()) {
      if (!this.manifest.contributes.tools.some((d) => d.name === name)) {
        this.deps.log.warn(`server offers undeclared tool "${name}"; ignored (declare it in mercury-plugin.json)`);
      }
    }
  }

  private async callTool(name: string, args: Record<string, unknown>, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
    if (!this.ready) throw new Error('the plugin process is not running');
    const res = (await this.request('tools/call', { name, arguments: args }, timeoutMs + 1000, signal)) as {
      content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
      isError?: boolean;
      structuredContent?: unknown;
    };
    const parts = res?.content ?? [];
    const isImage = (c: (typeof parts)[number]) => c.type === 'image' && typeof c.data === 'string' && PLUGIN_IMAGE_TYPES.has(c.mimeType ?? '');
    const images = parts.filter(isImage).map((c) => ({ data: c.data!, mimeType: c.mimeType! }));
    const text = parts
      .filter((c) => !isImage(c))
      .map((c) => (c.type === 'text' ? c.text ?? '' : `[${c.type} content]`))
      .join('\n');
    if (res?.isError) throw new Error(text || 'the tool reported an error');
    // Plugin API 1.2: images (screenshots) go to the model as images, not text.
    if (images.length) return toolContent(text, images);
    return text || (res?.structuredContent !== undefined ? res.structuredContent : 'Done.');
  }

  /**
   * Plugin API 1.1 channel calls (`mercury/channel/*`). A slow send (a large
   * upload) times out for that call only; it never recycles the process,
   * which would drop the plugin's connection to the chat service.
   */
  channelRequest(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (!method.startsWith('mercury/channel/')) return Promise.reject(new Error(`not a channel method: ${method}`));
    if (!this.ready) return Promise.reject(new Error('the plugin process is not running'));
    return this.request(method, params, timeoutMs, undefined, false);
  }

  private request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal, recycleOnTimeout = true): Promise<unknown> {
    const child = this.child;
    if (!child || child.exitCode !== null || !child.stdin?.writable) return Promise.reject(new Error('the plugin process is not running'));
    const id = this.nextId++;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
        // A server that stops answering is treated as hung: restart it.
        if (method !== 'initialize' && recycleOnTimeout) void this.recycle(`${method} timed out`);
      }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
      if (signal) {
        const onAbort = () => {
          const p = this.pending.get(id);
          if (!p) return;
          clearTimeout(p.timer);
          this.pending.delete(id);
          this.notify('notifications/cancelled', { requestId: id, reason: 'cancelled' });
          rejectPromise(new Error('cancelled'));
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  /** Plugin API 1.1 channel notifications to the plugin (`mercury/call/*`). */
  channelNotify(method: string, params: unknown): void {
    if (method.startsWith('mercury/') && this.ready) this.notify(method, params);
  }

  private notify(method: string, params: unknown): void {
    const child = this.child;
    if (!child?.stdin?.writable) return;
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    } catch { /* closing */ }
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    if (line.length > OUT_OF_PROCESS.maxLineBytes) {
      this.deps.onError('protocol: message too large');
      return;
    }
    let msg: { id?: number | string; method?: string; result?: unknown; error?: { message?: string }; params?: unknown };
    try {
      msg = JSON.parse(line);
    } catch {
      // Servers sometimes print logs to stdout; MCP reserves stdout for protocol.
      this.deps.log.debug(`non-protocol stdout: ${line.slice(0, 200)}`);
      return;
    }
    if (msg.method && msg.id !== undefined) {
      // Server → client requests: we support ping; refuse everything else (sampling, roots…).
      if (msg.method === 'ping') this.reply(msg.id, {});
      else if (msg.method.startsWith('mercury/') && this.manifest.contributes.channel && this.deps.onRequest) {
        const id = msg.id;
        this.deps.onRequest(msg.method, msg.params)
          .then((result) => this.reply(id, result ?? {}))
          .catch((err) => this.replyError(id, -32000, (err as Error).message));
      } else this.replyError(msg.id, -32601, `Mercury does not support ${msg.method}`);
      return;
    }
    if (msg.method) {
      if (msg.method === 'notifications/tools/list_changed' && this.ready) {
        this.refreshTools().catch((err) => this.deps.onError(`tools/list after change: ${(err as Error).message}`));
      } else if (msg.method.startsWith('mercury/') && this.manifest.contributes.channel) {
        try {
          this.deps.onNotification?.(msg.method, msg.params);
        } catch (err) {
          this.deps.onError(`${msg.method}: ${(err as Error).message}`);
        }
      }
      return;
    }
    if (typeof msg.id !== 'number') return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message ?? 'server error'));
    else p.resolve(msg.result);
  }

  private reply(id: number | string, result: unknown): void {
    this.child?.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  }

  private replyError(id: number | string, code: number, message: string): void {
    this.child?.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
  }

  private failPending(reason: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
      this.pending.delete(id);
    }
  }

  private onExit(child: ChildProcess, code: number | null, sig: NodeJS.Signals | null): void {
    if (this.child !== child) return;
    this.child = null;
    const wasReady = this.ready;
    this.ready = false;
    this.failPending('the plugin process exited');
    unpublishPlugin(this.manifest.id);
    if (wasReady) {
      try { this.deps.onDown?.(); } catch { /* best effort */ }
    }
    if (!this.wanted) return;
    const tail = this.stderrTail.slice(-3).join(' | ');
    const why = `exited (${sig ?? `code ${code}`})${tail ? `: ${tail}` : ''}`;
    if (!wasReady) return; // start() reports first-launch failures itself
    // Counted once, by the crash window below. (A call that was in flight
    // already counts as a failed tool call; don't double-count the crash.)
    this.deps.log.warn(`plugin process ${why}`);
    this.scheduleRestart(why);
  }

  private scheduleRestart(why: string): void {
    const now = Date.now();
    this.crashes = this.crashes.filter((t) => now - t < OUT_OF_PROCESS.crashWindowMs);
    this.crashes.push(now);
    if (this.crashes.length > OUT_OF_PROCESS.maxCrashes) {
      this.wanted = false;
      this.deps.onFatal?.('crashed', `crashed ${this.crashes.length} times in ${OUT_OF_PROCESS.crashWindowMs / 60000} minutes (last: ${why})`);
      return;
    }
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, OUT_OF_PROCESS.backoffMaxMs);
    this.deps.log.warn(`restarting in ${Math.round(delay / 1000)}s after it ${why}`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.wanted) return;
      this.launch().catch((err) => {
        this.deps.onError(`restart failed: ${(err as Error).message}`);
        this.scheduleRestart(`restart failed: ${(err as Error).message}`);
      });
    }, delay);
  }

  /** Kill a hung server; the exit handler restarts it. */
  private async recycle(reason: string): Promise<void> {
    if (!this.child || !this.wanted) return;
    this.deps.log.warn(`killing unresponsive plugin process: ${reason}`);
    this.child.kill('SIGKILL');
  }

  private async kill(): Promise<void> {
    const child = this.child;
    this.ready = false;
    if (!child) return;
    this.failPending('the plugin is stopping');
    await new Promise<void>((res) => {
      if (child.exitCode !== null || child.signalCode !== null) return res();
      const t = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* gone */ }
      }, OUT_OF_PROCESS.stopGraceMs);
      child.once('exit', () => {
        clearTimeout(t);
        res();
      });
      try {
        child.stdin?.end();
        child.kill('SIGTERM');
      } catch {
        clearTimeout(t);
        res();
      }
    });
    if (this.child === child) this.child = null;
  }
}

