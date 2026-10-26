/**
 * On-disk layout and state for plugins.
 *
 *   ~/.mercury/plugins/
 *     state.json              which plugins are installed / enabled (atomic writes)
 *     catalog-cache.json      last catalog fetched, so /plugins works offline
 *     .lock                   install/uninstall lock (CLI and daemon share it)
 *     .staging/               scratch space for installs; never read by the loader
 *     <id>/
 *       versions/<version>/   the installed package (current + one previous)
 *       data/                 plugin-owned data, kept across updates
 *       settings.json         owner settings, kept across updates
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getMercuryHome } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import {
  MANIFEST_VERSION, PLUGIN_API_VERSION, PLUGIN_ID_RE,
  type PluginManifest, type PluginsState, type PlatformKey,
} from './types.js';

export function pluginsRoot(): string {
  return join(getMercuryHome(), 'plugins');
}
export function pluginDir(id: string): string {
  assertId(id);
  return join(pluginsRoot(), id);
}
export function pluginVersionDir(id: string, version: string): string {
  return join(pluginDir(id), 'versions', version);
}
export function pluginDataDir(id: string): string {
  return join(pluginDir(id), 'data');
}
export function pluginSettingsPath(id: string): string {
  return join(pluginDir(id), 'settings.json');
}
export function stagingRoot(): string {
  return join(pluginsRoot(), '.staging');
}

export function assertId(id: string): void {
  if (!PLUGIN_ID_RE.test(id)) throw new Error(`Invalid plugin id "${id}"`);
}

// ── platform and compatibility ─────────────────────────────────────────────

export function currentPlatform(): PlatformKey {
  const os = process.platform === 'android' ? 'android' : process.platform;
  return `${os}-${process.arch}` as PlatformKey;
}

/** Mercury's own version: stamped into compiled builds, else package.json. */
export function mercuryVersion(): string {
  const stamped = (globalThis as { __MERCURY_VERSION__?: string }).__MERCURY_VERSION__;
  if (stamped) return stamped;
  return process.env.MERCURY_VERSION_OVERRIDE ?? packageVersion();
}

let cachedPkgVersion: string | null = null;
function packageVersion(): string {
  if (cachedPkgVersion) return cachedPkgVersion;
  let here = process.cwd();
  try { here = dirname(fileURLToPath(import.meta.url)); } catch { /* compiled binary: virtual path */ }
  const candidates = [join(here, '..', '..', 'package.json'), join(here, '..', 'package.json'), join(process.cwd(), 'package.json')];
  for (const p of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(p, 'utf8')) as { name?: string; version?: string };
      if (pkg.name === '@cosmicstack/mercury-agent' && pkg.version) return (cachedPkgVersion = pkg.version);
    } catch { /* next */ }
  }
  return (cachedPkgVersion = '0.0.0');
}

/**
 * Why a manifest can't run here, or null if it can. Pre-release Mercury
 * builds (dev channel) are matched as their release version.
 */
export function incompatibility(manifest: Pick<PluginManifest, 'engines' | 'platforms'> & { manifestVersion?: number }): string | null {
  if (manifest.manifestVersion !== undefined && manifest.manifestVersion !== MANIFEST_VERSION) {
    return `manifest version ${manifest.manifestVersion} is not supported (this Mercury reads version ${MANIFEST_VERSION})`;
  }
  const mv = semver.coerce(mercuryVersion())?.version ?? '0.0.0';
  if (!semver.satisfies(mv, manifest.engines.mercury, { includePrerelease: true })) {
    return `needs Mercury ${manifest.engines.mercury}, this is ${mv}`;
  }
  const api = manifest.engines.pluginApi ?? '^1.0.0';
  if (!semver.satisfies(PLUGIN_API_VERSION, api)) {
    return `needs plugin API ${api}, this Mercury provides ${PLUGIN_API_VERSION}`;
  }
  if (manifest.platforms && !manifest.platforms.includes(currentPlatform())) {
    return `not available for ${currentPlatform()} (supports ${manifest.platforms.join(', ')})`;
  }
  return null;
}

// ── state ─────────────────────────────────────────────────────────────────

function emptyState(): PluginsState {
  return { stateVersion: 1, plugins: {}, boot: { inProgress: false, failedBoots: 0 } };
}

function statePath(): string {
  return join(pluginsRoot(), 'state.json');
}

