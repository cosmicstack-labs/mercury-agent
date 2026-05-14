/**
 * Board Database Layer — Optimized Persistence with SQLite/JSON Fallback
 * 
 * Strategy:
 * - Primary: SQLite (if better-sqlite3 available) — fast queries, ACID, FTS
 * - Fallback: JSON file with write batching and debounce — works everywhere
 * 
 * The BoardManager can use this as its storage backend instead of raw JSON.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getMercuryHome } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { isBetterSqlite3Available } from '../memory/second-brain-db.js';
import type { Board, BoardCard, BoardContext, BoardContextEvent } from '../types/agent.js';

export interface BoardDB {
  loadAll(): Board[];
  saveBoard(board: Board): void;
  deleteBoard(id: string): void;
  getBoard(id: string): Board | undefined;
  saveContext(boardId: string, context: BoardContext): void;
  getContext(boardId: string): BoardContext | undefined;
  flush(): void;
}

// ── JSON Fallback (optimized with write debouncing) ──────────────

class JSONBoardDB implements BoardDB {
  private boards: Map<string, Board> = new Map();
  private contexts: Map<string, BoardContext> = new Map();
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly filePath: string;
  private readonly contextPath: string;

  constructor() {
    const dir = join(getMercuryHome(), 'memory');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.filePath = join(dir, 'boards.json');
    this.contextPath = join(dir, 'board-contexts.json');
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
}

// ── SQLite Backend (when available) ──────────────────────────────

class SQLiteBoardDB implements BoardDB {
  private db: any;

  constructor() {
    const dir = join(getMercuryHome(), 'memory');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, 'boards.db');

    // Dynamic require
    const { createRequire } = require('node:module');
    const req = createRequire(import.meta.url);
    const Database = req('better-sqlite3');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.initSchema();
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
}

// ── Factory ──────────────────────────────────────────────────────

let instance: BoardDB | null = null;

export function getBoardDB(): BoardDB {
  if (!instance) {
    if (isBetterSqlite3Available()) {
      try {
        instance = new SQLiteBoardDB();
        logger.info('Board DB: using SQLite backend');
      } catch (err) {
        logger.warn({ err }, 'Board DB: SQLite init failed, falling back to JSON');
        instance = new JSONBoardDB();
      }
    } else {
      instance = new JSONBoardDB();
      logger.info('Board DB: using JSON fallback (SQLite not available)');
    }
  }
  return instance;
}
