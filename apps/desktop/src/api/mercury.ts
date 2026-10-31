/* ═══════════════════════════════════════════════════════════════
   The runtime's endpoints the desktop uses. Paths are the contract;
   see docs/api-contract.md.
   ═══════════════════════════════════════════════════════════════ */

import { http, ApiError } from "./client";
import type { SkillDraft,
  BotManifest, BotRunRecord, BotStatus, ChatMessage, ChatSettings, ChatThread, CodeStatus, HealthInfo,
  McpServer, ModelsResponse, CodeMode, CostReport, Deliverable, RunTranscript, PairResponse, PluginItem, ReasoningChoice, Skill, DeviceSummary,
} from "./types";

export const health = {
  get: () => http.get<HealthInfo>("/api/health"),
  /** Probe any runtime with an explicit token, before it is configured. */
  probe: async (baseUrl: string, token: string | null, timeoutMs = 5000): Promise<HealthInfo> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/health`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: controller.signal });
      if (!res.ok) throw new ApiError(res.status === 404 || res.status === 401 ? "Unauthorized" : `Health check failed (${res.status})`, res.status);
      return (await res.json()) as HealthInfo;
    } finally {
      clearTimeout(timer);
    }
  },
};

export const auth = {
  pair: async (baseUrl: string, username: string, password: string, deviceName: string, platform: string): Promise<PairResponse> => {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, deviceName, platform }),
    });
    const body = (await res.json().catch(() => ({}))) as Partial<PairResponse> & { error?: string };
    if (!res.ok) {
      const retry = res.headers.get("Retry-After");
      throw new ApiError(body.error || `Pairing failed (${res.status})`, res.status, retry ? Number(retry) : null);
    }
    return body as PairResponse;
  },
  devices: () => http.get<{ devices: DeviceSummary[]; current: string | null }>("/api/auth/devices"),
  revokeDevice: (id: string) => http.delete<{ success: boolean }>(`/api/auth/devices/${encodeURIComponent(id)}`),
  revokeSelf: () => http.post<{ success: boolean }>("/api/auth/token/revoke"),
};

export const chat = {
  threads: () => http.get<{ threads: ChatThread[] }>("/api/chat/threads"),
  thread: (id: string) => http.get<ChatThread>(`/api/chat/threads/${encodeURIComponent(id)}`),
  createThread: (title?: string) => http.post<ChatThread>("/api/chat/threads", { title }),
  deleteThread: (id: string) => http.post<{ deleted: boolean }>(`/api/chat/threads/${encodeURIComponent(id)}/delete`, { confirmSessionId: id }),
  send: (content: string, sessionId?: string, attachments?: Array<{ name: string; data: string }>, code?: { programming: string; cwd?: string }) =>
    http.post<{ sent: boolean; sessionId: string }>("/api/chat/send", { content, sessionId, ...(attachments?.length ? { attachments } : {}), ...(code ?? {}) }),
  /** Interrupt the running turn (same as /stop). Needs the "chat.stop" feature. */
  stop: () => http.post<{ ok: boolean; note?: string }>("/api/chat/stop", {}),
  /** Take back your last message and the reply (stop the turn first); returns your text. */
  save: (threadId: string, saved: boolean) => http.post<{ id: string; saved: boolean; savedAt: string | null }>(`/api/chat/threads/${encodeURIComponent(threadId)}/save`, { saved }),
  undo: (threadId: string, content: string) => http.post<{ ok: boolean; content: string; removed: number }>(`/api/chat/threads/${encodeURIComponent(threadId)}/undo`, { content }),
  answer: (promptId: string, action: string, targetId?: string) => http.post<{ resolved: boolean }>(`/api/chat/permission/${encodeURIComponent(promptId)}`, { action, targetId }),
  settings: () => http.get<ChatSettings>("/api/chat/settings"),
  updateSettings: (patch: Partial<ChatSettings>) => http.put<ChatSettings>("/api/chat/settings", patch),
  models: () => http.get<ModelsResponse>("/api/chat/models"),
  switchModel: (provider: string, model?: string) => http.post<{ ok: boolean; message: string }>("/api/chat/models/switch", { provider, model }),
  setReasoning: (provider: string, model: string, reasoning: ReasoningChoice | null) => http.post<{ ok: boolean }>("/api/chat/models/prefs", { provider, model, reasoning }),
};

export const workspace = {
  info: () => http.get<{ cwd: string; projectName: string; projectType: string; isGit: boolean; branch: string; remoteUrl: string }>("/api/workspace/info"),
  setRoot: (path: string) => http.put<{ success: boolean; workspace: string }>("/api/workspace/root", { path }),
  tree: (path?: string) => http.get<{ root: string; currentPath: string; items: Array<{ name: string; path: string; isDirectory: boolean; type: string; size?: number; ext?: string }> }>(`/api/workspace/tree${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  file: (path: string) => http.get<{ path: string; name: string; size: number; truncated: boolean; content: string; ext: string }>(`/api/workspace/file?path=${encodeURIComponent(path)}`),
};

export const git = {
  status: () => http.get<{ branch: string; upstream: string; ahead: number; behind: number; files: Array<{ path: string; status: string; staged: boolean }>; cwd: string }>("/api/git/status"),
  diff: (file: string) => http.get<{ diff: string }>(`/api/git/diff?file=${encodeURIComponent(file)}`),
};

export const code = {
  status: () => http.get<CodeStatus>("/api/code/status"),
  set: (state: CodeMode) => http.post<{ state: string; active: boolean }>("/api/code/set", { state }),
};

export const bots = {
  list: () => http.get<{ bots: BotStatus[]; available: boolean }>("/api/bots"),
  get: (id: string) => http.get<{ bot: BotManifest; state: BotStatus | null; journal: BotRunRecord[] }>(`/api/bots/${encodeURIComponent(id)}`),
  message: (id: string, message: string) => http.post<{ accepted: boolean; jobId?: string; reasonCode?: string }>(`/api/bots/${encodeURIComponent(id)}/message`, { message }),
  enable: (id: string) => http.post<{ ok: boolean }>(`/api/bots/${encodeURIComponent(id)}/enable`),
  disable: (id: string) => http.post<{ ok: boolean }>(`/api/bots/${encodeURIComponent(id)}/disable`),
  stop: (id: string) => http.post<{ ok: boolean }>(`/api/bots/${encodeURIComponent(id)}/stop`),
  remove: (id: string) => http.delete<{ ok: boolean }>(`/api/bots/${encodeURIComponent(id)}`),
  journal: (id: string, limit = 60) => http.get<{ journal: BotRunRecord[] }>(`/api/bots/${encodeURIComponent(id)}/journal?limit=${limit}`),
  run: (id: string, runId: string) => http.get<RunTranscript>(`/api/bots/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}`),
  outputs: (id: string) => http.get<{ outputs: Deliverable[] }>(`/api/bots/${encodeURIComponent(id)}/outputs`),
  outputPreview: (id: string, name: string) => http.get<{ preview: string; truncated: boolean }>(`/api/bots/${encodeURIComponent(id)}/outputs/${encodeURIComponent(name)}/preview`),
  outputDownloadPath: (id: string, name: string) => `/api/bots/${encodeURIComponent(id)}/outputs/${encodeURIComponent(name)}/download`,
  deleteOutput: (id: string, name: string) => http.delete<{ ok: boolean }>(`/api/bots/${encodeURIComponent(id)}/outputs/${encodeURIComponent(name)}`),
  cost: (days: number) => http.get<CostReport>(`/api/bots-cost?days=${days}`),
  avatarUrl: (id: string) => `/api/bots/${encodeURIComponent(id)}/avatar`,
  runNow: (id: string) => http.post<{ accepted: boolean }>(`/api/bots/${encodeURIComponent(id)}/run`, {}),
};

export const plugins = {
  list: (refresh = false) => http.get<{ items: PluginItem[]; catalogError?: string; stale: boolean; safeMode: boolean }>(`/api/plugins${refresh ? "?refresh=1" : ""}`),
  install: (source: string, opts: { enable?: boolean; force?: boolean } = {}) =>
    http.post<{ id: string; name: string; version: string; unchanged?: boolean; tier?: string; verified?: boolean }>("/api/plugins/install", { source, ...opts }),
  /** Full detail: settings with values (secrets as isSet), groups, what's missing. */
  info: (id: string) => http.get<{ plugin: PluginItem | null }>(`/api/plugins/${encodeURIComponent(id)}`).then((r) => r.plugin),
  setSetting: (id: string, key: string, value: unknown) => http.post<{ ok: boolean }>(`/api/plugins/${encodeURIComponent(id)}/settings`, { key, value }),
  rollback: (id: string) => http.post<{ from: string; to: string }>(`/api/plugins/${encodeURIComponent(id)}/rollback`),
  enable: (id: string) => http.post<{ ok: boolean }>(`/api/plugins/${encodeURIComponent(id)}/enable`),
  disable: (id: string) => http.post<{ ok: boolean }>(`/api/plugins/${encodeURIComponent(id)}/disable`),
  update: (id: string) => http.post<{ changed: Array<{ id: string; from: string; to: string }> }>(`/api/plugins/${encodeURIComponent(id)}/update`),
  uninstall: (id: string, purge = false) => http.delete<{ ok: boolean }>(`/api/plugins/${encodeURIComponent(id)}${purge ? "?purge=1" : ""}`),
};

export const mcp = {
  list: () => http.get<{ available: boolean; servers: McpServer[] }>("/api/mcp"),
};

export const skills = {
  list: () => http.get<{ skills: Skill[]; total: number }>("/api/skills"),
  activate: (name: string) => http.post<{ success: boolean }>(`/api/skills/${encodeURIComponent(name)}/activate`),
  deactivate: (name: string) => http.post<{ success: boolean }>(`/api/skills/${encodeURIComponent(name)}/deactivate`),
  remove: (name: string) => http.delete<{ success: boolean }>(`/api/skills/${encodeURIComponent(name)}`),
  installFromRegistry: (id: string) => http.post<{ success: boolean; id: string; version: string; status: string }>("/api/skills/install-from-registry", { id, force: false }),
  install: (url: string) => http.post<{ success: boolean; name: string }>("/api/skills/install", { url }),
  /** The skill builder: Mercury's model writes a skill from a description (or revises one). Nothing is saved. */
  draft: (request: string, previous?: { draft: SkillDraft; feedback: string }) =>
    http.post<{ draft: SkillDraft; problem: string | null; clash: string | null; model: string; tools: string[] }>("/api/skills/draft", { request, previous }),
  saveSelfMade: (draft: SkillDraft) => http.post<{ success: boolean; name: string; updated: boolean }>("/api/skills/self-made", { draft }),
};

export type { ChatMessage };
