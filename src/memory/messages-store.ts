import { getMemoryDir } from '../utils/config.js';
import { MessagesDB, type MessageRow } from './messages-db.js';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';

export interface MessageRecord {
  id: string;
  direction: 'inbound' | 'outbound';
  peerUser: string;
  peerDisplayName: string | null;
  content: string;
  read: boolean;
  sentAt: number;
  storedAt: number;
}

export interface ConversationSummary {
  peerUser: string;
  peerDisplayName: string | null;
  lastMessage: string;
  lastSentAt: number;
  unreadCount: number;
}

export interface MessagesSummary {
  total: number;
  unread: number;
  conversations: number;
}

export class MessagesStore {
  private db: MessagesDB;

  constructor(dbPath?: string) {
    const resolvedDbPath = dbPath ?? join(getMemoryDir(), 'messages', 'messages.db');
    this.db = new MessagesDB(resolvedDbPath);
    this.db.init();
  }

  addInbound(fromUser: string, fromDisplayName: string | null, content: string, sentAt: number): MessageRecord {
    const id = generateId('msg');
    const now = Math.floor(Date.now() / 1000);
    this.db.add({
      id,
      direction: 'inbound',
      peer_user: fromUser,
      peer_display_name: fromDisplayName,
      content,
      read: 0,
      sent_at: sentAt || now,
      stored_at: now,
    });

    return {
      id,
      direction: 'inbound',
      peerUser: fromUser,
      peerDisplayName: fromDisplayName,
      content,
      read: false,
      sentAt: sentAt || now,
      storedAt: now,
    };
  }

  addOutbound(toUser: string, toDisplayName: string | null, content: string, sentAt: number): MessageRecord {
    const id = generateId('msg');
    const now = Math.floor(Date.now() / 1000);
    this.db.add({
      id,
      direction: 'outbound',
      peer_user: toUser,
      peer_display_name: toDisplayName,
      content,
      read: 1,
      sent_at: sentAt || now,
      stored_at: now,
    });

    return {
      id,
      direction: 'outbound',
      peerUser: toUser,
      peerDisplayName: toDisplayName,
      content,
      read: true,
      sentAt: sentAt || now,
      storedAt: now,
    };
  }

  getConversation(peerUser: string, limit: number = 50): MessageRecord[] {
    return this.db.getConversation(peerUser, limit).map(row => this.toRecord(row));
  }

  getConversations(): ConversationSummary[] {
    return this.db.getConversations().map(row => ({
      peerUser: row.peer_user,
      peerDisplayName: row.peer_display_name,
      lastMessage: row.last_message,
      lastSentAt: row.last_sent_at,
      unreadCount: row.unread_count,
    }));
  }

  markRead(id: string): boolean {
    return this.db.markRead(id);
  }

  markAllReadForPeer(peerUser: string): number {
    return this.db.markAllReadForPeer(peerUser);
  }

  markAllRead(): number {
    return this.db.markAllRead();
  }

  clearRead(): number {
    return this.db.deleteRead();
  }

  clearAll(): number {
    return this.db.deleteAll();
  }

  getSummary(): MessagesSummary {
    return {
      total: this.db.totalCount(),
      unread: this.db.unreadCount(),
      conversations: this.db.getConversations().length,
    };
  }

  close(): void {
    this.db.close();
  }

  private toRecord(row: MessageRow): MessageRecord {
    return {
      id: row.id,
      direction: row.direction as 'inbound' | 'outbound',
      peerUser: row.peer_user,
      peerDisplayName: row.peer_display_name,
      content: row.content,
      read: row.read === 1,
      sentAt: row.sent_at,
      storedAt: row.stored_at,
    };
  }
}

function generateId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}