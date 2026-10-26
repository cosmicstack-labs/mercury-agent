/**
 * One interface for "change plugins", whichever process you're in.
 *
 * Plugins only ever run in the process that owns the runtime (the daemon,
 * or a standalone foreground runtime; ADR-024). Everything else, a
 * `mercury plugins …` CLI call or a terminal attached beside a running
 * daemon, forwards each operation to that process over the authenticated
 * loopback API, so the daemon stops/starts plugins itself and two
 * processes never run the same plugin. When no daemon is running, the
 * operation is done on disk directly and takes effect at the next start.
 */
import { getWebPort, readAttachToken } from '../web/auth.js';
import { getDaemonStatus, getForegroundRuntimeStatus } from '../cli/daemon.js';
import { getPluginManager, type PluginManager } from './manager.js';
import type { PluginListItem } from './types.js';
import type { ChannelStatus } from './channel-bridge.js';

export interface ListResult {
  items: PluginListItem[];
  catalogError?: string;
  stale: boolean;
  safeMode: boolean;
}

export interface InstallSummary {
  id: string;
  name: string;
  version: string;
  previousVersion?: string;
  verified: boolean;
  unchanged: boolean;
  tier: 'official' | 'community' | 'local';
}

export interface PluginService {
  /** "local" runs plugins here; "daemon" forwards to it; "offline" edits disk only. */
  readonly mode: 'local' | 'daemon' | 'offline';
  list(refresh?: boolean): Promise<ListResult>;
  info(id: string): Promise<PluginListItem | null>;
  install(source: string, opts?: { enable?: boolean; force?: boolean }): Promise<InstallSummary>;
  enable(id: string): Promise<void>;
  disable(id: string): Promise<void>;
  update(id?: string): Promise<Array<{ id: string; from: string; to: string }>>;
  rollback(id: string): Promise<{ from: string; to: string }>;
  uninstall(id: string, purge?: boolean): Promise<void>;
  setSetting(id: string, key: string, value: unknown): Promise<void>;
  /** Plugin API 1.1 channels. */
  pair(id: string, opts: { method: 'qr' | 'code'; phone?: string }): Promise<ChannelStatus>;
  channelStatus(id: string): Promise<ChannelStatus | null>;
  unlink(id: string): Promise<void>;
  testChannel(id: string): Promise<string>;
}

export function localService(mgr: PluginManager, mode: 'local' | 'offline' = 'local'): PluginService {
  return {
    mode,
    list: (refresh) => mgr.list({ refresh }),
    info: (id) => mgr.info(id),
    install: async (source, opts) => {
      const r = await mgr.install(source, opts);
      return { id: r.id, name: r.manifest.name, version: r.version, previousVersion: r.previousVersion, verified: r.verified, unchanged: r.unchanged, tier: r.tier };
    },
    enable: (id) => mgr.enable(id),
    disable: (id) => mgr.disable(id),
    update: (id) => mgr.update(id),
    rollback: (id) => mgr.rollback(id),
    uninstall: (id, purge) => mgr.uninstall(id, { purge }),
    setSetting: (id, key, value) => mgr.setSetting(id, key, value),
    pair: (id, opts) => mgr.pair(id, opts),
    channelStatus: async (id) => mgr.channelStatus(id),
    unlink: (id) => mgr.unlinkChannel(id),
    testChannel: (id) => mgr.testChannel(id),
  };
}

async function call<T>(method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
  const token = readAttachToken();
  if (!token) throw new Error('Mercury is running in the background but its local API token is missing. Try `mercury restart`.');
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${getWebPort()}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(`Couldn't reach the background Mercury (${(err as Error).message}).`);
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string } & T;
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export function daemonService(): PluginService {
  const enc = encodeURIComponent;
  return {
    mode: 'daemon',
    list: (refresh) => call<ListResult>('GET', `/api/plugins${refresh ? '?refresh=1' : ''}`),
    info: async (id) => (await call<{ plugin: PluginListItem | null }>('GET', `/api/plugins/${enc(id)}`)).plugin,
    install: (source, opts) => call<InstallSummary>('POST', '/api/plugins/install', { source, ...opts }, 10 * 60_000),
    enable: async (id) => { await call('POST', `/api/plugins/${enc(id)}/enable`); },
    disable: async (id) => { await call('POST', `/api/plugins/${enc(id)}/disable`); },
    update: async (id) => (await call<{ changed: Array<{ id: string; from: string; to: string }> }>('POST', `/api/plugins/${id ? `${enc(id)}/` : ''}update`, {}, 10 * 60_000)).changed,
    rollback: (id) => call<{ from: string; to: string }>('POST', `/api/plugins/${enc(id)}/rollback`),
    uninstall: async (id, purge) => { await call('DELETE', `/api/plugins/${enc(id)}${purge ? '?purge=1' : ''}`); },
    setSetting: async (id, key, value) => { await call('POST', `/api/plugins/${enc(id)}/settings`, { key, value }); },
    pair: async (id, opts) => (await call<{ status: ChannelStatus }>('POST', `/api/plugins/${enc(id)}/pair`, opts, 60_000)).status,
    channelStatus: async (id) => (await call<{ status: ChannelStatus | null }>('GET', `/api/plugins/${enc(id)}/channel`)).status,
    unlink: async (id) => { await call('POST', `/api/plugins/${enc(id)}/unlink`, {}); },
    testChannel: async (id) => (await call<{ message: string }>('POST', `/api/plugins/${enc(id)}/test`, {})).message,
  };
}

/**
 * The right service for this process: local when we run plugins, the
 * daemon when one is running, otherwise on-disk only.
 */
export function getPluginService(): PluginService {
  const mgr = getPluginManager();
  if (mgr.runsPlugins()) return localService(mgr);
  // Whichever process owns the runtime (daemon, or a foreground `mercury
  // start -f`) serves the API and runs the plugins.
  if (getDaemonStatus().running || getForegroundRuntimeStatus().running) return daemonService();
  return localService(mgr, 'offline');
}
