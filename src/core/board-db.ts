/**
 * Board Database Layer — Optimized Persistence with SQLite/JSON Fallback
 * 
 * Strategy:
 * - Primary: SQLite via the shared driver (better-sqlite3 → bun:sqlite →
 *   node:sqlite, see src/utils/sqlite-driver.ts) — fast queries, ACID
 * - Fallback: JSON file with write batching and debounce — works everywhere
 *
 * The BoardManager can use this as its storage backend instead of raw JSON.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getMercuryHome } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { isSqliteAvailable, openSqlite, type SqliteDatabase } from '../utils/sqlite-driver.js';
import type { Board, BoardCard, BoardContext, BoardContextEvent } from '../types/agent.js';

export const BOARDS_DB_FILE = 'boards.db';
export const BOARDS_JSON_FILE = 'boards.json';
export const BOARD_CONTEXTS_JSON_FILE = 'board-contexts.json';

export interface BoardDB {
  /** `sqlite` (any engine) or `json`. */
  readonly kind: 'sqlite' | 'json';
  loadAll(): Board[];
  saveBoard(board: Board): void;
  deleteBoard(id: string): void;
  getBoard(id: string): Board | undefined;
  saveContext(boardId: string, context: BoardContext): void;
  getContext(boardId: string): BoardContext | undefined;
  flush(): void;
  /** Release file handles (SQLite) after a final flush. Safe to call twice. */
  close(): void;
}

// ── JSON Fallback (optimized with write debouncing) ──────────────

class JSONBoardDB implements BoardDB {
  readonly kind = 'json' as const;
  private boards: Map<string, Board> = new Map();
  private contexts: Map<string, BoardContext> = new Map();
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly filePath: string;
  private readonly contextPath: string;

  constructor() {
    const dir = join(getMercuryHome(), 'memory');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.filePath = join(dir, BOARDS_JSON_FILE);
    this.contextPath = join(dir, BOARD_CONTEXTS_JSON_FILE);
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    if (existsSync(this.filePath)) {
      try {
        const data = JSON.parse(readFileSync(this.filePath, 'utf-8'));
        for (const board of data.boards || []) {
          this.boards.set(board.id, board);
        }
      } catch (err) {
        logger.warn({ err }, 'Failed to load boards JSON');
      }
    }
    if (existsSync(this.contextPath)) {
      try {
        const data = JSON.parse(readFileSync(this.contextPath, 'utf-8'));
        for (const [id, ctx] of Object.entries(data)) {
          this.contexts.set(id, ctx as BoardContext);
        }
      } catch {}
    }
  }

  loadAll(): Board[] {
    return [...this.boards.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  saveBoard(board: Board): void {
    this.boards.set(board.id, board);
    this.scheduleDiskWrite();
  }

  deleteBoard(id: string): void {
    this.boards.delete(id);
    this.contexts.delete(id);
    this.scheduleDiskWrite();
  }

  getBoard(id: string): Board | undefined {
    return this.boards.get(id);
  }

  saveContext(boardId: string, context: BoardContext): void {
    this.contexts.set(boardId, context);
    this.scheduleDiskWrite();
  }

  getContext(boardId: string): BoardContext | undefined {
    return this.contexts.get(boardId);
  }

  private scheduleDiskWrite(): void {
    this.dirty = true;
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flush();
        this.flushTimer = null;
      }, 500); // Debounce 500ms
    }
  }

  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;

    // Write boards
    const data = { boards: [...this.boards.values()] };
    writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8');

    // Write contexts separately (keeps boards.json clean)
    const ctxData: Record<string, BoardContext> = {};
    for (const [id, ctx] of this.contexts) {
      ctxData[id] = ctx;
    }
    writeFileSync(this.contextPath, JSON.stringify(ctxData, null, 2), 'utf-8');
  }

  close(): void {
    this.flush();
  }
}

// ── SQLite Backend (when available) ──────────────────────────────

class SQLiteBoardDB implements BoardDB {
  readonly kind = 'sqlite' as const;
  private db: SqliteDatabase;

  constructor() {
    const dir = join(getMercuryHome(), 'memory');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, BOARDS_DB_FILE);

    const db = openSqlite(dbPath);
    if (!db) throw new Error('No SQLite engine available');
    this.db = db;
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.initSchema();
  }

  /** Engine backing this database (`better-sqlite3`, `bun:sqlite`, `node:sqlite`). */
  get backend(): string {
    return this.db.backend;
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS boards (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS board_contexts (
        board_id TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_boards_updated ON boards(updated_at DESC);
    `);
  }

  loadAll(): Board[] {
    const rows = this.db.prepare('SELECT data FROM boards ORDER BY updated_at DESC').all();
    return rows.map((r: any) => JSON.parse(r.data));
  }

  saveBoard(board: Board): void {
    this.db.prepare('INSERT OR REPLACE INTO boards (id, data, updated_at) VALUES (?, ?, ?)').run(
      board.id, JSON.stringify(board), board.updatedAt
    );
  }

  deleteBoard(id: string): void {
    this.db.prepare('DELETE FROM boards WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM board_contexts WHERE board_id = ?').run(id);
  }

  getBoard(id: string): Board | undefined {
    const row = this.db.prepare('SELECT data FROM boards WHERE id = ?').get(id);
    return row ? JSON.parse((row as any).data) : undefined;
  }

  saveContext(boardId: string, context: BoardContext): void {
    this.db.prepare('INSERT OR REPLACE INTO board_contexts (board_id, data) VALUES (?, ?)').run(
      boardId, JSON.stringify(context)
    );
  }

  getContext(boardId: string): BoardContext | undefined {
    const row = this.db.prepare('SELECT data FROM board_contexts WHERE board_id = ?').get(boardId);
    return row ? JSON.parse((row as any).data) : undefined;
  }

  flush(): void {
    // SQLite is already durable per write
  }

  close(): void {
    this.db.close();
  }
}

// ── Factory ──────────────────────────────────────────────────────

let instance: BoardDB | null = null;

/**
 * Build a fresh BoardDB for the current `MERCURY_HOME`: SQLite when any
 * engine is available, JSON otherwise. `getBoardDB()` memoizes one instance.
 */
export function createBoardDB(): BoardDB {
  if (isSqliteAvailable()) {
    try {
      const db = new SQLiteBoardDB();
      logger.info({ backend: db.backend }, 'Board DB: using SQLite backend');
      return db;
    } catch (err) {
      logger.warn({ err }, 'Board DB: SQLite init failed, falling back to JSON');
      return new JSONBoardDB();
    }
  }
  logger.info('Board DB: using JSON fallback (SQLite not available)');
  return new JSONBoardDB();
}

export function getBoardDB(): BoardDB {
  if (!instance) instance = createBoardDB();
  return instance;
}
