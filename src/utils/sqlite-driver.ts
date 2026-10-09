/**
 * Shared synchronous SQLite driver (ROADMAP P1.9, ADR-018).
 *
 * One probe, one API, three backends in priority order:
 *
 *   1. `better-sqlite3`  — native addon; the npm-install default when a
 *                           toolchain (or a prebuilt binary) is available.
 *   2. `bun:sqlite`      — built into the Bun runtime; what the standalone
 *                           binaries (`bun build --compile`) use, since they
 *                           cannot ship better-sqlite3's native addon.
 *   3. `node:sqlite`     — built into Node >= 22.5 (unflagged in 22.13 / 23.4);
 *                           toolchain-less npm installs and Termux.
 *   4. none              — callers fall back to JSON files exactly as before.
 *
 * The API is the subset of better-sqlite3 the call sites already use
 * (`prepare().run/get/all`, `exec`, `pragma`, `transaction`, `close`), with
 * positional varargs or one bare-keyed object for `@name`/`:name`/`$name`
 * placeholders. On the better-sqlite3 path statements are handed through
 * untouched, so behaviour there is byte-for-byte what it was.
 *
 * Differences between the engines that this module papers over:
 *   - bun:sqlite requires the prefix on named keys (`{ '@id': 1 }`) and
 *     silently binds NULL for bare keys; `get()` returns `null` on a miss;
 *     `run().changes` is a total_changes() delta that includes trigger
 *     writes (the FTS5 sync triggers make 2 updated rows report 14), so the
 *     adapter reads SQLite's own `changes()` instead.
 *   - node:sqlite rejects `undefined` and boolean bindings, throws on named
 *     keys the SQL does not mention, returns null-prototype rows, has no
 *     `transaction()` helper, and throws on a second `close()`.
 *
 * `MERCURY_SQLITE_BACKEND=better-sqlite3|bun:sqlite|node:sqlite|json` forces
 * one backend (or none); anything else is ignored.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export type SqliteBackendName = 'better-sqlite3' | 'bun:sqlite' | 'node:sqlite';

export const SQLITE_BACKEND_PRIORITY: readonly SqliteBackendName[] = ['better-sqlite3', 'bun:sqlite', 'node:sqlite'];

export const SQLITE_BACKEND_ENV = 'MERCURY_SQLITE_BACKEND';

export type SqliteBindValue = string | number | bigint | Uint8Array | null | undefined | boolean;
export type SqliteNamedParams = Record<string, SqliteBindValue>;

export interface SqliteRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface SqliteStatement {
  /** Positional varargs (`run(a, b)`) or one object for named placeholders (`run({ id })`). */
  run(...params: any[]): SqliteRunResult;
  get<T = any>(...params: any[]): T | undefined;
  all<T = any>(...params: any[]): T[];
}

export interface SqliteDatabase {
  readonly backend: SqliteBackendName;
  readonly path: string;
  readonly open: boolean;
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  /** `pragma('journal_mode = WAL')` → rows, as better-sqlite3's non-simple mode returns them. */
  pragma(source: string): any[];
  /** Runs `fn` inside a transaction (savepoint when nested); rolls back and rethrows on throw. */
  transaction<T>(fn: () => T): T;
  /** Idempotent. */
  close(): void;
}

export interface OpenSqliteOptions {
  /** Force one backend for this handle (tests, doctor). Overrides the env var. */
  backend?: SqliteBackendName;
}

export type SqliteCandidateStatus = 'active' | 'available' | 'unavailable' | 'skipped';

export interface SqliteCandidateReport {
  name: SqliteBackendName;
  status: SqliteCandidateStatus;
  /** Why it is unavailable or skipped. */
  reason?: string;
  /** `sqlite_version()` as reported by the engine, when probed successfully. */
  sqliteVersion?: string;
  /** Package / runtime version that provides the engine. */
  providerVersion?: string;
}

