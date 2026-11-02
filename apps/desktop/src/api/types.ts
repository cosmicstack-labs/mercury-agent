/* The runtime's API shapes (docs/api-contract.md). */

export interface HealthInfo {
  ok: boolean;
  pid: number;
  version: string;
  apiVersion?: number;
  features?: string[];
  state: string;
  booting: boolean;
  /** No model provider yet: the runtime is up only so one can be connected (first run). */
  setupRequired?: boolean;
}

export interface DeviceSummary {
  id: string;
  name: string;
  platform: string;
  createdAt: string;
  lastSeenAt: string | null;
}

export interface PairResponse {
  token: string;
  device: DeviceSummary;
  apiVersion: number;
  features: string[];
}

/** Pairing from another device: the runtime's owner approves it first. */
export interface PendingPair {
  pending: true;
  pairingId: string;
  pollToken: string;
  /** Short code the owner sees ("approve K7Q2M"). */
  code: string;
  /** Where the owner approves it ("Telegram or this computer…"). */
  where: string;
  expiresAt: number;
}

/** A remote device asked for something sensitive: the owner approves it first. */
export interface ApprovalNeeded {
  approvalRequired: true;
  approvalId: string;
  code: string;
  where: string;
  error: string;
  expiresAt?: number;
}

/** A security question waiting for the owner (Mercury Desktop on the runtime's own computer). */
export interface OwnerApproval {
  id: string;
  code: string;
  kind: "pair" | "action";
  title: string;
  detail?: string;
  who: string;
  ip?: string;
  expiresAt: number;
  status: "pending" | "allowed" | "denied" | "expired";
}

// ── Chat ──
export interface ChatThread {
  id: string;
  title?: string;
  alias?: string;
  updatedAt?: string;
  messages: ChatMessage[];
  createdAt: string;
  /** Saved to come back to later (unset = not saved). */
  savedAt?: string;
}

export interface ToolStep {
  tool: string;
  status: "running" | "done" | "error";
  result?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  /** "message" | "tool-call" | … — how the runtime stored this entry. */
  kind?: string;
  content: string;
  timestamp: string;
  steps?: ToolStep[];
  /** Files sent with this message. `url` is an API path (auth required); `src` is a local preview. */
  attachments?: MessageAttachment[];
  /** How the answer was reached (live turns only): reasoning and steps. */
  trace?: ThoughtTrace;
  /** You stopped this turn; content is whatever was written before that. */
  stopped?: boolean;
  /** Files this turn made that are worth keeping (images, PDFs, reports…). */
  artifacts?: import("./artifacts").ArtifactRef[];
  /** This answer is a research report: how the run went. */
  research?: ResearchSnapshot;
}

/** A page a research run tried to read. */
export interface ResearchSource {
  url: string;
  domain: string;
  title?: string;
  status: "read" | "failed";
  reason?: string;
  cited?: boolean;
  at: number;
}

export interface ResearchSearch {
  query: string;
  results: number;
  ok: boolean;
  reason?: string;
  at: number;
}

export type ResearchOutcome = "done" | "partial" | "stopped" | "failed" | "cancelled";

/** A research run as the runtime reports it (research events, a report's metadata). */
export interface ResearchSnapshot {
  runId: string;
  topic: string;
  state: "running" | ResearchOutcome;
  phase: "planning" | "searching" | "reading" | "writing";
  questions: string[];
  startedAt: number;
  endedAt?: number;
  steps: number;
  maxSteps: number;
  searches: number;
  failedSearches: number;
  read: number;
  failed: number;
  cited: number;
  sourceList: ResearchSource[];
  searchList: ResearchSearch[];
  cut?: string;
  report?: import("./artifacts").ArtifactRef;
}

/** A proposed research plan waiting for Start. */
export interface ResearchPlanPrompt {
  id: string;
  runId: string;
  topic: string;
  questions: string[];
  expiresAt: number;
}

export interface ThoughtStep {
  id: number;
  tool: string;
  label: string;
  /** "stopped": cut off by the stop button before it finished. */
  status: "running" | "done" | "error" | "stopped";
  summary?: string;
  startedAt: number;
  endedAt?: number;
}

export interface ThoughtTrace {
  reasoning: string;
  steps: ThoughtStep[];
  startedAt: number;
  endedAt?: number;
  /** The turn was stopped by you, not finished. */
  stopped?: boolean;
}

