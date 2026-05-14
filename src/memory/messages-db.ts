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

export function isMessagesDbAvailable(): boolean {
  return syncDatabaseClass !== null;
}

export interface MessageRow {
  id: string;
  direction: string;
  peer_user: string;
  peer_display_name: string | null;
  content: string;
  read: number;
  sent_at: number;
  stored_at: number;
}

export class MessagesDB {
  private db: BetterSqlite3Database;

  constructor(dbPath: string) {
    if (!syncDatabaseClass) {
      throw new Error(
        'better-sqlite3 is not available — messages requires it. ' +
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
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
        peer_user TEXT NOT NULL,
        peer_display_name TEXT,
        content TEXT NOT NULL,
        read INTEGER NOT NULL DEFAULT 0,
        sent_at INTEGER NOT NULL,
        stored_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_messages_peer_sent ON messages(peer_user, sent_at DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_read ON messages(read, stored_at DESC);
    `);

    this.db.pragma('foreign_keys = ON');
    logger.info('Messages database initialized');
  }

  add(row: Omit<MessageRow, 'rowid'> & { rowid?: never }): string {
    const stmt = this.db.prepare(`
      INSERT INTO messages (id, direction, peer_user, peer_display_name, content, read, sent_at, stored_at)
      VALUES (@id, @direction, @peer_user, @peer_display_name, @content, @read, @sent_at, @stored_at)
    `);
    stmt.run({
      id: row.id,
      direction: row.direction,
      peer_user: row.peer_user,
      peer_display_name: row.peer_display_name ?? null,
      content: row.content,
      read: row.read ?? 0,
      sent_at: row.sent_at ?? Math.floor(Date.now() / 1000),
      stored_at: row.stored_at ?? Math.floor(Date.now() / 1000),
    });
    return row.id;
  }

  getConversation(peerUser: string, limit: number = 50): MessageRow[] {
    const stmt = this.db.prepare(
      'SELECT * FROM messages WHERE peer_user = ? ORDER BY sent_at DESC LIMIT ?'
    );
    return stmt.all(peerUser, limit) as MessageRow[];
  }

  getConversations(): Array<{ peer_user: string; peer_display_name: string | null; last_message: string; last_sent_at: number; unread_count: number }> {
    const stmt = this.db.prepare(`
      SELECT m.peer_user, m.peer_display_name, m.content AS last_message, m.sent_at AS last_sent_at,
             COALESCE(unread.cnt, 0) AS unread_count
      FROM messages m
      INNER JOIN (
        SELECT peer_user, MAX(sent_at) AS max_sent_at
        FROM messages
        GROUP BY peer_user
      ) latest ON m.peer_user = latest.peer_user AND m.sent_at = latest.max_sent_at
      LEFT JOIN (
        SELECT peer_user, COUNT(*) AS cnt
        FROM messages
        WHERE read = 0
        GROUP BY peer_user
      ) unread ON m.peer_user = unread.peer_user
      ORDER BY m.sent_at DESC
    `);
    return stmt.all() as Array<{ peer_user: string; peer_display_name: string | null; last_message: string; last_sent_at: number; unread_count: number }>;
  }

  markRead(id: string): boolean {
    const stmt = this.db.prepare('UPDATE messages SET read = 1 WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  markAllReadForPeer(peerUser: string): number {
    const stmt = this.db.prepare('UPDATE messages SET read = 1 WHERE peer_user = ? AND read = 0');
    const result = stmt.run(peerUser);
    return result.changes;
  }

  markAllRead(): number {
    const stmt = this.db.prepare('UPDATE messages SET read = 1 WHERE read = 0');
    const result = stmt.run();
    return result.changes;
  }

  deleteRead(): number {
    const stmt = this.db.prepare('DELETE FROM messages WHERE read = 1');
    const result = stmt.run();
    return result.changes;
  }

  deleteAll(): number {
    const stmt = this.db.prepare('DELETE FROM messages');
    const result = stmt.run();
    return result.changes;
  }

  unreadCount(): number {
    const stmt = this.db.prepare('SELECT COUNT(*) AS count FROM messages WHERE read = 0');
    const row = stmt.get() as { count: number };
    return row.count;
  }

  totalCount(): number {
    const stmt = this.db.prepare('SELECT COUNT(*) AS count FROM messages');
    const row = stmt.get() as { count: number };
    return row.count;
  }

  close(): void {
    this.db.close();
  }
}