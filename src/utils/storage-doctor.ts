/**
 * `mercury doctor --storage` — which SQLite engine is active, where each
 * store lives, how many rows it holds, and a loud warning when storage is
 * JSON-only (Second Brain disabled; bots and boards on JSON files).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { getMercuryHome } from './config.js';
import {
  SQLITE_BACKEND_ENV,
  describeSqliteBackend,
  openSqlite,
  type SqliteBackendDescription,
  type SqliteDatabase,
} from './sqlite-driver.js';

export type StorageMode = 'sqlite' | 'json' | 'disabled';

export interface StorageSubsystemReport {
  id: 'second-brain' | 'bots-queue' | 'boards' | 'pool-search-cache';
  label: string;
  mode: StorageMode;
  /** Files this subsystem reads/writes in the current mode. */
  paths: string[];
  /** True when at least one of `paths` exists on disk. */
  exists: boolean;
  /** Bytes on disk across `paths` (0 when nothing exists). */
  bytes: number;
  /** Row / record counts per table or collection, when readable. */
  counts: Record<string, number>;
  /** Why counts could not be read. */
  error?: string;
}

export interface StorageReport {
  home: string;
  backend: SqliteBackendDescription;
  /** No SQLite engine: Second Brain is off, bots and boards use JSON files. */
  jsonOnly: boolean;
  subsystems: StorageSubsystemReport[];
}

export interface CollectStorageOptions {
  /** Mercury home to inspect (defaults to `getMercuryHome()`). */
  home?: string;
  /** Probe every engine, not just the active one. */
  probeAll?: boolean;
}

// File names mirror the owners: second-brain-db / user-memory, bots/queue,
// core/board-db, cloud/pool-search. Kept as literals here so the doctor never
// has to import (and initialise) those modules.
const SECOND_BRAIN_DB = ['memory', 'second-brain', 'second-brain.db'];
const QUEUE_DB = ['bots', 'queue.db'];
const QUEUE_JSON = ['bots', 'queue.json'];
const BOARDS_DB = ['memory', 'boards.db'];
const BOARDS_JSON = ['memory', 'boards.json'];
const BOARD_CONTEXTS_JSON = ['memory', 'board-contexts.json'];
const POOL_CACHE_DB = ['memory', 'pool-search-cache.db'];

function sizeOf(paths: string[]): { exists: boolean; bytes: number } {
  let exists = false;
  let bytes = 0;
  for (const path of paths) {
    try {
      const stat = statSync(path);
      exists = true;
      bytes += stat.size;
    } catch { /* missing */ }
  }
  return { exists, bytes };
}

