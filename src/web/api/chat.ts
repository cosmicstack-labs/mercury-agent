import { Hono } from 'hono';
import type { WebChannel } from '../../channels/web.js';
import type { ProgrammingMode, ProgrammingModeState } from '../../core/programming-mode.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getMercuryHome } from '../../utils/config.js';
import { listThreads, loadThread, deleteThread as removeThread, appendMessage } from './chat-history.js';

let webChannel: WebChannel | null = null;
let programmingMode: ProgrammingMode | null = null;

export function setProgrammingMode(pm: ProgrammingMode): void {
  programmingMode = pm;
}

type ChatWebSettings = {
  bypassPermissions: boolean;
  restrictUser: boolean;
};

const CHAT_SETTINGS_FILE = join(getMercuryHome(), 'web-chat-settings.json');

function loadSettings(): ChatWebSettings {
  if (!existsSync(CHAT_SETTINGS_FILE)) {
    return { bypassPermissions: false, restrictUser: false };
  }
  try {
    const raw = JSON.parse(readFileSync(CHAT_SETTINGS_FILE, 'utf8')) as Partial<ChatWebSettings>;
    return {
      bypassPermissions: !!raw.bypassPermissions,
      restrictUser: !!raw.restrictUser,
    };
  } catch {
    return { bypassPermissions: false, restrictUser: false };
  }
}

function saveSettings(settings: ChatWebSettings): void {
  writeFileSync(CHAT_SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
}

export function setWebChannel(ch: WebChannel): void {
  webChannel = ch;
  const settings = loadSettings();
  webChannel.setBypassPermissions(settings.bypassPermissions);
  webChannel.setRestrictUser(settings.restrictUser);
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

  const body = await c.req.json<{ content: string; threadId?: string }>();
  if (!body.content?.trim()) {
    return c.json({ error: 'Message content required' }, 400);
  }

  try {
    const threadId = (body.threadId && body.threadId.trim()) ? body.threadId.trim() : 'web:default';
    webChannel.emitMessageInThread(body.content.trim(), threadId);
    return c.json({ sent: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

chat.get('/api/chat/settings', async (c) => {
  if (!webChannel) return c.json({ error: 'Web channel not initialized' }, 503);
  return c.json(webChannel.getSettings());
});

chat.put('/api/chat/settings', async (c) => {
  if (!webChannel) return c.json({ error: 'Web channel not initialized' }, 503);
  const body = await c.req.json<Partial<ChatWebSettings>>();
  const current = webChannel.getSettings();
  const next: ChatWebSettings = {
    bypassPermissions: body.bypassPermissions ?? current.bypassPermissions,
    restrictUser: body.restrictUser ?? current.restrictUser,
  };
  webChannel.setBypassPermissions(next.bypassPermissions);
  webChannel.setRestrictUser(next.restrictUser);
  saveSettings(next);
  return c.json({ success: true, ...next });
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

// Programming mode
chat.get('/api/code/status', (c) => {
  if (!programmingMode) {
    return c.json({ available: false, state: 'off' });
  }
  return c.json({
    available: true,
    state: programmingMode.getState(),
    active: programmingMode.isActive(),
    statusText: programmingMode.getStatusText(),
  });
});

chat.post('/api/code/toggle', (c) => {
  if (!programmingMode) {
    return c.json({ error: 'Programming mode not available' }, 400);
  }
  const newState = programmingMode.toggle();
  return c.json({ state: newState, active: programmingMode.isActive() });
});

chat.post('/api/code/set', async (c) => {
  if (!programmingMode) {
    return c.json({ error: 'Programming mode not available' }, 400);
  }
  const body = await c.req.json<{ state: ProgrammingModeState }>();
  if (body.state === 'off') programmingMode.setOff();
  else if (body.state === 'plan') programmingMode.setPlan();
  else if (body.state === 'execute') programmingMode.setExecute();
  else return c.json({ error: 'Invalid state. Use: off, plan, execute' }, 400);
  return c.json({ state: programmingMode.getState(), active: programmingMode.isActive() });
});

// ─── Chat History ─────────────────────────────────────────────

chat.get('/api/chat/threads', (c) => {
  return c.json({ threads: listThreads() });
});

chat.get('/api/chat/threads/:id', (c) => {
  const id = c.req.param('id');
  const thread = loadThread(id);
  if (!thread) return c.json({ error: 'Thread not found' }, 404);
  return c.json(thread);
});

chat.delete('/api/chat/threads/:id', (c) => {
  const id = c.req.param('id');
  const deleted = removeThread(id);
  return c.json({ deleted });
});

chat.post('/api/chat/threads/:id/messages', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ role: 'user' | 'assistant'; content: string }>();
  if (!body.content || !body.role) {
    return c.json({ error: 'role and content required' }, 400);
  }
  const msg = {
    id: crypto.randomUUID(),
    threadId: id,
    role: body.role,
    content: body.content,
    timestamp: Date.now(),
  };
  appendMessage(id, msg);
  return c.json({ saved: true, message: msg });
});

export default chat;
