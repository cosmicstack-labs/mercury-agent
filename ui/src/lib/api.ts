/* ═══════════════════════════════════════════════════════════════
   Mercury API Client — Typed fetch layer for all endpoints
   ═══════════════════════════════════════════════════════════════ */

const BASE = "";

async function request<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
    ...options,
  });

  if (res.status === 401) {
    window.location.href = "/login";
    throw new Error("Unauthorized");
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as Record<string, string>).error || `Request failed: ${res.status}`
    );
  }

  return res.json();
}

function get<T>(path: string): Promise<T> {
  return request<T>(path);
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: "POST",
    body: body ? JSON.stringify(body) : undefined,
  });
}

function put<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: "PUT",
    body: body ? JSON.stringify(body) : undefined,
  });
}

function patch<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: "PATCH",
    body: body ? JSON.stringify(body) : undefined,
  });
}

function del<T>(path: string): Promise<T> {
  return request<T>(path, { method: "DELETE" });
}

// ── Status ──
export const status = {
  get: () => get<AgentStatus>("/api/status"),
};

// ── Auth ──
export const auth = {
  login: (username: string, password: string) =>
    fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username, password }),
      redirect: "manual",
    }),
  logout: () => get<void>("/api/auth/logout"),
  changePassword: (currentPassword: string, newPassword: string) =>
    post<{ success: boolean }>("/api/auth/password", {
      currentPassword,
      newPassword,
    }),
  changeUsername: (currentPassword: string, newUsername: string) =>
    post<{ success: boolean }>("/api/auth/username", {
      currentPassword,
      newUsername,
    }),
};

// ── Config ──
export const config = {
  get: () => get<AppConfig>("/api/config"),
  update: (data: Partial<AppConfig>) => put<{ success: boolean }>("/api/config", data),
};

// ── Providers ──
export const providers = {
  list: () => get<ProviderInfo[]>("/api/providers"),
  update: (name: string, data: ProviderUpdate) =>
    post<{ success: boolean }>(`/api/providers/${name}`, data),
  test: (name: string) =>
    post<ProviderTestResult>(`/api/providers/${name}/test`),
};

// ── Chat ──
export const chat = {
  send: (content: string, threadId?: string) =>
    post<{ sent: boolean }>("/api/chat/send", { content, threadId }),
  settings: {
    get: () => get<ChatSettings>("/api/chat/settings"),
    update: (data: Partial<ChatSettings>) =>
      put<ChatSettings>("/api/chat/settings", data),
  },
  permission: (id: string, action: string) =>
    post<{ resolved: boolean }>(`/api/chat/permission/${id}`, { action }),
  models: {
    list: () => get<ModelsResponse>("/api/chat/models"),
    switch: (provider: string) =>
      post<{ ok: boolean; message: string }>("/api/chat/models/switch", {
        provider,
      }),
  },
  threads: {
    list: () => get<{ threads: ChatThread[] }>("/api/chat/threads"),
    get: (id: string) => get<ChatThread>(`/api/chat/threads/${id}`),
    delete: (id: string) => del<{ deleted: boolean }>(`/api/chat/threads/${id}`),
    addMessage: (id: string, role: string, content: string) =>
      post<{ saved: boolean }>(`/api/chat/threads/${id}/messages`, {
        role,
        content,
      }),
  },
};

// ── Code Mode ──
export const code = {
  status: () => get<CodeStatus>("/api/code/status"),
  set: (state: "off" | "plan" | "execute") =>
    post<{ state: string; active: boolean }>("/api/code/set", { state }),
};

