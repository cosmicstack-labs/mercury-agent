import { Hono } from 'hono';
import type { NotificationsStore } from '../../memory/notifications-store.js';

let notifications: NotificationsStore | null = null;

export function setNotificationsStore(store: NotificationsStore | null): void {
  notifications = store;
}

const notificationRoutes = new Hono();

// ── List notifications ──
notificationRoutes.get('/api/notifications', (c) => {
  if (!notifications) return c.json({ error: 'Notifications not available' }, 503);
  const type = c.req.query('type');
  const source = c.req.query('source');
  const unreadOnly = c.req.query('unread') === 'true';
  const limit = parseInt(c.req.query('limit') || '50', 10);

  let records = unreadOnly ? notifications.getUnread() : notifications.getAll(limit);

  if (type) {
    records = records.filter(r => r.type === type);
  }
  if (source) {
    records = records.filter(r => r.sourceUser === source);
  }

  return c.json({ notifications: records });
});

// ── Summary (counts) ──
notificationRoutes.get('/api/notifications/summary', (c) => {
  if (!notifications) return c.json({ error: 'Notifications not available' }, 503);
  return c.json(notifications.getSummary());
});

// ── Mark one as read ──
notificationRoutes.post('/api/notifications/:id/read', (c) => {
  if (!notifications) return c.json({ error: 'Notifications not available' }, 503);
  const ok = notifications.markRead(c.req.param('id'));
  return c.json({ success: ok });
});

// ── Mark all as read ──
notificationRoutes.post('/api/notifications/read-all', (c) => {
  if (!notifications) return c.json({ error: 'Notifications not available' }, 503);
  const count = notifications.markAllRead();
  return c.json({ marked: count });
});

// ── Clear read notifications ──
notificationRoutes.delete('/api/notifications/read', (c) => {
  if (!notifications) return c.json({ error: 'Notifications not available' }, 503);
  const count = notifications.clearRead();
  return c.json({ cleared: count });
});

export default notificationRoutes;