/** Read state.json. A missing or corrupt file never throws: corrupt files are set aside. */
export function readState(): PluginsState {
  const path = statePath();
  if (!existsSync(path)) return emptyState();
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<PluginsState>;
    if (raw.stateVersion !== 1 || typeof raw.plugins !== 'object' || raw.plugins === null) throw new Error('unexpected shape');
    const plugins: PluginsState['plugins'] = {};
    for (const [id, entry] of Object.entries(raw.plugins)) {
      if (PLUGIN_ID_RE.test(id) && entry && typeof entry.version === 'string') plugins[id] = entry;
    }
    return {
      stateVersion: 1,
      plugins,
      boot: {
        inProgress: raw.boot?.inProgress === true,
        failedBoots: Number.isInteger(raw.boot?.failedBoots) ? raw.boot!.failedBoots : 0,
        lastChange: raw.boot?.lastChange,
      },
    };
  } catch (err) {
    const aside = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, aside); } catch { /* ignore */ }
    logger.warn({ err, aside }, 'Plugin state was unreadable; set it aside and started empty (no plugins load)');
    return emptyState();
  }
}

/** Atomic write: temp file + rename, so a crash mid-write can't corrupt state. */
export function writeState(state: PluginsState): void {
  mkdirSync(pluginsRoot(), { recursive: true });
  writeJsonAtomic(statePath(), state);
}

export function writeJsonAtomic(path: string, data: unknown): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
}

/** Read-modify-write under the install lock. */
export async function updateState(mutate: (s: PluginsState) => void): Promise<PluginsState> {
  return withLock(async () => {
    const s = readState();
    mutate(s);
    writeState(s);
    return s;
  });
}

// ── lock ──────────────────────────────────────────────────────────────────

const LOCK_STALE_MS = 10 * 60 * 1000;

function lockPath(): string {
  return join(pluginsRoot(), '.lock');
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Lock for anything that changes plugins on disk.
 * - Across processes: an exclusive lock file (the daemon and a
 *   `mercury plugins …` CLI call can run at the same time). Stale locks
 *   (dead pid, or older than 10 minutes) are taken over.
 * - Within a process: a queue, so concurrent async callers run one at a time.
 * - Re-entrant only for genuinely nested calls (same async context), via
 *   AsyncLocalStorage, never for unrelated concurrent work.
 */
const lockContext = new AsyncLocalStorage<boolean>();
let lockQueue: Promise<unknown> = Promise.resolve();

export async function withLock<T>(fn: () => Promise<T>, timeoutMs = 30_000): Promise<T> {
  if (lockContext.getStore()) return fn();
  const run = async (): Promise<T> => {
    await acquireFileLock(timeoutMs);
    try {
      return await lockContext.run(true, fn);
    } finally {
      try { rmSync(lockPath(), { force: true }); } catch { /* ignore */ }
    }
  };
  const result = lockQueue.then(run, run);
  lockQueue = result.catch(() => {});
  return result;
}

async function acquireFileLock(timeoutMs: number): Promise<void> {
  mkdirSync(pluginsRoot(), { recursive: true });
  const path = lockPath();
  const started = Date.now();
  for (;;) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      let stale = false;
      try {
        const pid = Number(readFileSync(path, 'utf8').trim());
        const age = Date.now() - statSync(path).mtimeMs;
        stale = !Number.isInteger(pid) || pid <= 0 || !pidAlive(pid) || age > LOCK_STALE_MS;
      } catch {
        stale = true;
      }
      if (stale) {
        try { rmSync(path, { force: true }); } catch { /* raced */ }
        continue;
      }
      if (Date.now() - started > timeoutMs) throw new Error('Another plugin install or uninstall is in progress. Try again in a moment.');
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}

// ── settings ──────────────────────────────────────────────────────────────

interface SettingsFile {
  settingsVersion: number;
  values: Record<string, unknown>;
}

function readSettingsFile(path: string): SettingsFile | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<SettingsFile>;
    const values = raw.values && typeof raw.values === 'object' && !Array.isArray(raw.values) ? raw.values : {};
    const v = Number.isInteger(raw.settingsVersion) && (raw.settingsVersion as number) >= 1 ? (raw.settingsVersion as number) : 1;
    return { settingsVersion: v, values };
  } catch {
    return null;
  }
}

export function readSettings(id: string): Record<string, unknown> {
  return readSettingsFile(pluginSettingsPath(id))?.values ?? {};
}

