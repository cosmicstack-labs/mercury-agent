import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NotificationsStore } from './notifications-store.js';
import { isNotificationsDbAvailable } from './notifications-db.js';

const tempDirs: string[] = [];

const sqliteAvailable = isNotificationsDbAvailable();

function createStore(): NotificationsStore {
  const dir = mkdtempSync(join(tmpdir(), 'mercury-notif-'));
  tempDirs.push(dir);
  const dbPath = join(dir, 'notifications', 'notifications.db');
  return new NotificationsStore(dbPath);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

describe('NotificationsStore', () => {
  it.skipIf(!sqliteAvailable)('stores and retrieves notifications', () => {
    const store = createStore();

    store.add('friend_request', '@alice wants to be your memory friend', 'alice', { request_id: 'fr_123' });

    const all = store.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].type).toBe('friend_request');
    expect(all[0].sourceUser).toBe('alice');
    expect(all[0].message).toContain('alice');
    expect(all[0].read).toBe(false);
  });

  it.skipIf(!sqliteAvailable)('tracks unread count', () => {
    const store = createStore();

    store.add('friend_accept', '@bob accepted your friend request!', 'bob');
    store.add('friend_request', '@carol wants to be your memory friend', 'carol');

    const summary = store.getSummary();
    expect(summary.total).toBe(2);
    expect(summary.unread).toBe(2);
  });

  it.skipIf(!sqliteAvailable)('marks single notification as read', () => {
    const store = createStore();

    const notification = store.add('friend_request', '@alice wants to be your memory friend', 'alice');
    expect(notification.read).toBe(false);

    store.markRead(notification.id);

    const unread = store.getUnread();
    expect(unread).toHaveLength(0);

    const all = store.getAll();
    expect(all[0].read).toBe(true);
  });

  it.skipIf(!sqliteAvailable)('marks all notifications as read', () => {
    const store = createStore();

    store.add('friend_accept', '@bob accepted your friend request!', 'bob');
    store.add('friend_request', '@carol wants to be your memory friend', 'carol');

    const marked = store.markAllRead();
    expect(marked).toBe(2);

    const summary = store.getSummary();
    expect(summary.unread).toBe(0);
    expect(summary.total).toBe(2);
  });

  it.skipIf(!sqliteAvailable)('clears read notifications', () => {
    const store = createStore();

    const n1 = store.add('friend_accept', '@bob accepted your friend request!', 'bob');
    store.add('friend_request', '@carol wants to be your memory friend', 'carol');

    store.markRead(n1.id);
    const cleared = store.clearRead();
    expect(cleared).toBe(1);

    const summary = store.getSummary();
    expect(summary.total).toBe(1);
    expect(summary.unread).toBe(1);
  });

  it.skipIf(!sqliteAvailable)('returns notifications sorted: unread first, then by date', () => {
    const store = createStore();

    const n1 = store.add('friend_accept', '@alice accepted your friend request!', 'alice');
    store.add('friend_request', '@bob wants to be your memory friend', 'bob');

    store.markRead(n1.id);

    const all = store.getAll();
    expect(all).toHaveLength(2);
    expect(all[0].read).toBe(false);
    expect(all[0].sourceUser).toBe('bob');
    expect(all[1].read).toBe(true);
    expect(all[1].sourceUser).toBe('alice');
  });

  it.skipIf(!sqliteAvailable)('stores notification with data payload', () => {
    const store = createStore();

    store.add('friend_request', '@alice wants to be your memory friend', 'alice', { request_id: 'fr_abc123' });

    const all = store.getAll();
    expect(all[0].data).toEqual({ request_id: 'fr_abc123' });
  });

  it.skipIf(!sqliteAvailable)('stores notification without source user or data', () => {
    const store = createStore();

    store.add('friend_remove', 'A friend removed you.');

    const all = store.getAll();
    expect(all[0].sourceUser).toBeNull();
    expect(all[0].data).toBeNull();
  });

  it('reports better-sqlite3 availability status', () => {
    expect(typeof sqliteAvailable).toBe('boolean');
  });
});