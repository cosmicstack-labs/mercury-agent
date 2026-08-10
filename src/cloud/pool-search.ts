import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { getMemoryDir } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { refreshToken } from './pairing.js';

type BetterSqlite3Database = import('better-sqlite3').Database;
const require = createRequire(import.meta.url);
function loadDatabase(): typeof import('better-sqlite3') {
  return require('better-sqlite3');
}

/**
 * Cloud shared-pool search client for the agent.
 *
 * After the local second-brain retrieval, the agent calls `searchPool()` to
 * fetch additional context from the user's cloud SharedMemoryPool. Results are
 * cached in a small SQLite DB for 5 minutes per (normalized) query — chat
 * turns frequently repeat the same query shape, so this kills most of the
 * per-turn embedding + network cost.
 *
 * Fail-open: any error (network, auth, timeout) returns an empty array so the
 * agent proceeds with local-only context. A slow cloud never blocks the chat
 * turn — the request has an 800ms timeout.
 */

const CACHE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 800;
const MAX_CACHE_ROWS = 500;

export interface PoolSearchHit {
  id: string;
  type: string;
  categories: string[];
  summary: string;
  detail: string | null;
  confidence: number;
  importance: number;
  durability: number;
  evidenceCount: number;
  sourceAgentIds: string[];
  agentMemoryUpdatedAt: number;
  score: number;
  source: 'semantic' | 'fts';
}

export interface PoolSearchOptions {
  limit?: number;
  types?: string[];
  categories?: string[];
}

interface CacheRow {
  query_hash: string;
  query: string;
  results_json: string;
  fetched_at: number;
}

let cacheDb: BetterSqlite3Database | null = null;

function getCacheDb(): BetterSqlite3Database {
  if (cacheDb) return cacheDb;
  const dir = getMemoryDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'pool-search-cache.db');
  cacheDb = loadDatabase()(dbPath);
  cacheDb.exec(`
    CREATE TABLE IF NOT EXISTS pool_search_cache (
      query_hash TEXT PRIMARY KEY,
      query TEXT NOT NULL,
      results_json TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pool_search_fetched_at ON pool_search_cache(fetched_at);
  `);
  return cacheDb;
}

function hashQuery(query: string): string {
  // Simple non-crypto hash — enough for a 5-min cache key.
  let h = 0;
  for (let i = 0; i < query.length; i++) {
    h = (Math.imul(31, h) + query.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

function readCache(queryHash: string): PoolSearchHit[] | null {
  const db = getCacheDb();
  const row = db.prepare('SELECT results_json, fetched_at FROM pool_search_cache WHERE query_hash = ?').get(queryHash) as CacheRow | undefined;
  if (!row) return null;
  if (Date.now() - row.fetched_at > CACHE_TTL_MS) return null;
  try {
    return JSON.parse(row.results_json) as PoolSearchHit[];
  } catch {
    return null;
  }
}

function writeCache(queryHash: string, query: string, results: PoolSearchHit[]): void {
  const db = getCacheDb();
  const now = Date.now();
  db.prepare('INSERT OR REPLACE INTO pool_search_cache (query_hash, query, results_json, fetched_at) VALUES (?, ?, ?, ?)').run(
    queryHash,
    query,
    JSON.stringify(results),
    now,
  );
  // Bounded cache — drop oldest rows past MAX_CACHE_ROWS.
  db.exec(`DELETE FROM pool_search_cache WHERE query_hash NOT IN (
    SELECT query_hash FROM pool_search_cache ORDER BY fetched_at DESC LIMIT ${MAX_CACHE_ROWS}
  )`);
}

/**
 * Search the user's cloud SharedMemoryPool. Returns ranked hits or an empty
 * array on any failure (network, auth, timeout). Refreshes the JWT once if the
 * first attempt comes back 401.
 */
export async function searchPool(
  apiUrl: string,
  jwt: string,
  refreshTokenValue: string,
  query: string,
  opts: PoolSearchOptions = {},
  onTokenRefresh?: (jwt: string, refreshToken: string) => void,
): Promise<PoolSearchHit[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const queryHash = hashQuery(trimmed.toLowerCase());
  const cached = readCache(queryHash);
  if (cached) {
    logger.debug({ query: trimmed.slice(0, 60) }, 'pool search cache hit');
    return cached;
  }

  const body = JSON.stringify({
    query: trimmed,
    limit: opts.limit ?? 10,
    types: opts.types,
    categories: opts.categories,
  });

  const doFetch = async (token: string): Promise<Response> => {
    return fetch(`${apiUrl}/v1/ck-memory/search`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  };

  let res = await doFetch(jwt).catch(() => null);
  if (res && res.status === 401 && refreshTokenValue) {
    try {
      const refreshed = await refreshToken(apiUrl, refreshTokenValue);
      if (onTokenRefresh) onTokenRefresh(refreshed.jwt, refreshed.refreshToken);
      res = await doFetch(refreshed.jwt).catch(() => null);
    } catch {
      return [];
    }
  }

  if (!res || !res.ok) return [];
  let hits: PoolSearchHit[];
  try {
    hits = (await res.json()) as PoolSearchHit[];
  } catch {
    return [];
  }
  if (!Array.isArray(hits)) return [];

  writeCache(queryHash, trimmed, hits);
  return hits;
}

/**
 * Build the prompt block for pool hits, mirroring the second-brain block
 * shape used in `agent.ts`. Returns an empty string if no hits.
 */
export function formatPoolContextBlock(hits: PoolSearchHit[], maxChars: number = 1500): string {
  if (hits.length === 0) return '';
  const lines: string[] = [];
  let total = 0;
  for (const h of hits) {
    const line = `- [${h.type}] ${h.summary}${h.detail ? ` — ${h.detail}` : ''}`;
    if (total + line.length + 1 > maxChars) break;
    lines.push(line);
    total += line.length + 1;
  }
  if (lines.length === 0) return '';
  return `[Shared Pool — auto-retrieved context]\n${lines.join('\n')}\n[End auto-retrieved context]`;
}

/**
 * Drop pool hits whose summary is near-duplicate of a local hit. Uses the
 * same overlap rule the agent's memory-engine uses (≥ 0.8 token overlap) so
 * we don't double-inject the same fact the second brain already surfaced.
 */
export function dedupeAgainstLocal(
  pool: PoolSearchHit[],
  localSummaries: string[],
  threshold: number = 0.8,
): PoolSearchHit[] {
  if (localSummaries.length === 0) return pool;
  const normalize = (s: string): Set<string> => {
    const terms = s.toLowerCase().split(/[^a-z0-9]+/i).filter((t) => t.length >= 3);
    return new Set(terms);
  };
  const localSets = localSummaries.map(normalize);
  return pool.filter((h) => {
    const poolSet = normalize(h.summary);
    if (poolSet.size === 0) return true;
    for (const localSet of localSets) {
      if (localSet.size === 0) continue;
      let overlap = 0;
      for (const t of poolSet) if (localSet.has(t)) overlap++;
      const score = overlap / Math.max(poolSet.size, localSet.size);
      if (score >= threshold) return false;
    }
    return true;
  });
}