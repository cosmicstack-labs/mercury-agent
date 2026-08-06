import { Hono } from 'hono';
import type { WebChannel } from '../../channels/web.js';
import type { ProgrammingMode, ProgrammingModeState } from '../../core/programming-mode.js';
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, basename, relative, resolve } from 'node:path';
import { getMercuryHome, loadConfig, getActiveProviders } from '../../utils/config.js';
import { listThreads, loadThread, deleteThread as removeThread, appendMessage } from './chat-history.js';

let webChannel: WebChannel | null = null;
let programmingMode: ProgrammingMode | null = null;
let modelSwitchFn: ((provider: string) => Promise<{ ok: boolean; message: string }>) | null = null;
let currentProviderFn: (() => { name: string; model: string }) | null = null;

export function setProgrammingMode(pm: ProgrammingMode): void {
  programmingMode = pm;
}

export function setModelSwitchCallback(fn: (provider: string) => Promise<{ ok: boolean; message: string }>): void {
  modelSwitchFn = fn;
}

export function setCurrentProviderCallback(fn: () => { name: string; model: string }): void {
  currentProviderFn = fn;
}

type ChatWebSettings = {
  bypassPermissions: boolean;
  restrictUser: boolean;
  workspace: string;
};

const CHAT_SETTINGS_FILE = join(getMercuryHome(), 'web-chat-settings.json');

function loadSettings(): ChatWebSettings {
  if (!existsSync(CHAT_SETTINGS_FILE)) {
    return { bypassPermissions: false, restrictUser: false, workspace: '' };
  }
  try {
    const raw = JSON.parse(readFileSync(CHAT_SETTINGS_FILE, 'utf8')) as Partial<ChatWebSettings>;
    return {
      bypassPermissions: !!raw.bypassPermissions,
      restrictUser: !!raw.restrictUser,
      workspace: raw.workspace || '',
    };
  } catch {
    return { bypassPermissions: false, restrictUser: false, workspace: '' };
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

// ─── SSE Events ──────────────────────────────────────────────

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

      // Send connected event with proper SSE named event format
      const providerInfo = currentProviderFn ? currentProviderFn() : { name: '', model: '' };
      send(`event: connected\ndata: ${JSON.stringify({ id: clientId, provider: providerInfo.name, model: providerInfo.model })}\n\n`);

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

// ─── Send Message ────────────────────────────────────────────

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

// ─── Settings ────────────────────────────────────────────────

chat.get('/api/chat/settings', async (c) => {
  if (!webChannel) return c.json({ error: 'Web channel not initialized' }, 503);
  const stored = loadSettings();
  return c.json({ ...webChannel.getSettings(), workspace: stored.workspace });
});

chat.put('/api/chat/settings', async (c) => {
  if (!webChannel) return c.json({ error: 'Web channel not initialized' }, 503);
  const body = await c.req.json<Partial<ChatWebSettings>>();
  const current = webChannel.getSettings();
  const stored = loadSettings();
  const next: ChatWebSettings = {
    bypassPermissions: body.bypassPermissions ?? current.bypassPermissions,
    restrictUser: body.restrictUser ?? current.restrictUser,
    workspace: body.workspace ?? stored.workspace,
  };
  webChannel.setBypassPermissions(next.bypassPermissions);
  webChannel.setRestrictUser(next.restrictUser);
  saveSettings(next);
  return c.json({ success: true, ...next });
});

// ─── Permission Resolution ───────────────────────────────────

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

// ─── Models / Provider Switching ─────────────────────────────

chat.get('/api/chat/models', (c) => {
  const config = loadConfig();
  const active = getActiveProviders(config);
  const current = currentProviderFn ? currentProviderFn() : { name: config.providers.default || '', model: '' };
  return c.json({
    current: current,
    providers: active.map(p => ({
      name: p.name,
      model: p.model,
      isCurrent: p.name === current.name,
    })),
  });
});

chat.post('/api/chat/models/switch', async (c) => {
  if (!modelSwitchFn) {
    return c.json({ error: 'Model switching not available' }, 503);
  }
  const body = await c.req.json<{ provider: string }>();
  if (!body.provider) {
    return c.json({ error: 'provider is required' }, 400);
  }
  const result = await modelSwitchFn(body.provider);
  return c.json(result);
});

// ─── Programming Mode ────────────────────────────────────────

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

// ─── Workspace / File Browser ────────────────────────────────

const FILE_ICONS: Record<string, string> = {
  '.ts': 'ts', '.tsx': 'tsx', '.js': 'js', '.jsx': 'jsx',
  '.py': 'py', '.rs': 'rs', '.go': 'go', '.java': 'java',
  '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml',
  '.md': 'md', '.txt': 'txt', '.css': 'css', '.html': 'html',
  '.sh': 'sh', '.bash': 'sh', '.zsh': 'sh',
};

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', '.cache',
  '__pycache__', '.tox', '.mypy_cache', 'target', '.DS_Store',
  '.turbo', 'coverage', '.nyc_output',
]);