function withSqlite<T>(path: string, fn: (db: SqliteDatabase) => T): { value?: T; error?: string } {
  let db: SqliteDatabase | null = null;
  try {
    db = openSqlite(path);
    if (!db) return { error: 'no SQLite engine available' };
    return { value: fn(db) };
  } catch (err) {
    return { error: err instanceof Error ? err.message.split('\n')[0] : String(err) };
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

/** Count rows per table, skipping tables that do not exist yet. */
function countTables(db: SqliteDatabase, specs: Array<{ table: string; label: string; where?: string }>): Record<string, number> {
  const present = new Set(
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all<{ name: string }>().map((row) => row.name),
  );
  const counts: Record<string, number> = {};
  for (const spec of specs) {
    if (!present.has(spec.table)) continue;
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${spec.table}${spec.where ? ` WHERE ${spec.where}` : ''}`).get<{ count: number }>();
    counts[spec.label] = Number(row?.count ?? 0);
  }
  return counts;
}

function readJson(path: string): any | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return undefined;
  }
}

function secondBrain(home: string, sqlite: boolean): StorageSubsystemReport {
  const path = join(home, ...SECOND_BRAIN_DB);
  const base = { id: 'second-brain' as const, label: 'Second Brain memory', paths: [path], ...sizeOf([path]), counts: {} };
  if (!sqlite) return { ...base, mode: 'disabled' };
  if (!base.exists) return { ...base, mode: 'sqlite' };
  const { value, error } = withSqlite(path, (db) => countTables(db, [
    { table: 'memories', label: 'memories' },
    { table: 'memories', label: 'memories (active)', where: 'dismissed = 0' },
    { table: 'persons', label: 'persons' },
    { table: 'person_relationships', label: 'relationships' },
  ]));
  return { ...base, mode: 'sqlite', counts: value ?? {}, ...(error ? { error } : {}) };
}

function botsQueue(home: string, sqlite: boolean): StorageSubsystemReport {
  if (sqlite) {
    const path = join(home, ...QUEUE_DB);
    const base = { id: 'bots-queue' as const, label: 'Bots job queue', paths: [path], ...sizeOf([path]), counts: {} };
    if (!base.exists) return { ...base, mode: 'sqlite' };
    const { value, error } = withSqlite(path, (db) => countTables(db, [
      { table: 'bot_jobs', label: 'jobs (pending)', where: `state = 'pending'` },
      { table: 'bot_jobs', label: 'jobs (claimed)', where: `state = 'claimed'` },
      { table: 'bot_dlq', label: 'dead-letter' },
      { table: 'bot_mail', label: 'mail' },
    ]));
    return { ...base, mode: 'sqlite', counts: value ?? {}, ...(error ? { error } : {}) };
  }
  const path = join(home, ...QUEUE_JSON);
  const base = { id: 'bots-queue' as const, label: 'Bots job queue', paths: [path], ...sizeOf([path]), counts: {} };
  if (!base.exists) return { ...base, mode: 'json' };
  const data = readJson(path);
  if (!data) return { ...base, mode: 'json', error: 'queue.json is not valid JSON' };
  const jobs: any[] = Array.isArray(data.jobs) ? data.jobs : [];
  return {
    ...base,
    mode: 'json',
    counts: {
      'jobs (pending)': jobs.filter((j) => j?.state === 'pending').length,
      'jobs (claimed)': jobs.filter((j) => j?.state === 'claimed').length,
      'dead-letter': Array.isArray(data.dlq) ? data.dlq.length : 0,
      mail: Array.isArray(data.mails) ? data.mails.length : 0,
    },
  };
}

function boards(home: string, sqlite: boolean): StorageSubsystemReport {
  if (sqlite) {
    const path = join(home, ...BOARDS_DB);
    const base = { id: 'boards' as const, label: 'Boards', paths: [path], ...sizeOf([path]), counts: {} };
    if (!base.exists) return { ...base, mode: 'sqlite' };
    const { value, error } = withSqlite(path, (db) => countTables(db, [
      { table: 'boards', label: 'boards' },
      { table: 'board_contexts', label: 'contexts' },
    ]));
    return { ...base, mode: 'sqlite', counts: value ?? {}, ...(error ? { error } : {}) };
  }
  const boardsPath = join(home, ...BOARDS_JSON);
  const contextsPath = join(home, ...BOARD_CONTEXTS_JSON);
  const paths = [boardsPath, contextsPath];
  const base = { id: 'boards' as const, label: 'Boards', paths, ...sizeOf(paths), counts: {} };
  if (!base.exists) return { ...base, mode: 'json' };
  const boardsData = existsSync(boardsPath) ? readJson(boardsPath) : { boards: [] };
  const contextsData = existsSync(contextsPath) ? readJson(contextsPath) : {};
  return {
    ...base,
    mode: 'json',
    counts: {
      boards: Array.isArray(boardsData?.boards) ? boardsData.boards.length : 0,
      contexts: contextsData && typeof contextsData === 'object' ? Object.keys(contextsData).length : 0,
    },
  };
}

function poolSearchCache(home: string, sqlite: boolean): StorageSubsystemReport {
  const path = join(home, ...POOL_CACHE_DB);
  const base = { id: 'pool-search-cache' as const, label: 'Cloud pool search cache', paths: [path], ...sizeOf([path]), counts: {} };
  if (!sqlite) return { ...base, mode: 'disabled' };
  if (!base.exists) return { ...base, mode: 'sqlite' };
  const { value, error } = withSqlite(path, (db) => countTables(db, [{ table: 'pool_search_cache', label: 'cached queries' }]));
  return { ...base, mode: 'sqlite', counts: value ?? {}, ...(error ? { error } : {}) };
}

export function collectStorageReport(options: CollectStorageOptions = {}): StorageReport {
  const home = options.home ?? getMercuryHome();
  const backend = describeSqliteBackend({ probeAll: options.probeAll });
  const sqlite = backend.backend !== null;
  return {
    home,
    backend,
    jsonOnly: !sqlite,
    subsystems: [
      secondBrain(home, sqlite),
      botsQueue(home, sqlite),
      boards(home, sqlite),
      poolSearchCache(home, sqlite),
    ],
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Fix hint for a JSON-only install, tailored to the runtime we are on. */
export function jsonOnlyFixHint(report: StorageReport): string[] {
  const { backend } = report;
  if (backend.override) {
    return [`${SQLITE_BACKEND_ENV}=${backend.override} is set — unset it to let Mercury pick an engine.`];
  }
  if (backend.runtime === 'bun') {
    return ['bun:sqlite should always load under Bun; this binary may be corrupted — reinstall with the install script.'];
  }
  const [major = 0, minor = 0] = backend.runtimeVersion.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const hints: string[] = [];
  if (major < 22 || (major === 22 && minor < 13)) {
    hints.push('Upgrade to Node 22.13+ (built-in node:sqlite, no compiler needed), or');
  }
  hints.push('install build tools (make, gcc/g++, python3) and run: npm rebuild better-sqlite3');
  hints.push('or install the standalone binary (ships bun:sqlite): https://mercuryagent.sh');
  return hints;
}

/** Terminal rendering for `mercury doctor --storage`. */
export function formatStorageReport(report: StorageReport): string[] {
  const lines: string[] = [];
  const { backend } = report;
  lines.push('');
  lines.push(chalk.bold.cyan('  Mercury Storage Doctor'));
  lines.push(chalk.dim('  SQLite backend, database files and row counts'));
  lines.push('');
  lines.push(`  Runtime:            ${chalk.white(`${backend.runtime} ${backend.runtimeVersion}`)}`);
  lines.push(`  Home:               ${chalk.dim(report.home)}`);
  const active = backend.candidates.find((c) => c.status === 'active');
  lines.push(`  SQLite backend:     ${backend.backend
    ? chalk.green(backend.backend) + chalk.dim(active?.sqliteVersion ? ` (SQLite ${active.sqliteVersion}${active.providerVersion ? `, ${active.providerVersion}` : ''})` : '')
    : chalk.red('none — storage is JSON-only')}`);
  if (backend.override) {
    lines.push(`  Override:           ${chalk.yellow(`${SQLITE_BACKEND_ENV}=${backend.override}`)}`);
  }
  for (const candidate of backend.candidates) {
    const status = candidate.status === 'active'
      ? chalk.green('active')
      : candidate.status === 'available'
        ? chalk.white('available')
        : candidate.status === 'unavailable'
          ? chalk.yellow('unavailable')
          : chalk.dim('not probed');
    const reason = candidate.reason ? chalk.dim(` — ${candidate.reason}`) : '';
    lines.push(`    • ${candidate.name.padEnd(15)} ${status}${reason}`);
  }
  lines.push('');
  lines.push(chalk.bold.white('  Stores'));
  for (const sub of report.subsystems) {
    const mode = sub.mode === 'sqlite'
      ? chalk.green('sqlite')
      : sub.mode === 'json'
        ? chalk.yellow('json')
        : chalk.red('disabled');
    lines.push(`  ${sub.label.padEnd(26)} ${mode}`);
    for (const path of sub.paths) {
      const present = existsSync(path);
      lines.push(`    ${chalk.dim(path)}${present ? '' : chalk.dim('  (not created yet)')}`);
    }
    if (sub.exists) lines.push(`    size: ${chalk.white(formatBytes(sub.bytes))}`);
    const entries = Object.entries(sub.counts);
    if (entries.length > 0) {
      lines.push(`    rows: ${entries.map(([label, count]) => `${label} ${chalk.white(String(count))}`).join(chalk.dim(' · '))}`);
    }
    if (sub.error) lines.push(`    ${chalk.yellow(`could not read: ${sub.error}`)}`);
  }
  lines.push('');
  if (report.jsonOnly) {
    lines.push(chalk.yellow('  Warning: storage is JSON-only — no SQLite engine could be loaded.'));
    lines.push(chalk.yellow('  Second Brain memory and the cloud pool-search cache are DISABLED;'));
    lines.push(chalk.yellow('  bots and boards persist to JSON files (slower, no concurrent-writer safety).'));
    for (const hint of jsonOnlyFixHint(report)) lines.push(chalk.dim(`  Fix: ${hint}`));
    lines.push('');
  }
  return lines;
}

export function runStorageDoctor(): void {
  const report = collectStorageReport({ probeAll: true });
  for (const line of formatStorageReport(report)) console.log(line);
}
