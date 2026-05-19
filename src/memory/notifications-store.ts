import { getMemoryDir } from '../utils/config.js';
import { NotificationsDB, type NotificationRow } from './notifications-db.js';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';

export type NotificationType =
  | 'friend_request'
  | 'friend_accept'
  | 'friend_reject'
  | 'friend_cancel'
  | 'friend_remove'
  | 'message'
  | 'ck_query'
  | 'ck_response';

export interface NotificationRecord {
  id: string;
  type: NotificationType;
  sourceUser: string | null;
  message: string;
  data: Record<string, unknown> | null;
  read: boolean;
  createdAt: number;
}

export interface NotificationsSummary {
  total: number;
  unread: number;
}

export class NotificationsStore {
  private db: NotificationsDB;

  constructor(dbPath?: string) {
    const resolvedDbPath = dbPath ?? join(getMemoryDir(), 'notifications', 'notifications.db');
    this.db = new NotificationsDB(resolvedDbPath);
    this.db.init();
  }

  add(
    type: NotificationType,
    message: string,
    sourceUser?: string,
    data?: Record<string, unknown>,
  ): NotificationRecord {
    const id = generateId('notif');
    const now = Math.floor(Date.now() / 1000);

    this.db.add({
      id,
      type,
      source_user: sourceUser ?? null,
      message,
      data: data ? JSON.stringify(data) : null,
      read: 0,
      created_at: now,
    });

    return {
      id,
      type,
      sourceUser: sourceUser ?? null,
      message,
      data: data ?? null,
      read: false,
      createdAt: now,
    };
  }

  markRead(id: string): boolean {
    return this.db.markRead(id);
  }

  markAllRead(): number {
    return this.db.markAllRead();
  }

  getUnread(): NotificationRecord[] {
    return this.db.getUnread().map(row => this.toRecord(row));
  }

  getAll(limit: number = 50): NotificationRecord[] {
    return this.db.getAll(limit).map(row => this.toRecord(row));
  }

  clearRead(): number {
    return this.db.clearRead();
  }

  getSummary(): NotificationsSummary {
    return {
      total: this.db.totalCount(),
      unread: this.db.unreadCount(),
    };
  }

  close(): void {
    this.db.close();
  }

  private toRecord(row: NotificationRow): NotificationRecord {
    let data: Record<string, unknown> | null = null;
    if (row.data) {
      try {
        data = JSON.parse(row.data);
      } catch {
        data = null;
      }
    }
    return {
      id: row.id,
      type: row.type as NotificationType,
      sourceUser: row.source_user,
      message: row.message,
      data,
      read: row.read === 1,
      createdAt: row.created_at,
    };
  }
}

function generateId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}