const MAX_FILE_SIZE = 512 * 1024; // 512KB limit for preview

chat.get('/api/workspace/tree', (c) => {
  const settings = loadSettings();
  const rootDir = settings.workspace || process.cwd();
  if (!existsSync(rootDir)) {
    return c.json({ error: 'Workspace directory not found', path: rootDir }, 404);
  }

  const subPath = c.req.query('path') || '';
  const targetDir = subPath ? resolve(rootDir, subPath) : rootDir;

  // Security: ensure target is within workspace
  if (!targetDir.startsWith(rootDir)) {
    return c.json({ error: 'Path outside workspace' }, 403);
  }

  if (!existsSync(targetDir)) {
    return c.json({ error: 'Directory not found' }, 404);
  }

  try {
    const entries = readdirSync(targetDir, { withFileTypes: true });
    const items = entries
      .filter(e => !IGNORED_DIRS.has(e.name) && !e.name.startsWith('.'))
      .map(e => {
        const fullPath = join(targetDir, e.name);
        const relPath = relative(rootDir, fullPath);
        const isDir = e.isDirectory();
        const ext = isDir ? '' : extname(e.name);
        let size = 0;
        try { if (!isDir) size = statSync(fullPath).size; } catch {}
        return {
          name: e.name,
          path: relPath,
          isDirectory: isDir,
          type: isDir ? 'directory' : (FILE_ICONS[ext] || 'file'),
          size,
          ext,
        };
      })
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    return c.json({
      root: rootDir,
      currentPath: subPath || '.',
      items,
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

chat.get('/api/workspace/file', (c) => {
  const settings = loadSettings();
  const rootDir = settings.workspace || process.cwd();
  const filePath = c.req.query('path');
  if (!filePath) {
    return c.json({ error: 'path query parameter required' }, 400);
  }

  const fullPath = resolve(rootDir, filePath);

  // Security: ensure within workspace
  if (!fullPath.startsWith(rootDir)) {
    return c.json({ error: 'Path outside workspace' }, 403);
  }

  if (!existsSync(fullPath)) {
    return c.json({ error: 'File not found' }, 404);
  }

  try {
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      return c.json({ error: 'Path is a directory' }, 400);
    }
    if (stat.size > MAX_FILE_SIZE) {
      return c.json({
        path: filePath,
        name: basename(fullPath),
        size: stat.size,
        truncated: true,
        content: readFileSync(fullPath, 'utf8').slice(0, MAX_FILE_SIZE),
        ext: extname(fullPath),
      });
    }
    return c.json({
      path: filePath,
      name: basename(fullPath),
      size: stat.size,
      truncated: false,
      content: readFileSync(fullPath, 'utf8'),
      ext: extname(fullPath),
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

chat.put('/api/workspace/root', async (c) => {
  const body = await c.req.json<{ path: string }>();
  if (!body.path) {
    return c.json({ error: 'path is required' }, 400);
  }
  const resolvedPath = resolve(body.path);
  if (!existsSync(resolvedPath)) {
    return c.json({ error: 'Directory does not exist' }, 404);
  }
  const stat = statSync(resolvedPath);
  if (!stat.isDirectory()) {
    return c.json({ error: 'Path is not a directory' }, 400);
  }

  const settings = loadSettings();
  settings.workspace = resolvedPath;
  saveSettings(settings);
  return c.json({ success: true, workspace: resolvedPath });
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