// ── Workspace ──
export const workspace = {
  tree: (path?: string) =>
    get<WorkspaceTree>(`/api/workspace/tree${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  file: (path: string) =>
    get<WorkspaceFile>(`/api/workspace/file?path=${encodeURIComponent(path)}`),
  setRoot: (path: string) =>
    put<{ success: boolean; workspace: string }>("/api/workspace/root", { path }),
};

// ── Brain ──
export const brain = {
  status: () => get<BrainStatus>("/api/brain/status"),
  memory: {
    list: (params?: { limit?: number; offset?: number; type?: string; q?: string }) => {
      const qs = new URLSearchParams();
      if (params?.limit) qs.set("limit", String(params.limit));
      if (params?.offset) qs.set("offset", String(params.offset));
      if (params?.type) qs.set("type", params.type);
      if (params?.q) qs.set("q", params.q);
      return get<{ memories: Memory[]; total: number }>(`/api/brain/memory?${qs}`);
    },
    search: (q: string, limit?: number) =>
      get<{ memories: Memory[]; total: number }>(
        `/api/brain/memory/search?q=${encodeURIComponent(q)}${limit ? `&limit=${limit}` : ""}`
      ),
    get: (id: string) => get<Memory>(`/api/brain/memory/${id}`),
    create: (data: MemoryCreate) => post<Memory>("/api/brain/memory", data),
    update: (id: string, data: Partial<Memory>) =>
      put<{ success: boolean }>(`/api/brain/memory/${id}`, data),
    delete: (id: string) => del<{ success: boolean }>(`/api/brain/memory/${id}`),
  },
  persons: {
    list: (params?: { q?: string; limit?: number }) => {
      const qs = new URLSearchParams();
      if (params?.q) qs.set("q", params.q);
      if (params?.limit) qs.set("limit", String(params.limit));
      return get<{ persons: Person[]; total: number }>(`/api/brain/persons?${qs}`);
    },
    get: (id: string) => get<{ person: Person }>(`/api/brain/persons/${id}`),
    memories: (id: string, limit?: number) =>
      get<{ memories: Memory[]; total: number }>(
        `/api/brain/persons/${id}/memories${limit ? `?limit=${limit}` : ""}`
      ),
  },
  graph: () => get<GraphData>("/api/brain/graph"),
};

// ── Agents / Tasks ──
export const agents = {
  list: () => get<{ agents: Agent[]; available: boolean }>("/api/agents"),
  halt: () => post<{ ok: boolean }>("/api/agents/halt"),
  stop: () => post<{ ok: boolean }>("/api/agents/stop"),
};

export const bgTasks = {
  list: () => get<{ tasks: BgTask[]; available: boolean }>("/api/bg"),
  get: (id: string) => get<BgTask>(`/api/bg/${id}`),
  cancel: (id: string) => post<{ ok: boolean }>(`/api/bg/${id}/cancel`),
  clear: () => post<{ ok: boolean; cleared: number }>("/api/bg/clear"),
};

// ── Skills ──
export const skills = {
  list: () => get<{ skills: Skill[]; total: number }>("/api/skills"),
  install: (url: string) =>
    post<{ success: boolean; name: string }>("/api/skills/install", { url }),
  activate: (name: string) =>
    post<{ success: boolean }>(`/api/skills/${name}/activate`),
  deactivate: (name: string) =>
    post<{ success: boolean }>(`/api/skills/${name}/deactivate`),
  delete: (name: string) => del<{ success: boolean }>(`/api/skills/${name}`),
};

// ── Permissions ──
export const permissions = {
  get: () => get<{ manifest: PermissionManifest }>("/api/permissions"),
  update: (capabilities: Record<string, unknown>) =>
    put<{ success: boolean; manifest: PermissionManifest }>("/api/permissions", {
      capabilities,
    }),
};

// ── Usage ──
export const usage = {
  get: () => get<UsageData>("/api/usage"),
};

// ── Schedules ──
export const schedules = {
  list: () => get<{ schedules: Schedule[]; total: number }>("/api/schedules"),
  update: (id: string, data: Partial<Schedule>) =>
    put<{ success: boolean; schedule: Schedule }>(`/api/schedules/${id}`, data),
  delete: (id: string) => del<{ success: boolean }>(`/api/schedules/${id}`),
};

// ── Spotify ──
export const spotify = {
  status: () => get<SpotifyStatus>("/api/spotify/status"),
  nowPlaying: () => get<{ text: string }>("/api/spotify/now-playing"),
  play: () => post<{ ok: boolean }>("/api/spotify/play"),
  pause: () => post<{ ok: boolean }>("/api/spotify/pause"),
  next: () => post<{ ok: boolean }>("/api/spotify/next"),
  previous: () => post<{ ok: boolean }>("/api/spotify/previous"),
  volume: (volume: number) =>
    post<{ ok: boolean }>("/api/spotify/volume", { volume }),
  shuffle: (state: boolean) =>
    post<{ ok: boolean }>("/api/spotify/shuffle", { state }),
  devices: () => get<{ devices: SpotifyDevice[] }>("/api/spotify/devices"),
};

// ── Kanban ──
export const boards = {
  list: () => get<{ boards: Board[]; available: boolean }>("/api/boards"),
  get: (id: string) => get<{ board: Board; resources: BoardResources }>(`/api/boards/${id}`),
  create: (data: { name: string; description?: string }) =>
    post<{ ok: boolean; board: Board }>("/api/boards", data),
  update: (id: string, data: Partial<Board>) =>
    patch<{ ok: boolean; board: Board }>(`/api/boards/${id}`, data),
  delete: (id: string) => del<{ ok: boolean }>(`/api/boards/${id}`),
  activate: (id: string) => post<{ ok: boolean }>(`/api/boards/${id}/activate`),
  deactivate: (id: string) =>
    post<{ ok: boolean }>(`/api/boards/${id}/deactivate`),
  generate: (id: string) =>
    post<{ ok: boolean; cards: BoardCard[]; count: number }>(
      `/api/boards/${id}/generate`
    ),
  cards: {
    add: (boardId: string, data: { task: string; priority?: string }) =>
      post<{ ok: boolean; card: BoardCard }>(`/api/boards/${boardId}/cards`, data),
    addBulk: (boardId: string, cards: { task: string; priority?: string }[]) =>
      post<{ ok: boolean; cards: BoardCard[] }>(`/api/boards/${boardId}/cards/bulk`, {
        cards,
      }),
    update: (boardId: string, cardId: string, data: Partial<BoardCard>) =>
      patch<{ ok: boolean; card: BoardCard }>(
        `/api/boards/${boardId}/cards/${cardId}`,
        data
      ),
    delete: (boardId: string, cardId: string) =>
      del<{ ok: boolean }>(`/api/boards/${boardId}/cards/${cardId}`),
    reorder: (boardId: string, cardIds: string[]) =>
      post<{ ok: boolean }>(`/api/boards/${boardId}/cards/reorder`, { cardIds }),
    clearDone: (boardId: string) =>
      post<{ ok: boolean; cleared: number }>(`/api/boards/${boardId}/cards/clear-done`),
    run: (boardId: string, cardId: string, maxSteps?: number) =>
      post<{ ok: boolean; agentId: string }>(
        `/api/boards/${boardId}/cards/${cardId}/run`,
        maxSteps ? { maxSteps } : undefined
      ),
    halt: (boardId: string, cardId: string) =>
      post<{ ok: boolean }>(`/api/boards/${boardId}/cards/${cardId}/halt`),
  },
  runAll: (id: string, maxSteps?: number) =>
    post<{ ok: boolean; spawned: string[] }>(
      `/api/boards/${id}/run-all`,
      maxSteps ? { maxSteps } : undefined
    ),
  haltAll: (id: string) => post<{ ok: boolean }>(`/api/boards/${id}/halt-all`),
};

// ═══════════════════════════════════════════════════════════════
// Type Definitions
// ═══════════════════════════════════════════════════════════════

export interface AgentStatus {
  running: boolean;
  state: string;
  uptime: number;
  providers: Record<string, { enabled: boolean; hasKey: boolean }>;
  tokens: { dailyUsed: number; dailyBudget: number };
  memory: { total: number; byType: Record<string, number> };
}

export interface AppConfig {
  identity: string;
  defaultProvider: string;
  tokenBudget: number;
}

export interface ProviderInfo {
  name: string;
  maskedKey: string;
  baseUrl: string;
  model: string;
  enabled: boolean;
}

export interface ProviderUpdate {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  enabled?: boolean;
}

export interface ProviderTestResult {
  success: boolean;
  models?: string[];
  recommendedModel?: string;
}

export interface ChatSettings {
  bypassPermissions: boolean;
  restrictUser: boolean;
  workspace: string;
}

export interface ChatThread {
  id: string;
  title?: string;
  messages: ChatMessage[];
  createdAt: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  steps?: ToolStep[];
}

export interface ToolStep {
  tool: string;
  status: "running" | "done" | "error";
  result?: string;
}

export interface ModelsResponse {
  current: string;
  providers: { name: string; model: string; available: boolean }[];
}

export interface CodeStatus {
  available: boolean;
  state: "off" | "plan" | "execute";
  active: boolean;
  statusText: string;
}

export interface WorkspaceTree {
  root: string;
  currentPath: string;
  items: { name: string; type: "file" | "directory"; size?: number }[];
}

export interface WorkspaceFile {
  path: string;
  name: string;
  size: number;
  truncated: boolean;
  content: string;
  ext: string;
}

export interface BrainStatus {
  total: number;
  byType: Record<string, number>;
  available: boolean;
}

export interface Memory {
  id: string;
  type: string;
  summary: string;
  detail?: string;
  importance?: number;
  confidence?: number;
  scope?: string;
  durability?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface MemoryCreate {
  type: string;
  summary: string;
  detail?: string;
  confidence?: number;
  importance?: number;
  durability?: string;
}

export interface Person {
  id: string;
  name: string;
  relationship?: string;
  summary?: string;
  traits?: string[];
  memoryCount?: number;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphNode {
  id: string;
  label: string;
  type: string;
  size?: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  type?: string;
  weight?: number;
}

export interface Agent {
  id: string;
  task: string;
  status: string;
  tokensUsed?: number;
  startedAt?: string;
}

export interface BgTask {
  id: string;
  description: string;
  status: string;
  output?: string;
  createdAt: string;
  completedAt?: string;
}

export interface Skill {
  name: string;
  path: string;
  active: boolean;
  description?: string;
}

export interface PermissionManifest {
  capabilities: Record<string, unknown>;
}

export interface UsageData {
  dailyUsed: number;
  dailyBudget: number;
  remaining: number;
  requestLog: { timestamp: string; tokens: number; provider: string }[];
  byProvider: Record<string, number>;
  byChannel: Record<string, number>;
}

export interface Schedule {
  id: string;
  description: string;
  cron?: string;
  delaySeconds?: number;
  prompt?: string;
  skillName?: string;
  lastRun?: string;
  nextRun?: string;
}

export interface SpotifyStatus {
  available: boolean;
  connected: boolean;
  accountName?: string;
}

export interface SpotifyDevice {
  id: string;
  name: string;
  type: string;
  isActive: boolean;
}

export interface Board {
  id: string;
  name: string;
  description?: string;
  active: boolean;
  cards?: BoardCard[];
  cardCount?: number;
  createdAt: string;
}

export interface BoardCard {
  id: string;
  task: string;
  status: "pending" | "running" | "paused" | "done" | "failed";
  priority?: "low" | "medium" | "high" | "critical";
  tokensUsed?: number;
  tokenBudget?: number;
  agentId?: string;
  error?: string;
  result?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface BoardResources {
  totalTokens: number;
  runningCount: number;
  pendingCount: number;
  doneCount: number;
  failedCount: number;
}

// Default export for convenience
const api = {
  status,
  auth,
  config,
  providers,
  chat,
  code,
  workspace,
  brain,
  agents,
  bgTasks,
  skills,
  permissions,
  usage,
  schedules,
  spotify,
  boards,
};

export default api;
