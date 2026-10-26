import { Hono } from 'hono';
import { storeInlineAttachments } from './uploads.js';
import type { WebChannel } from '../../channels/web.js';
import type { ProgrammingMode, ProgrammingModeState } from '../../core/programming-mode.js';
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, extname, basename, relative, resolve } from 'node:path';
import { getMercuryHome, loadConfig, getActiveProviders } from '../../utils/config.js';
import type { SessionRepository } from '../../sessions/index.js';
import { loadPermissionMode, savePermissionMode } from '../../capabilities/permission-mode-store.js';
import {
  getModelPref, setModelPref, humanizeModelName, modelGroupLabel,
  reasoningLevelsFor, effectiveReasoning, isReasoningLevel, isValidModelRef, type ReasoningLevel,
} from '../../utils/model-prefs.js';

let webChannel: WebChannel | null = null;
let programmingMode: ProgrammingMode | null = null;
let modelSwitchFn: ((provider: string, model?: string) => Promise<{ ok: boolean; message: string }>) | null = null;
let currentProviderFn: (() => { name: string; model: string }) | null = null;
let sessions: SessionRepository | null = null;
let sessionSyncEnabledFn: (() => boolean) | null = null;

export function setSessionRepository(repository: SessionRepository): void {
  sessions = repository;
}

export function setSessionSyncEnabledCallback(fn: () => boolean): void {
  sessionSyncEnabledFn = fn;
}

function toThread(session: ReturnType<SessionRepository['get']>, includeMessages = true) {
  return {
    id: session.id,
    shortId: session.shortId,
    alias: session.alias,
    title: session.title,
    createdAt: new Date(session.createdAt).toISOString(),
    updatedAt: new Date(session.updatedAt).toISOString(),
    messages: includeMessages ? session.messages.map((message) => ({
      id: message.id,
      threadId: session.id,
      role: message.role,
      content: message.content,
      timestamp: new Date(message.timestamp).toISOString(),
      kind: message.kind,
      sequence: message.sequence,
    })) : [],
  };
}

export function setProgrammingMode(pm: ProgrammingMode): void {
  programmingMode = pm;
}

export function setModelSwitchCallback(fn: (provider: string, model?: string) => Promise<{ ok: boolean; message: string }>): void {
  modelSwitchFn = fn;
}

export function setCurrentProviderCallback(fn: () => { name: string; model: string }): void {
  currentProviderFn = fn;
}

let statusSnapshotFn: (() => Record<string, unknown>) | null = null;

/** The runtime's live status (model, mode, permissions, tokens…) for the connected frame. */
export function setStatusSnapshotCallback(fn: () => Record<string, unknown>): void {
  statusSnapshotFn = fn;
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
  // The owner's saved permission mode wins; the old per-dashboard flag is
  // only used until a mode has been chosen.
  const saved = loadPermissionMode();
  webChannel.setBypassPermissions(saved ? saved === 'allow-all' : settings.bypassPermissions);
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
      const clientId = ch.addSSEClient(controller, c.req.query('sessionId'));

      const encoder = new TextEncoder();
      const send = (data: string) => {
        try {
          controller.enqueue(encoder.encode(data));
        } catch {}
      };

      // Send connected event with proper SSE named event format
      const providerInfo = currentProviderFn ? currentProviderFn() : { name: '', model: '' };
      let status: Record<string, unknown> | undefined;
      try { status = statusSnapshotFn?.(); } catch { status = undefined; }
      send(`event: connected\ndata: ${JSON.stringify({ id: clientId, provider: providerInfo.name, model: providerInfo.model, ...(status ? { status } : {}) })}\n\n`);

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

  const body = await c.req.json<{
    content?: string;
    sessionId?: string;
    threadId?: string;
    /** Base64 files: photos and PDFs become real attachments for this turn. */
    attachments?: unknown;
  }>();
  const content = body.content?.trim() ?? '';
  const upload = storeInlineAttachments(body.attachments);
  if (!upload.ok) return c.json({ error: upload.error }, 400);
  if (!content && upload.attachments.length === 0) {
    return c.json({ error: 'Message content required' }, 400);
  }

  try {
    if (!sessions) return c.json({ error: 'Session repository not initialized' }, 503);
    const requestedId = body.sessionId?.trim() || body.threadId?.trim();
    let session = requestedId ? sessions.getByBinding('web', requestedId) : null;
    if (requestedId && !session) {
      try {
        session = sessions.get(requestedId);
      } catch {
        session = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(requestedId)
          ? sessions.getOrCreateBound('web', requestedId, requestedId)
          : sessions.getOrCreateBound('web', requestedId);
      }
    }
    session ??= sessions.getOrCreateBound('web', 'web:default');
    // Models reject an empty text block, so a photo sent alone says what it is.
    const text = content || `(Attached: ${upload.attachments.map(a => a.name).join(', ')})`;
    webChannel.emitMessageInThread(text, session.id, session.id, undefined, undefined, undefined, upload.attachments);
    return c.json({
      sent: true,
      sessionId: session.id,
      ...(upload.attachments.length > 0 ? { attachments: upload.attachments.map(a => ({ name: a.name, kind: a.kind })) } : {}),
    });
  } catch (err: any) {
    // The message never reached the runtime: don't leave its files behind.
    for (const a of upload.attachments) rmSync(a.path, { force: true });
    return c.json({ error: err.message }, 500);
  }
});

