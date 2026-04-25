import { Hono } from 'hono';
import type { WebChannel } from '../../channels/web.js';

let webChannel: WebChannel | null = null;

export function setWebChannel(ch: WebChannel): void {
  webChannel = ch;
}

const chat = new Hono();

chat.get('/api/chat/events', (c) => {
  if (!webChannel) {
    return c.json({ error: 'Web channel not initialized' }, 503);
  }
  const ch = webChannel;

  const stream = new ReadableStream({
    start(controller) {
      const clientId = ch.addSSEClient(controller);

      const encoder = new TextEncoder();
      const send = (data: string) => {
        try {
          controller.enqueue(encoder.encode(data));
        } catch {}
      };

      send(`data: ${JSON.stringify({ type: 'connected', data: { id: clientId } })}\n\n`);

      const keepalive = setInterval(() => {
        send(`: keepalive\n\n`);
      }, 15000);

      c.req.raw.signal.addEventListener('abort', () => {
        clearInterval(keepalive);
        webChannel?.removeSSEClient(clientId);
      });
    },
    cancel() {},
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
});

chat.post('/api/chat/send', async (c) => {
  if (!webChannel) {
    return c.json({ error: 'Web channel not initialized' }, 503);
  }

  const body = await c.req.json<{ content: string }>();
  if (!body.content?.trim()) {
    return c.json({ error: 'Message content required' }, 400);
  }

  webChannel.emitMessage(body.content.trim());
  return c.json({ sent: true });
});

chat.post('/api/chat/permission/:id', async (c) => {
  if (!webChannel) {
    return c.json({ error: 'Web channel not initialized' }, 503);
  }

  const permId = c.req.param('id');
  const body = await c.req.json<{ action: string }>();
  if (!body.action) {
    return c.json({ error: 'Action required' }, 400);
  }

  const resolved = webChannel.resolveApproval(permId, body.action);
  if (resolved) {
    return c.json({ resolved: true });
  }
  return c.json({ resolved: false, error: 'Permission not found or expired' }, 404);
});

export default chat;
