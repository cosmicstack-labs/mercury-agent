/* ═══════════════════════════════════════════════════════════════
   The runtime's endpoints the desktop uses. Paths are the contract;
   see docs/api-contract.md.
   ═══════════════════════════════════════════════════════════════ */

import { http, ApiError } from "./client";
import type { CommandEntry } from "~/views/chat/picker";
import type { SkillDraft,
  BotApproval, BotInboxEntry, BotManifest, BotPlan, CrewSpec, BotRunRecord, BotStatus, BotTier, BotTierId, ChatMessage, ChatSettings, ChatThread, CodeStatus, HealthInfo,
  McpServer, ModelsResponse, CodeMode, CostReport, Deliverable, RunTranscript, PairResponse, PendingPair, OwnerApproval, PluginItem, ReasoningChoice, Skill, DeviceSummary,
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
  /** Sign in for a device token. From another device the owner approves it first (a PendingPair). */
  pair: async (baseUrl: string, username: string, password: string, deviceName: string, platform: string): Promise<PairResponse | PendingPair> => {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, deviceName, platform }),
    });
    const body = (await res.json().catch(() => ({}))) as Partial<PairResponse & PendingPair> & { error?: string };
    if (!res.ok) {
      const retry = res.headers.get("Retry-After");
      throw new ApiError(body.error || `Pairing failed (${res.status})`, res.status, retry ? Number(retry) : null);
    }
    return body as PairResponse | PendingPair;
  },
  /** Ask how a pairing stands; the runtime answers within ~25 s if the owner decides meanwhile. */
  pollPair: async (baseUrl: string, pairingId: string, pollToken: string, signal?: AbortSignal): Promise<{ status: "pending" | "approved" | "denied" | "expired" | "error"; token?: string; device?: DeviceSummary; error?: string }> => {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/auth/token/pending`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairingId, pollToken }),
      signal,
    });
    return (await res.json().catch(() => ({ status: "error", error: `Mercury answered ${res.status}` }))) as { status: "pending" | "approved" | "denied" | "expired" | "error"; token?: string; device?: DeviceSummary; error?: string };
  },
  /** Sign a device out on a runtime it may not be connected to right now (removing a remote connection). */
  revokeAt: async (baseUrl: string, token: string): Promise<void> => {
    await fetch(`${baseUrl.replace(/\/+$/, "")}/api/auth/token/revoke`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(4000) });
  },
  devices: () => http.get<{ devices: DeviceSummary[]; current: string | null }>("/api/auth/devices"),
  revokeDevice: (id: string) => http.delete<{ success: boolean }>(`/api/auth/devices/${encodeURIComponent(id)}`),
  revokeSelf: () => http.post<{ success: boolean }>("/api/auth/token/revoke"),
};

/** The owner's security questions, on the runtime's own computer. */
export const security = {
  approvals: () => http.get<{ pending: OwnerApproval[]; routes: string[] }>("/api/security/approvals"),
  decide: (id: string, decision: "allow" | "deny") => http.post<{ approval: OwnerApproval }>(`/api/security/approvals/${encodeURIComponent(id)}`, { decision, by: "desktop" }),
  /** A question this device asked (a 428): how it stands. */
  status: (id: string) => http.get<{ status: OwnerApproval["status"]; code?: string }>(`/api/security/approvals/${encodeURIComponent(id)}/status`),
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
  /** Put this chat's waiting message first in line. */
  queueFirst: (threadId: string) => http.post<{ moved: number }>(`/api/chat/threads/${encodeURIComponent(threadId)}/queue/first`, {}),
  /** This chat's research: on for the next message, the run going now, or its last one. */
  research: (threadId: string) => http.get<{ armed: boolean; planFirst?: boolean; topic?: string | null; run: import("./types").ResearchSnapshot | null }>(`/api/chat/threads/${encodeURIComponent(threadId)}/research`),
  /** Stop searching and write the report from what was read. */
  finishResearch: (threadId: string) => http.post<{ ok: boolean }>(`/api/chat/threads/${encodeURIComponent(threadId)}/research/finish`, {}),
  /** Research off for this chat's next message. */
  researchOff: (threadId: string) => http.post<{ ok: boolean }>(`/api/chat/threads/${encodeURIComponent(threadId)}/research/off`, {}),
  /** Start (with these sub-questions) or cancel a proposed research plan. */
  answerResearchPlan: (id: string, action: "start" | "cancel", questions?: string[]) => http.post<{ ok: boolean }>(`/api/chat/research/plan/${encodeURIComponent(id)}`, { action, questions }),
  /** Every slash command with what it does (the "/" picker). */
  commands: () => http.get<{ commands: CommandEntry[] }>("/api/chat/commands").then((r) => r.commands),
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
  list: () => http.get<{ bots: BotStatus[]; available: boolean; unread?: number }>("/api/bots"),
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
  /** Resume a stopped bot (and its switched-off routines). */
  start: (id: string) => http.post<{ ok: boolean; message: string }>(`/api/bots/${encodeURIComponent(id)}/start`, {}),
  create: (input: { id: string; name: string; description?: string; persona?: string; tier?: BotTierId; manifest?: Partial<BotManifest> }) =>
    http.post<{ bot: BotManifest }>("/api/bots", input),
  update: (id: string, patch: Partial<BotManifest>) => http.patch<{ bot: BotManifest }>(`/api/bots/${encodeURIComponent(id)}`, patch),
  persona: (id: string) => http.get<{ persona: string }>(`/api/bots/${encodeURIComponent(id)}/persona`).then((r) => r.persona),
  setPersona: (id: string, persona: string) => http.put<{ ok: boolean }>(`/api/bots/${encodeURIComponent(id)}/persona`, { persona }),
  tiers: () => http.get<{ tiers: BotTier[] }>("/api/bots/tiers").then((r) => r.tiers),
  setTier: (id: string, tier: BotTierId) => http.put<{ ok: boolean }>(`/api/bots/${encodeURIComponent(id)}/permissions`, { tier }),
  inbox: (opts: { unread?: boolean; bot?: string; limit?: number } = {}) =>
    http.get<{ entries: BotInboxEntry[]; unread: number }>(`/api/bots/inbox?limit=${opts.limit ?? 100}${opts.unread ? "&unread=1" : ""}${opts.bot ? `&bot=${encodeURIComponent(opts.bot)}` : ""}`),
  markRead: (ids?: string[]) => http.post<{ ok: boolean; unread: number }>("/api/bots/inbox/read", ids ? { ids } : {}),
  /** The persona builder: rough instructions → the structured persona. Nothing is saved. */
  buildPersona: (text: string, name: string) => http.post<{ persona: string }>("/api/bots/persona-builder", { text, name }).then((r) => r.persona),
  /** Solo or fleet for this job, with a proposed crew. fleet: true = you already chose a fleet. */
  plan: (input: { name: string; description: string; persona: string; fleet?: boolean }) => http.post<{ plan: BotPlan; maxCrew: number }>("/api/bots/plan", input),
  promote: (id: string) => http.post<{ ok: boolean }>(`/api/bots/${encodeURIComponent(id)}/promote`, {}),
  /** Mercury designs and adds crew to a lead, in the background (roster updates arrive live). */
  autoCrew: (id: string) => http.post<{ accepted: boolean }>(`/api/bots/${encodeURIComponent(id)}/autocrew`, {}),
  addCrew: (leadId: string, crew: CrewSpec & { tier?: BotTierId }) => http.post<{ bot: BotManifest }>(`/api/bots/${encodeURIComponent(leadId)}/crew`, crew),
  approvals: () => http.get<{ approvals: BotApproval[] }>("/api/bots/approvals").then((r) => r.approvals),
  answer: (approvalId: string, answer: "yes" | "always" | "no") => http.post<{ ok: boolean }>(`/api/bots/approvals/${encodeURIComponent(approvalId)}`, { answer }),
  dlq: (id: string) => http.get<{ dlq: Array<{ id: string; prompt: string; reasonCode?: string; createdAt: number }> }>(`/api/bots/${encodeURIComponent(id)}/dlq`),
  replay: (id: string, jobId: string) => http.post<{ accepted: boolean }>(`/api/bots/${encodeURIComponent(id)}/replay/${encodeURIComponent(jobId)}`, {}),
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
