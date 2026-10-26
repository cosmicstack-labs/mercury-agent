/**
 * The plugin catalog: an index of installable plugins, each pinned to a
 * version and SHA-256. Fetched over HTTPS (SSRF-guarded), validated, and
 * cached so /plugins still works offline. One malformed entry never hides
 * the rest: entries are validated individually.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { guardedFetch } from '../utils/ssrf.js';
import { logger } from '../utils/logger.js';
import { pluginsRoot, writeJsonAtomic } from './store.js';
import { catalogEntrySchema, type Catalog, type CatalogEntry } from './types.js';

export const DEFAULT_CATALOG_URL = 'https://mercuryagent.sh/plugins/catalog.json';
const MAX_AGE_MS = 6 * 60 * 60 * 1000;
const MAX_BYTES = 2 * 1024 * 1024;

export function catalogUrl(): string {
  const override = process.env.MERCURY_PLUGIN_CATALOG_URL?.trim();
  return override && /^https:\/\//.test(override) ? override : DEFAULT_CATALOG_URL;
}

interface CacheFile {
  url: string;
  fetchedAt: string;
  catalog: Catalog;
}

export interface CatalogResult {
  entries: CatalogEntry[];
  fetchedAt?: string;
  /** True when served from cache because the network fetch failed. */
  stale: boolean;
  error?: string;
}

function cachePath(): string {
  return join(pluginsRoot(), 'catalog-cache.json');
}

function readCache(url: string): CacheFile | null {
  try {
    if (!existsSync(cachePath())) return null;
    const c = JSON.parse(readFileSync(cachePath(), 'utf8')) as CacheFile;
    return c.url === url && Array.isArray(c.catalog?.plugins) ? c : null;
  } catch {
    return null;
  }
}

/** Keep valid entries, report how many were dropped. */
export function parseCatalog(raw: unknown): { catalog: Catalog; dropped: number } {
  const obj = raw as { catalogVersion?: unknown; updatedAt?: unknown; plugins?: unknown };
  if (!obj || obj.catalogVersion !== 1 || !Array.isArray(obj.plugins)) throw new Error('not a version 1 plugin catalog');
  const plugins: CatalogEntry[] = [];
  let dropped = 0;
  const seen = new Set<string>();
  for (const entry of obj.plugins.slice(0, 500)) {
    const parsed = catalogEntrySchema.safeParse(entry);
    if (parsed.success && !seen.has(parsed.data.id)) {
      seen.add(parsed.data.id);
      plugins.push(parsed.data);
    } else {
      dropped += 1;
    }
  }
  return { catalog: { catalogVersion: 1, updatedAt: String(obj.updatedAt ?? ''), plugins }, dropped };
}

/** `MERCURY_PLUGIN_CATALOG_URL=off` disables the catalog (air-gapped installs, tests). */
export function catalogDisabled(): boolean {
  return /^(off|none|disabled)$/i.test(process.env.MERCURY_PLUGIN_CATALOG_URL?.trim() ?? '');
}

export async function getCatalog(opts: { force?: boolean } = {}): Promise<CatalogResult> {
  if (catalogDisabled()) return { entries: [], stale: false };
  const url = catalogUrl();
  const cached = readCache(url);
  if (!opts.force && cached && Date.now() - Date.parse(cached.fetchedAt) < MAX_AGE_MS) {
    return { entries: cached.catalog.plugins, fetchedAt: cached.fetchedAt, stale: false };
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10_000);
  try {
    const res = await guardedFetch(url, ac.signal, { accept: 'application/json', 'user-agent': 'mercury-plugins' });
    if (!res.ok) throw new Error(`catalog returned HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error('catalog is too large');
    const { catalog, dropped } = parseCatalog(JSON.parse(text));
    if (dropped > 0) logger.warn({ dropped }, 'Plugin catalog: skipped invalid entries');
    const fetchedAt = new Date().toISOString();
    mkdirSync(pluginsRoot(), { recursive: true });
    writeJsonAtomic(cachePath(), { url, fetchedAt, catalog } satisfies CacheFile);
    return { entries: catalog.plugins, fetchedAt, stale: false };
  } catch (err) {
    const message = (err as Error).name === 'AbortError' ? 'timed out' : (err as Error).message;
    logger.info({ err: message }, 'Plugin catalog unavailable; using cache');
    return { entries: cached?.catalog.plugins ?? [], fetchedAt: cached?.fetchedAt, stale: true, error: message };
  } finally {
    clearTimeout(timer);
  }
}

export async function findCatalogEntry(id: string, opts: { force?: boolean } = {}): Promise<CatalogEntry | undefined> {
  const { entries } = await getCatalog(opts);
  return entries.find((e) => e.id === id);
}
