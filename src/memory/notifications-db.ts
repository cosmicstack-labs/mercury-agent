import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { logger } from '../utils/logger.js';

type BetterSqlite3Database = import('better-sqlite3').Database;

const require = createRequire(import.meta.url);

let syncDatabaseClass: typeof import('better-sqlite3') | null = null;

try {
  const mod = require('better-sqlite3');
  const probeDir = join(tmpdir(), `mercury-sqlite3-probe-${process.pid}`);
  try {
    mkdirSync(probeDir, { recursive: true });
    const probeDb = new mod(join(probeDir, 'probe.db'));
    probeDb.close();
    rmSync(probeDir, { recursive: true, force: true });
    syncDatabaseClass = mod;
  } catch {
    syncDatabaseClass = null;
  }
} catch {
  syncDatabaseClass = null;
}

export function isNotificationsDbAvailable(): boolean {
  return syncDatabaseClass !== null;
}

export interface NotificationRow {
  id: string;
  type: string;
  source_user: string | null;
  message: string;
  data: string | null;
  read: number;
  created_at: number;
}

export class NotificationsDB {
  private db: BetterSqlite3Database;

  constructor(dbPath: string) {
    if (!syncDatabaseClass) {
      throw new Error(
        'better-sqlite3 is not available — notifications requires it. ' +
        'Install build tools (make, gcc/g++, python3) or upgrade to Node >= 20.'
      );
    }
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.db = new syncDatabaseClass(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
  }

  init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        source_user TEXT,
        message TEXT NOT NULL,
        data TEXT,
        read INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read, created_at);
      CREATE INDEX IF NOT EXISTS idx_notifications_type ON notifications(type);
      DROP INDEX IF EXISTS idx_notifications_dedup;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedup ON notifications(type, source_user, message);
    `);

    this.db.pragma('foreign_keys = ON');
    logger.info('Notifications database initialized');
  }

  add(row: Omit<NotificationRow, 'rowid'> & { rowid?: never }): string {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO notifications (id, type, source_user, message, data, read, created_at)
      VALUES (@id, @type, @source_user, @message, @data, @read, @created_at)
    `);
    stmt.run({
      id: row.id,
      type: row.type,
      source_user: row.source_user ?? null,
      message: row.message,
      data: row.data ?? null,
      read: row.read ?? 0,
      created_at: row.created_at ?? Math.floor(Date.now() / 1000),
    });
    return row.id;
  }

  markRead(id: string): boolean {
    const stmt = this.db.prepare('UPDATE notifications SET read = 1 WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  markAllRead(): number {
    const stmt = this.db.prepare('UPDATE notifications SET read = 1 WHERE read = 0');
    const result = stmt.run();
    return result.changes;
  }

  getUnread(): NotificationRow[] {
    const stmt = this.db.prepare('SELECT * FROM notifications WHERE read = 0 ORDER BY created_at DESC');
    return stmt.all() as NotificationRow[];
  }

  getAll(limit: number = 50): NotificationRow[] {
    const stmt = this.db.prepare('SELECT * FROM notifications ORDER BY read ASC, created_at DESC LIMIT ?');
    return stmt.all(limit) as NotificationRow[];
  }

  clearRead(): number {
    const stmt = this.db.prepare('DELETE FROM notifications WHERE read = 1');
    const result = stmt.run();
    return result.changes;
  }

  unreadCount(): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM notifications WHERE read = 0');
    const row = stmt.get() as { count: number };
    return row.count;
  }

  totalCount(): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM notifications');
    const row = stmt.get() as { count: number };
    return row.count;
  }

  close(): void {
    this.db.close();
  }
}