// ─── Settings ────────────────────────────────────────────────

chat.get('/api/chat/settings', async (c) => {
  if (!webChannel) return c.json({ error: 'Web channel not initialized' }, 503);
  const stored = loadSettings();
  return c.json({ ...webChannel.getSettings(), workspace: stored.workspace, permissionMode: loadPermissionMode() });
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
  if (typeof body.bypassPermissions === 'boolean') savePermissionMode(body.bypassPermissions ? 'allow-all' : 'ask-me');
  return c.json({ success: true, ...next, permissionMode: loadPermissionMode() });
});

// ─── Permission Resolution ───────────────────────────────────

chat.post('/api/chat/permission/:id', async (c) => {
  if (!webChannel) {
    return c.json({ error: 'Web channel not initialized' }, 503);
  }

  const permId = c.req.param('id');
  const body = await c.req.json<{ action?: string; targetId?: string }>().catch(() => ({} as { action?: string; targetId?: string }));
  // One endpoint answers every prompt a screen shows: permission/continue/
  // mode approvals AND choice pickers (/model, /permissions, ask_user). It
  // used to resolve approvals only, so a picker answered in the attached
  // terminal never reached the runtime: the command hung until the 2-minute
  // timeout and the screen showed "Thinking" the whole time. An empty action
  // is Esc: the picker is cancelled (its caller treats that as "no change").
  if (!body.action) {
    if (webChannel.cancelInteraction(permId, body.targetId)) return c.json({ resolved: true, cancelled: true });
    return c.json({ error: 'Action required' }, 400);
  }

  // Prompts are bound to the chat session that raised them; without the
  // targetId the session check in resolveInteraction always fails.
  const resolved = webChannel.resolveApproval(permId, body.action, body.targetId)
    || webChannel.resolveChoice(permId, body.action, body.targetId);
  if (resolved) {
    return c.json({ resolved: true });
  }
  return c.json({ resolved: false, error: 'Permission not found or expired' }, 404);
});

// ─── Models / Provider Switching ─────────────────────────────

/**
 * Failed model lookups are remembered briefly so that opening the picker
 * while Ollama is down (or ChatGPT is signed out) doesn't wait on a timeout
 * every time.
 */
const LOOKUP_RETRY_MS = 30_000;
const failedLookups = new Map<string, number>();

function recentlyFailed(key: string): boolean {
  const at = failedLookups.get(key);
  return at !== undefined && Date.now() - at < LOOKUP_RETRY_MS;
}