export interface MessageAttachment {
  name: string;
  kind: "image" | "document" | string;
  mime?: string;
  url?: string;
  src?: string;
}

export type ReasoningLevel = "off" | "low" | "medium" | "high";
export type ReasoningChoice = ReasoningLevel | "auto";

export interface ModelDescription {
  label: string;
  autoLabel: string;
  customLabel: string | null;
  group: string;
  reasoning: ReasoningChoice;
  reasoningLevels: ReasoningLevel[];
}

export interface ModelsResponse {
  current: { name: string; model: string } & ModelDescription;
  providers: ({ name: string; model: string; available: boolean; isCurrent?: boolean } & ModelDescription)[];
}

export interface ChatSettings {
  bypassPermissions: boolean;
  restrictUser: boolean;
  workspace: string;
}

export type CodeMode = "off" | "auto" | "plan" | "execute";

export interface CodeStatus {
  available: boolean;
  state: CodeMode;
  active: boolean;
  statusText: string;
}

/** Prompts the runtime raises mid-turn; answered through POST /api/chat/permission/:id. */
export interface PendingPrompt {
  id: string;
  kind: "permission" | "continue" | "choice";
  /** Tool/command description (permission), question (continue/choice). */
  text: string;
  options: Array<{ value: string; label: string }>;
  targetId?: string;
  raisedAt: number;
}

// ── Bots ──
export interface BotStatus {
  id: string;
  name: string;
  enabled: boolean;
  state: "disabled" | "idle" | "queued" | "running" | "paused";
  activity?: string;
  lastRunAt?: number;
  lastRunState?: string;
  needsYou: boolean;
  fleetRole?: "lead" | "crew";
  parent?: string;
  crewWorking?: number;
  hasAvatar?: boolean;
  /** Unread inbox entries from this bot. */
  unread?: number;
  /** Permission tier, or "custom" for a hand-edited permissions file. */
  tier?: BotTierId | "custom";
  /** Stopped by the owner; stays stopped until Start. */
  stopped?: boolean;
  description?: string;
  routinePausedUntil?: number;
}

export type BotTierId = "readonly" | "builder" | "operator" | "full";

export interface BotTier {
  id: BotTierId;
  label: string;
  description: string;
  deny: string[];
}

export interface BotSchedule {
  name: string;
  cron: string;
  prompt: string;
  expects?: "work" | "message" | "check";
}

export interface BotManifest {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  fleetRole?: "lead" | "crew";
  parent?: string;
  model?: { provider?: string; model?: string };
  schedules?: BotSchedule[];
  autonomy?: { maxSteps?: number; dailyTokenBudget?: number; maxTokensPerTurn?: number; maxTurnMinutes?: number };
  memory?: { scope?: "own" | "shared-read" | "none"; learn?: boolean };
}

/** A crew member, proposed by Mercury or written by you. */
export interface CrewSpec {
  id: string;
  name: string;
  description: string;
  persona: string;
}

/** "Let Mercury decide" (POST /api/bots/plan). */
export interface BotPlan {
  shape: "solo" | "fleet";
  reason: string;
  crew: CrewSpec[];
}

/** A bot waiting for your answer mid-run (GET /api/bots/approvals). */
export interface BotApproval {
  id: string;
  botId: string;
  botName: string;
  runId: string;
  /** "Run command: …", "Write to file: …", "Read file: …" */
  prompt: string;
  at: number;
  expiresAt: number;
}

/** One thing a bot did for you (GET /api/bots/inbox). */
export interface BotInboxEntry {
  id: string;
  botId: string;
  botName: string;
  runId: string;
  kind: "result" | "failed" | "needs-you";
  title: string;
  summary: string;
  files: string[];
  complete?: boolean;
  reasonCode?: string;
  /** A question that may still be waiting for your answer. */
  approvalId?: string;
  at: number;
  read: boolean;
}

export interface BotRunRecord {
  runId: string;
  botId: string;
  trigger: string;
  state: string;
  startedAt: number;
  durationMs: number;
  tokensIn: number;
  tokensOut: number;
  summary?: string;
  error?: string;
  reasonCode?: string;
  steps?: number;
  toolCalls?: number;
  outcome?: string;
  /** How the bot closed the run: result, no_update (quiet) or failure. */
  report?: "result" | "no_update" | "failure";
  complete?: boolean;
  /** Files delivered by this run. */
  deliverables?: string[];
}

