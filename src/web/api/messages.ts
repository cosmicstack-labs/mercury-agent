import { Hono } from 'hono';
import type { MessagesStore } from '../../memory/messages-store.js';

let messagesStore: MessagesStore | null = null;

export function setMessagesStore(store: MessagesStore | null): void {
  messagesStore = store;
}

const messageRoutes = new Hono();

// ── List conversations ──
messageRoutes.get('/api/messages/conversations', (c) => {
  if (!messagesStore) return c.json({ error: 'Messages not available' }, 503);
  return c.json({ conversations: messagesStore.getConversations() });
});

// ── Get conversation with a peer ──
messageRoutes.get('/api/messages/conversation/:peerUser', (c) => {
  if (!messagesStore) return c.json({ error: 'Messages not available' }, 503);
  const peer = c.req.param('peerUser');
  const limit = parseInt(c.req.query('limit') || '50', 10);
  return c.json({ messages: messagesStore.getConversation(peer, limit) });
});

// ── Summary ──
messageRoutes.get('/api/messages/summary', (c) => {
  if (!messagesStore) return c.json({ error: 'Messages not available' }, 503);
  return c.json(messagesStore.getSummary());
});

// ── Send a message (outbound via relay) ──
messageRoutes.post('/api/messages/send', async (c) => {
  if (!messagesStore) return c.json({ error: 'Messages not available' }, 503);
  const body = await c.req.json<{ to: string; content: string }>();
  if (!body.to || !body.content) return c.json({ error: 'to and content are required' }, 400);

  // Store the outbound message
  const now = Math.floor(Date.now() / 1000);
  const record = messagesStore.addOutbound(body.to, null, body.content, now);
  return c.json({ message: record });
});

// ── Mark one message as read ──
messageRoutes.post('/api/messages/:id/read', (c) => {
  if (!messagesStore) return c.json({ error: 'Messages not available' }, 503);
  const ok = messagesStore.markRead(c.req.param('id'));
  return c.json({ success: ok });
});

// ── Mark all messages from a peer as read ──
messageRoutes.post('/api/messages/conversation/:peerUser/read', (c) => {
  if (!messagesStore) return c.json({ error: 'Messages not available' }, 503);
  const count = messagesStore.markAllReadForPeer(c.req.param('peerUser'));
  return c.json({ marked: count });
});

// ── Mark all messages as read ──
messageRoutes.post('/api/messages/read-all', (c) => {
  if (!messagesStore) return c.json({ error: 'Messages not available' }, 503);
  const count = messagesStore.markAllRead();
  return c.json({ marked: count });
});

// ── Clear read messages ──
messageRoutes.delete('/api/messages/read', (c) => {
  if (!messagesStore) return c.json({ error: 'Messages not available' }, 503);
  const count = messagesStore.clearRead();
  return c.json({ cleared: count });
});

export default messageRoutes;