/** Every model the local Ollama server has pulled (empty if unreachable). */
async function listOllamaModels(baseUrl: string): Promise<string[]> {
  const root = baseUrl.replace(/\/+$/, '').replace(/\/(v1|api)$/, '');
  const lookup = `ollama:${root}`;
  if (recentlyFailed(lookup)) return [];
  try {
    const res = await fetch(`${root}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { models?: { name?: string }[] };
    failedLookups.delete(lookup);
    return (data.models ?? []).map((m) => m.name ?? '').filter(Boolean).sort();
  } catch {
    failedLookups.set(lookup, Date.now());
    return [];
  }
}

/** Models the signed-in ChatGPT plan offers; cached because the lookup is slow. */
let chatgptModelCache: { at: number; models: string[] } | null = null;
const CHATGPT_MODEL_TTL_MS = 10 * 60 * 1000;

async function listChatGPTModels(): Promise<string[]> {
  if (chatgptModelCache && Date.now() - chatgptModelCache.at < CHATGPT_MODEL_TTL_MS) {
    return chatgptModelCache.models;
  }
  if (recentlyFailed('chatgpt')) return [];
  try {
    const { getValidChatGPTSession } = await import('../../auth/chatgpt-session.js');
    const { fetchChatGPTModels } = await import('../../auth/chatgpt-models.js');
    const session = await getValidChatGPTSession();
    if (!session) throw new Error('not signed in');
    const catalog = await fetchChatGPTModels(session.accessToken, session.accountId);
    chatgptModelCache = { at: Date.now(), models: catalog.models };
    failedLookups.delete('chatgpt');
    return catalog.models;
  } catch {
    failedLookups.set('chatgpt', Date.now());
    return [];
  }
}

/** Providers that serve many models list each one; others list their configured model. */
async function listProviderModels(p: { name: string; baseUrl: string }): Promise<string[]> {
  if (p.name === 'ollamaLocal') return listOllamaModels(p.baseUrl);
  if (p.name === 'chatgptWeb') return [...(await listChatGPTModels())];
  return [];
}

/** What the picker needs to show a model in plain language. */
function describeModel(provider: string, model: string) {
  const pref = getModelPref(provider, model);
  return {
    label: pref.label ?? humanizeModelName(model),
    autoLabel: humanizeModelName(model),
    customLabel: pref.label ?? null,
    group: modelGroupLabel(provider, model),
    reasoning: effectiveReasoning(provider, model) ?? 'auto',
    reasoningLevels: reasoningLevelsFor(provider, model),
  };
}

chat.get('/api/chat/models', async (c) => {
  const config = loadConfig();
  const active = getActiveProviders(config);
  const current = currentProviderFn ? currentProviderFn() : { name: config.providers.default || '', model: '' };
  const entries: ({ name: string; model: string; available: boolean; isCurrent: boolean } & ReturnType<typeof describeModel>)[] = [];
  const perProvider = await Promise.all(active.map((p) => listProviderModels(p)));
  for (const [i, p] of active.entries()) {
    const models = perProvider[i];
    if (models.length && !models.includes(p.model)) models.unshift(p.model);
    for (const model of models.length ? models : [p.model]) {
      entries.push({
        name: p.name,
        model,
        available: true,
        isCurrent: p.name === current.name && model === current.model,
        ...describeModel(p.name, model),
      });
    }
  }
  return c.json({ current: { ...current, ...describeModel(current.name, current.model) }, providers: entries });
});

/** Rename a model (label) and/or set its reasoning level. null / '' / 'auto' resets. */
chat.post('/api/chat/models/prefs', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  // Same id rules as /api/chat/models/switch; anything else is a 400, not a 500.
  if (!body || !isValidModelRef(body.provider) || !isValidModelRef(body.model)) {
    return c.json({ error: 'provider and model must be non-empty strings of at most 256 characters' }, 400);
  }
  const { provider, model, label, reasoning } = body as { provider: string; model: string; label?: unknown; reasoning?: unknown };
  if (label !== undefined && label !== null && typeof label !== 'string') {
    return c.json({ error: 'label must be a string or null' }, 400);
  }
  if (reasoning !== undefined && reasoning !== null && typeof reasoning !== 'string') {
    return c.json({ error: 'reasoning must be a string or null' }, 400);
  }
  // Only active providers: keeps model-prefs.json from growing unbounded.
  if (!getActiveProviders(loadConfig()).some((p) => p.name === provider)) {
    return c.json({ error: `Provider \`${provider}\` is not configured` }, 400);
  }
  if (typeof reasoning === 'string' && reasoning !== 'auto') {
    if (!isReasoningLevel(reasoning) || !reasoningLevelsFor(provider, model).includes(reasoning)) {
      return c.json({ error: `Reasoning level '${reasoning}' is not supported for ${model}` }, 400);
    }
  }
  setModelPref(provider, model, {
    label: label as string | null | undefined,
    reasoning: reasoning as ReasoningLevel | 'auto' | null | undefined,
  });
  return c.json({ ok: true, ...describeModel(provider, model) });
});