/** Saved settings from `from` brought up to the manifest's settings version. */
export function migrateSettingValues(manifest: PluginManifest, values: Record<string, unknown>, from: number): Record<string, unknown> {
  const out = { ...values };
  for (const step of manifest.settings?.migrations ?? []) {
    if (step.to <= from) continue;
    for (const [oldKey, newKey] of Object.entries(step.rename)) {
      if (oldKey in out) {
        if (!(newKey in out)) out[newKey] = out[oldKey];
        delete out[oldKey];
      }
    }
    for (const key of step.remove) delete out[key];
    for (const [key, map] of Object.entries(step.mapValues)) {
      const v = out[key];
      if ((typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') && Object.prototype.hasOwnProperty.call(map, String(v))) {
        out[key] = map[String(v)];
      }
    }
  }
  return out;
}

/**
 * Bring settings.json up to this version's settings version, once, before
 * the plugin starts. The file being replaced is kept as
 * `settings.v<N>.json`, so a rollback to the older plugin finds its own
 * settings again instead of values it doesn't understand.
 */
export function migrateSettings(manifest: PluginManifest): { from: number; to: number } | null {
  const target = manifest.settings?.version ?? 1;
  const path = pluginSettingsPath(manifest.id);
  const saved = readSettingsFile(path);
  if (!saved || saved.settingsVersion === target) return null;
  const backup = (v: number) => join(pluginDir(manifest.id), `settings.v${v}.json`);
  writeJsonAtomic(backup(saved.settingsVersion), saved);
  if (saved.settingsVersion > target) {
    // Rolled back to an older plugin: restore that version's saved settings if we have them.
    const older = readSettingsFile(backup(target));
    writeJsonAtomic(path, older && older.settingsVersion === target ? older : { settingsVersion: target, values: {} });
  } else {
    writeJsonAtomic(path, { settingsVersion: target, values: migrateSettingValues(manifest, saved.values, saved.settingsVersion) });
  }
  return { from: saved.settingsVersion, to: target };
}

/**
 * Settings with defaults filled in and values coerced to the declared types.
 * Unknown keys are dropped, so a plugin never sees a value its manifest
 * doesn't describe. Older saved versions are migrated in memory first.
 */
export function resolvedSettings(manifest: PluginManifest): Record<string, unknown> {
  const fields = manifest.settings?.fields ?? {};
  const file = readSettingsFile(pluginSettingsPath(manifest.id));
  const target = manifest.settings?.version ?? 1;
  const saved = !file ? {} : file.settingsVersion < target ? migrateSettingValues(manifest, file.values, file.settingsVersion) : file.settingsVersion > target ? {} : file.values;
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(fields)) {
    if (field.type === 'secret') continue; // keys live in the key store, not settings
    const v = saved[key];
    let value: unknown = field.default;
    if (field.type === 'boolean' && typeof v === 'boolean') value = v;
    else if (field.type === 'number' && typeof v === 'number' && Number.isFinite(v)) value = v;
    else if (field.type === 'string' && typeof v === 'string') value = v;
    else if (field.type === 'enum' && typeof v === 'string' && field.options?.includes(v)) value = v;
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export function writeSettings(id: string, values: Record<string, unknown>, settingsVersion: number): void {
  mkdirSync(pluginDir(id), { recursive: true });
  writeJsonAtomic(pluginSettingsPath(id), { settingsVersion, values });
}

// ── key store ─────────────────────────────────────────────────────────────

/**
 * API keys plugin settings ask for (type "secret"), e.g. an ElevenLabs key
 * for WhatsApp voice. One owner-only file for every plugin; each plugin only
 * ever receives the names it declares in permissions.secrets.
 */
export function pluginKeysPath(): string {
  return join(getMercuryHome(), 'plugin-keys.json');
}

export function readPluginKeys(): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(pluginKeysPath(), 'utf8')) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].length > 0));
  } catch {
    return {};
  }
}

export function setPluginKey(name: string, value: string | null): void {
  const keys = readPluginKeys();
  if (value) keys[name] = value;
  else delete keys[name];
  writeJsonAtomic(pluginKeysPath(), keys);
}

/** A declared secret: Mercury's environment first (~/.mercury/.env), then the key store. */
export function secretValue(name: string): string | undefined {
  return process.env[name] || readPluginKeys()[name] || undefined;
}