export interface Deliverable {
  botId: string;
  name: string;
  bytes: number;
  mtimeMs: number;
  path?: string;
  final?: boolean;
}

export interface RunTraceStep {
  name: string;
  ok: boolean;
  arg?: string;
}

export interface RunTranscript {
  record: BotRunRecord & { steps?: number; toolCalls?: number; peakInputTokens?: number; outcome?: string };
  prompt: string;
  output: string;
  trace: RunTraceStep[];
}

export interface UsageBucket {
  runs: number;
  completed: number;
  failed: number;
  noOutcome: number;
  deliverables: number;
  tokensIn: number;
  tokensOut: number;
}

export interface CostReport {
  days: number;
  bots: Array<{ id: string; name: string; parent?: string; today: UsageBucket; window: UsageBucket; cap: number; paused: boolean }>;
  fleets: Array<{ id: string; name: string; members: number; today: UsageBucket; window: UsageBucket }>;
  fleetToday: number;
  fleetCap: number;
  fleetPaused: boolean;
}

export interface BotActivityEvent {
  botId: string;
  kind: "turn-start" | "step" | "tool" | "turn-end" | "thinking";
  label: string;
}

// ── Plugins / MCP / Skills ──
export type PluginStatus = "available" | "installed" | "enabled" | "disabled" | "update-available" | "incompatible" | "error";

/** A setting a plugin declares (from GET /api/plugins/:id). Secrets never carry a value, only isSet. */
export interface PluginSetting {
  key: string;
  type: "string" | "number" | "boolean" | "enum" | "secret";
  label?: string;
  description?: string;
  value?: unknown;
  options?: string[];
  optionLabels?: Record<string, string>;
  examples?: string[];
  format?: "text" | "phone";
  required?: boolean;
  /** Asked during setup (right after install), in declaration order. */
  setup?: boolean;
  /** Only asked during setup while this requirement is missing (e.g. "provider:openai"). */
  setupWhenMissing?: string;
  isSet?: boolean;
  group?: string;
  when?: Record<string, string | string[]> | Array<Record<string, string | string[]>>;
}

export interface PluginItem {
  id: string;
  name: string;
  description: string;
  kind: "in-process" | "out-of-process";
  tier: "official" | "community" | "local";
  status: PluginStatus;
  installedVersion?: string;
  /** The version rollback goes back to, when it's still on disk. */
  previousVersion?: string;
  latestVersion?: string;
  sizeBytes?: number;
  enabled: boolean;
  running: boolean;
  verified: boolean;
  tools: string[];
  commands: string[];
  permissions?: { network: string[]; secrets: string[]; desktop?: boolean; providers?: Record<string, { unlocks?: string }> };
  disabled?: { code: string; message: string; at: string };
  /** Menu sections, with whether each is ready. */
  settingGroups?: Array<{ id: string; label: string; description?: string; ready: boolean }>;
  /** Optional providers or keys that aren't set up: what's off, and how to fix it. */
  missing?: Array<{ key: string; unlocks: string; needs: string; fix: string }>;
  lastError?: string;
  incompatibleReason?: string;
  settings?: PluginSetting[];
  channel?: { type: string; state?: string; detail?: string; account?: string };
}

export interface McpTool {
  name: string;
  qualifiedName?: string;
  description?: string;
  allowed?: boolean;
}

export interface McpServer {
  id: string;
  transport: "stdio" | "http";
  enabled: boolean;
  state: "disabled" | "connecting" | "connected" | "reconnecting" | "failed";
  target: string;
  error: string | null;
  toolCount: number;
  tools: McpTool[];
}

export interface Skill {
  name: string;
  active: boolean;
  description?: string;
  /** Written by Mercury (or with the skill builder), not installed. */
  selfMade?: boolean;
  version?: string | null;
  allowedTools?: string[];
  hasScripts?: boolean;
}

/** A skill the builder wrote, for review before saving. */
export interface SkillDraft {
  name: string;
  description: string;
  intents: string[];
  instructions: string;
  allowedTools?: string[];
}