chat.post('/api/chat/models/switch', async (c) => {
  if (!modelSwitchFn) {
    return c.json({ error: 'Model switching not available' }, 503);
  }
  const body = await c.req.json<{ provider?: unknown; model?: unknown }>().catch(() => null);
  if (!body || typeof body.provider !== 'string' || !body.provider) {
    return c.json({ error: 'provider is required' }, 400);
  }
  if (body.model !== undefined && typeof body.model !== 'string') {
    return c.json({ error: 'model must be a string' }, 400);
  }
  const result = await modelSwitchFn(body.provider, body.model?.trim() || undefined);
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
  else if (body.state === 'auto') programmingMode.setAuto();
  else if (body.state === 'plan') programmingMode.setPlan();
  else if (body.state === 'execute') programmingMode.setExecute();
  else return c.json({ error: 'Invalid state. Use: off, auto, plan, execute' }, 400);
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
  if (!sessions) return c.json({ error: 'Session repository not initialized' }, 503);
  return c.json({ threads: sessions.list().map((session) => toThread(session, false)) });
});

chat.post('/api/chat/threads', async (c) => {
  if (!sessions) return c.json({ error: 'Session repository not initialized' }, 503);
  const body: { title?: string } = await c.req.json<{ title?: string }>().catch(() => ({}));
  return c.json(toThread(sessions.create({ title: body.title }), true), 201);
});

chat.get('/api/chat/threads/:id', (c) => {
  const id = c.req.param('id');
  if (!sessions) return c.json({ error: 'Session repository not initialized' }, 503);
  try {
    return c.json(toThread(sessions.get(id), true));
  } catch {
    return c.json({ error: 'Thread not found' }, 404);
  }
});

chat.delete('/api/chat/threads/:id', (c) => {
  const id = c.req.param('id');
  if (!sessions) return c.json({ error: 'Session repository not initialized' }, 503);
  try {
    sessions.archive(id);
    return c.json({ deleted: true });
  } catch {
    return c.json({ deleted: false }, 404);
  }
});

chat.post('/api/chat/threads/:id/delete', async (c) => {
  const id = c.req.param('id');
  if (!sessions) return c.json({ error: 'Session repository not initialized' }, 503);
  const body: { confirmSessionId?: string } = await c.req.json<{ confirmSessionId?: string }>().catch(() => ({}));
  if (body.confirmSessionId !== id) return c.json({ error: 'Explicit session deletion confirmation is required' }, 400);
  try {
    const target = sessions.get(id);
    if (target.id !== id) return c.json({ error: 'Confirmation must use the exact session ID' }, 400);
    const syncPending = sessionSyncEnabledFn?.() === true;
    const deleted = syncPending ? sessions.markDeleted(target.id) : sessions.deletePermanently(target.id);
    return c.json({ deleted: true, sessionId: deleted.id, syncPending });
  } catch {
    return c.json({ deleted: false, error: 'Thread not found' }, 404);
  }
});

chat.post('/api/chat/threads/:id/messages', async (c) => {
  return c.json({ error: 'Messages are written by /api/chat/send and the agent runtime' }, 410);
});

export default chat;