export interface SqliteBackendDescription {
  /** The backend `openSqlite()` will use, or `null` when storage is JSON-only. */
  backend: SqliteBackendName | null;
  runtime: 'bun' | 'node';
  runtimeVersion: string;
  /** Value of `MERCURY_SQLITE_BACKEND` when it influenced selection. */
  override: string | null;
  candidates: SqliteCandidateReport[];
}

// ---------------------------------------------------------------------------
// Backend adapters
// ---------------------------------------------------------------------------

interface BackendAdapter {
  name: SqliteBackendName;
  /** Throws when the engine cannot be loaded or cannot open a database. */
  load(): void;
  open(path: string): SqliteDatabase;
  providerVersion(): string | undefined;
}

type ProbeResult = { ok: true; sqliteVersion?: string; providerVersion?: string } | { ok: false; reason: string };

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message.split('\n')[0];
  return String(err);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Coerce values the portable engines refuse: `undefined` → NULL, booleans → 0/1. */
function normalizeValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

const NAMED_PARAM_RE = /[@:$]([A-Za-z_][A-Za-z0-9_]*)/g;
const namedParamCache = new Map<string, Map<string, string>>();

/** Map bare name → token as written in the SQL (`id` → `@id`), ignoring string literals and quoted identifiers. */
function namedTokensFor(sql: string): Map<string, string> {
  let tokens = namedParamCache.get(sql);
  if (tokens) return tokens;
  tokens = new Map();
  const stripped = sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of stripped.matchAll(NAMED_PARAM_RE)) {
    if (!tokens.has(match[1])) tokens.set(match[1], match[0]);
  }
  if (namedParamCache.size > 512) namedParamCache.clear();
  namedParamCache.set(sql, tokens);
  return tokens;
}

/**
 * Turn the caller's parameters into what bun:sqlite / node:sqlite accept:
 * positional → normalized array; one plain object → `{ '@name': value }` for
 * every placeholder in the SQL (missing names throw, like better-sqlite3;
 * extra keys are ignored, like better-sqlite3).
 */
function portableParams(sql: string, params: any[]): any[] {
  if (params.length === 1 && isPlainObject(params[0])) {
    const source = params[0];
    const bound: Record<string, unknown> = {};
    for (const [name, token] of namedTokensFor(sql)) {
      const value = name in source ? source[name] : source[token];
      if (value === undefined && !(name in source) && !(token in source)) {
        throw new RangeError(`Missing named parameter "${name}"`);
      }
      bound[token] = normalizeValue(value);
    }
    return [bound];
  }
  return params.map(normalizeValue);
}

// ── better-sqlite3 (pass-through) ───────────────────────────────────────────

type BetterSqlite3Ctor = typeof import('better-sqlite3');

class BetterSqlite3Database implements SqliteDatabase {
  readonly backend = 'better-sqlite3' as const;
  private raw: import('better-sqlite3').Database;

  constructor(ctor: BetterSqlite3Ctor, readonly path: string) {
    this.raw = new ctor(path);
  }

  get open(): boolean { return this.raw.open; }
  prepare(sql: string): SqliteStatement { return this.raw.prepare(sql) as unknown as SqliteStatement; }
  exec(sql: string): void { this.raw.exec(sql); }
  pragma(source: string): any[] { return this.raw.pragma(source) as any[]; }
  transaction<T>(fn: () => T): T { return this.raw.transaction(fn)(); }
  close(): void { this.raw.close(); }
}

let betterSqlite3Ctor: BetterSqlite3Ctor | null = null;

const betterSqlite3Adapter: BackendAdapter = {
  name: 'better-sqlite3',
  load() {
    if (betterSqlite3Ctor) return;
    const mod = require('better-sqlite3') as BetterSqlite3Ctor;
    // A file-backed probe (not :memory:) is what catches a missing or
    // ABI-mismatched native addon — same probe the call sites used to run.
    const probeDir = join(tmpdir(), `mercury-sqlite3-probe-${process.pid}`);
    try {
      mkdirSync(probeDir, { recursive: true });
      const probe = new mod(join(probeDir, 'probe.db'));
      probe.close();
    } finally {
      rmSync(probeDir, { recursive: true, force: true });
    }
    betterSqlite3Ctor = mod;
  },
  open(path) {
    if (!betterSqlite3Ctor) this.load();
    return new BetterSqlite3Database(betterSqlite3Ctor!, path);
  },
  providerVersion() {
    try { return String((require('better-sqlite3/package.json') as { version?: string }).version ?? ''); } catch { return undefined; }
  },
};

// ── Portable base (bun:sqlite / node:sqlite share the binding rules) ────────

abstract class PortableDatabase implements SqliteDatabase {
  abstract readonly backend: SqliteBackendName;
  protected closed = false;
  private depth = 0;

  constructor(readonly path: string) {}

  get open(): boolean { return !this.closed; }
  abstract prepare(sql: string): SqliteStatement;
  abstract exec(sql: string): void;
  protected abstract rawClose(): void;

  pragma(source: string): any[] {
    return this.prepare(`PRAGMA ${source}`).all();
  }

  transaction<T>(fn: () => T): T {
    const nested = this.depth > 0;
    const savepoint = `mercury_sp_${this.depth}`;
    this.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN');
    this.depth++;
    try {
      const result = fn();
      this.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
      return result;
    } catch (err) {
      try { this.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    } finally {
      this.depth--;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rawClose();
  }
}

// ── bun:sqlite ──────────────────────────────────────────────────────────────

interface BunStatementLike {
  run(...params: any[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: any[]): any;
  all(...params: any[]): any[];
}
interface BunDatabaseLike {
  prepare(sql: string): BunStatementLike;
  exec?(sql: string): unknown;
  run(sql: string): unknown;
  close(): void;
}
type BunDatabaseCtor = new (path: string, options?: Record<string, unknown>) => BunDatabaseLike;

class BunStatement implements SqliteStatement {
  constructor(
    private readonly stmt: BunStatementLike,
    private readonly sql: string,
    private readonly changesSinceRun: () => number,
  ) {}
  run(...params: any[]): SqliteRunResult {
    const result = this.stmt.run(...portableParams(this.sql, params));
    // Bun reports a total_changes() delta (trigger writes included); callers
    // expect sqlite3_changes() like better-sqlite3 and node:sqlite return.
    return { changes: this.changesSinceRun(), lastInsertRowid: result?.lastInsertRowid ?? 0 };
  }
  get<T = any>(...params: any[]): T | undefined {
    const row = this.stmt.get(...portableParams(this.sql, params));
    return row === null ? undefined : (row as T);
  }
  all<T = any>(...params: any[]): T[] {
    return this.stmt.all(...portableParams(this.sql, params)) as T[];
  }
}

class BunDatabase extends PortableDatabase {
  readonly backend = 'bun:sqlite' as const;
  private raw: BunDatabaseLike;
  private changesStmt: BunStatementLike | null = null;

  constructor(ctor: BunDatabaseCtor, path: string) {
    super(path);
    this.raw = new ctor(path, { create: true, readwrite: true });
  }

  private readonly changesSinceRun = (): number => {
    this.changesStmt ??= this.raw.prepare('SELECT changes() AS c');
    return Number(this.changesStmt.get()?.c ?? 0);
  };

  prepare(sql: string): SqliteStatement { return new BunStatement(this.raw.prepare(sql), sql, this.changesSinceRun); }
  exec(sql: string): void {
    if (typeof this.raw.exec === 'function') this.raw.exec(sql);
    else this.raw.run(sql);
  }
  protected rawClose(): void { this.raw.close(); }
}

let bunDatabaseCtor: BunDatabaseCtor | null = null;

const bunSqliteAdapter: BackendAdapter = {
  name: 'bun:sqlite',
  load() {
    if (bunDatabaseCtor) return;
    if (!process.versions.bun) throw new Error('not running under Bun');
    // Dynamic require keeps tsup/tsc from trying to resolve the Bun builtin.
    const mod = require('bun:sqlite') as { Database: BunDatabaseCtor };
    const probe = new mod.Database(':memory:');
    probe.close();
    bunDatabaseCtor = mod.Database;
  },
  open(path) {
    if (!bunDatabaseCtor) this.load();
    return new BunDatabase(bunDatabaseCtor!, path);
  },
  providerVersion() { return process.versions.bun ? `bun ${process.versions.bun}` : undefined; },
};

// ── node:sqlite ─────────────────────────────────────────────────────────────

interface NodeStatementLike {
  run(...params: any[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: any[]): any;
  all(...params: any[]): any[];
}
interface NodeDatabaseLike {
  prepare(sql: string): NodeStatementLike;
  exec(sql: string): void;
  close(): void;
}
type NodeDatabaseCtor = new (path: string, options?: Record<string, unknown>) => NodeDatabaseLike;

/** node:sqlite rows are null-prototype objects; hand callers ordinary ones. */
function plainRow<T>(row: any): T {
  return (row && Object.getPrototypeOf(row) === null ? Object.assign({}, row) : row) as T;
}

class NodeStatement implements SqliteStatement {
  constructor(private readonly stmt: NodeStatementLike, private readonly sql: string) {}
  run(...params: any[]): SqliteRunResult {
    const result = this.stmt.run(...portableParams(this.sql, params));
    return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
  }
  get<T = any>(...params: any[]): T | undefined {
    const row = this.stmt.get(...portableParams(this.sql, params));
    return row === undefined || row === null ? undefined : plainRow<T>(row);
  }
  all<T = any>(...params: any[]): T[] {
    return this.stmt.all(...portableParams(this.sql, params)).map((row) => plainRow<T>(row));
  }
}

class NodeDatabase extends PortableDatabase {
  readonly backend = 'node:sqlite' as const;
  private raw: NodeDatabaseLike;

  constructor(ctor: NodeDatabaseCtor, path: string) {
    super(path);
    this.raw = new ctor(path);
  }

  prepare(sql: string): SqliteStatement { return new NodeStatement(this.raw.prepare(sql), sql); }
  exec(sql: string): void { this.raw.exec(sql); }
  protected rawClose(): void { this.raw.close(); }
}

let nodeDatabaseCtor: NodeDatabaseCtor | null = null;

export function nodeSupportsBuiltinSqlite(version: string = process.versions.node): boolean {
  const [major = 0, minor = 0] = version.split('.').map((part) => Number.parseInt(part, 10) || 0);
  return major > 22 || (major === 22 && minor >= 5);
}

const nodeSqliteAdapter: BackendAdapter = {
  name: 'node:sqlite',
  load() {
    if (nodeDatabaseCtor) return;
    if (process.versions.bun) throw new Error('not available under Bun (bun:sqlite is used instead)');
    if (!nodeSupportsBuiltinSqlite()) {
      throw new Error(`Node ${process.versions.node} has no node:sqlite (needs >= 22.5; unflagged in 22.13 / 23.4)`);
    }
    // Node 22.5–22.12 only expose it behind --experimental-sqlite; the require
    // throws ERR_UNKNOWN_BUILTIN_MODULE there and the probe reports it.
    const mod = require('node:sqlite') as { DatabaseSync: NodeDatabaseCtor };
    const probe = new mod.DatabaseSync(':memory:');
    probe.close();
    nodeDatabaseCtor = mod.DatabaseSync;
  },
  open(path) {
    if (!nodeDatabaseCtor) this.load();
    return new NodeDatabase(nodeDatabaseCtor!, path);
  },
  providerVersion() { return `node ${process.versions.node}`; },
};

const ADAPTERS: Record<SqliteBackendName, BackendAdapter> = {
  'better-sqlite3': betterSqlite3Adapter,
  'bun:sqlite': bunSqliteAdapter,
  'node:sqlite': nodeSqliteAdapter,
};

// ---------------------------------------------------------------------------
// Probing and selection
// ---------------------------------------------------------------------------

const probeResults = new Map<SqliteBackendName, ProbeResult>();
let selected: SqliteBackendName | null | undefined;
let selectionOverride: string | null = null;

function probe(name: SqliteBackendName): ProbeResult {
  const cached = probeResults.get(name);
  if (cached) return cached;
  const adapter = ADAPTERS[name];
  let result: ProbeResult;
  try {
    adapter.load();
    let sqliteVersion: string | undefined;
    try {
      const db = adapter.open(':memory:');
      try {
        sqliteVersion = db.prepare('SELECT sqlite_version() AS v').get<{ v: string }>()?.v;
      } finally {
        db.close();
      }
    } catch { /* version is informational */ }
    result = { ok: true, sqliteVersion, providerVersion: adapter.providerVersion() };
  } catch (err) {
    result = { ok: false, reason: errorMessage(err) };
  }
  probeResults.set(name, result);
  return result;
}

export function isSqliteBackendName(value: unknown): value is SqliteBackendName {
  return value === 'better-sqlite3' || value === 'bun:sqlite' || value === 'node:sqlite';
}

function readOverride(): { backend: SqliteBackendName | 'none' | null; raw: string | null } {
  const raw = process.env[SQLITE_BACKEND_ENV]?.trim() || null;
  if (!raw) return { backend: null, raw: null };
  const lowered = raw.toLowerCase();
  if (isSqliteBackendName(lowered)) return { backend: lowered, raw };
  if (lowered === 'json' || lowered === 'none' || lowered === 'off') return { backend: 'none', raw };
  return { backend: null, raw: null };
}

function select(): SqliteBackendName | null {
  if (selected !== undefined) return selected;
  const override = readOverride();
  selectionOverride = override.raw;
  if (override.backend === 'none') {
    selected = null;
  } else if (override.backend) {
    selected = probe(override.backend).ok ? override.backend : null;
  } else {
    selected = null;
    for (const name of SQLITE_BACKEND_PRIORITY) {
      if (probe(name).ok) { selected = name; break; }
    }
  }
  return selected;
}

/** The backend `openSqlite()` will use, or `null` when storage is JSON-only. */
export function getSqliteBackend(): SqliteBackendName | null {
  return select();
}

export function isSqliteAvailable(): boolean {
  return select() !== null;
}

/**
 * Open (creating if needed) a database at `path`. Returns `null` when no
 * SQLite engine is available so the caller can fall back to JSON; throws
 * when an engine is available but the file cannot be opened.
 */
export function openSqlite(path: string, options: OpenSqliteOptions = {}): SqliteDatabase | null {
  const name = options.backend ?? select();
  if (!name) return null;
  if (options.backend && !probe(options.backend).ok) return null;
  return ADAPTERS[name].open(path);
}

/**
 * Full report for `mercury doctor --storage` and tests. By default only the
 * candidates the selection touched are probed; `probeAll` probes the rest
 * (loading node:sqlite on Node 22 prints its ExperimentalWarning once).
 */
export function describeSqliteBackend(options: { probeAll?: boolean } = {}): SqliteBackendDescription {
  const active = select();
  const candidates: SqliteCandidateReport[] = SQLITE_BACKEND_PRIORITY.map((name) => {
    if (options.probeAll && !probeResults.has(name)) probe(name);
    const result = probeResults.get(name);
    if (!result) return { name, status: 'skipped', reason: 'not probed (a higher-priority backend is active)' };
    if (!result.ok) return { name, status: 'unavailable', reason: result.reason };
    return {
      name,
      status: name === active ? 'active' : 'available',
      sqliteVersion: result.sqliteVersion,
      providerVersion: result.providerVersion,
      ...(name !== active && selectionOverride ? { reason: `not selected: ${SQLITE_BACKEND_ENV}=${selectionOverride}` } : {}),
    };
  });
  return {
    backend: active,
    runtime: process.versions.bun ? 'bun' : 'node',
    runtimeVersion: process.versions.bun ? process.versions.bun : process.versions.node,
    override: selectionOverride,
    candidates,
  };
}

/** Forget probe results and the selection (tests toggle the env override). Loaded engines stay loaded. */
export function resetSqliteDriverForTests(): void {
  probeResults.clear();
  selected = undefined;
  selectionOverride = null;
}
