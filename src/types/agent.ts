export type AgentState =
  | 'unborn'
  | 'birthing'
  | 'onboarding'
  | 'idle'
  | 'thinking'
  | 'responding'
  | 'sleeping'
  | 'awakening'
  | 'delegating';

export type AgentMode = 'cli' | 'daemon' | 'hybrid';

export interface AgentIdentity {
  name: string;
  owner: string;
  createdAt: number;
  version: string;
}

export interface AgentContext {
  identity: AgentIdentity;
  state: AgentState;
  mode: AgentMode;
  activeChannels: string[];
  currentProvider: string;
  tokenUsage: TokenUsage;
}

export interface TokenUsage {
  dailyUsed: number;
  dailyBudget: number;
  lastRequestUsed: number;
  lastResetDate: string;
}

export interface HeartbeatState {
  lastBeat: number;
  intervalMinutes: number;
  tickCount: number;
  lastReflection?: string;
}

export type SubAgentStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'halted' | 'question';

export type SubAgentPriority = 'low' | 'normal' | 'high';

export interface SubAgentConfig {
  id: string;
  task: string;
  workingDirectory?: string;
  allowedTools?: string[];
  maxSteps?: number;
  priority?: SubAgentPriority;
  sourceChannelId?: string;
  sourceChannelType?: string;
}

export interface SubAgentResult {
  agentId: string;
  task: string;
  status: 'completed' | 'failed' | 'halted';
  output: string;
  error?: string;
  filesModified: string[];
  duration: number;
  tokenUsage: { input: number; output: number };
}

export interface TaskBoardEntry {
  agentId: string;
  task: string;
  status: SubAgentStatus;
  priority: SubAgentPriority;
  startedAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
  filesLocked: string[];
  progress?: string;
  sourceChannelId?: string;
  sourceChannelType?: string;
  tokenUsage?: { input: number; output: number; total: number };
}

export interface ResourceUsage {
  cpuCores: number;
  maxConcurrentAgents: number;
  activeAgents: number;
  queuedAgents: number;
  systemMemoryMB: number;
  availableMemoryMB: number;
  tokenBudgetRemaining: number;
}

export interface FileLock {
  filePath: string;
  agentId: string;
  mode: 'read' | 'write';
  acquiredAt: number;
}

export interface SubagentsConfig {
  enabled: boolean;
  maxConcurrent: number;
  mode: 'auto' | 'manual';
}

export type BoardStatus = 'active' | 'inactive';

export interface CardComment {
  id: string;
  author: 'user' | 'agent';
  authorName: string;
  content: string;
  timestamp: number;
}

export interface CardAttachment {
  id: string;
  name: string;
  path: string;
  type: 'markdown' | 'document' | 'image' | 'presentation' | 'other';
  size?: number;
  addedAt: number;
  addedBy: 'user' | 'agent';
}

export interface CardLabel {
  id: string;
  name: string;
  color: string; // hex color
}

export interface BoardContextEvent {
  cardId: string;
  timestamp: number;
  type: 'card-completed' | 'card-failed' | 'directory-changed' | 'file-created' | 'decision-made' | 'context-set';
  summary: string;
  data?: Record<string, any>;
}

export interface BoardContext {
  /** Shared working directory for this board's agents */
  workingDirectory?: string;
  /** Shared key-value context variables accessible to all cards */
  variables: Record<string, any>;
  /** Ordered event log of what happened on this board */
  events: BoardContextEvent[];
  /** Max events to retain (rolling window) */
  maxEvents?: number;
  /** Project instructions — high-level guidance for all agents on this board */
  projectInstructions?: string;
  /** Key file paths and their purpose (e.g. {"src/index.ts": "entry point", "package.json": "dependencies"}) */
  projectStructure?: Record<string, string>;
  /** Accumulated knowledge — things agents learn about the project that persist */
  knowledgeBase?: string[];
}

export interface CardActivityEntry {
  timestamp: number;
  type: 'progress' | 'tool-use' | 'thinking' | 'completed' | 'failed' | 'feedback' | 'file-lock' | 'started';
  message: string;
  data?: Record<string, any>;
}

export interface BoardCard {
  id: string;
  task: string;
  status: SubAgentStatus;
  priority: SubAgentPriority;
  order: number;
  startedAt?: number;
  completedAt?: number;
  result?: string;
  error?: string;
  filesLocked: string[];
  progress?: string;
  tokenUsage?: { input: number; output: number; total: number };
  /** Maximum token budget for this card. Agent is paused if exceeded. */
  tokenBudget?: number;
  /** If true, card was paused due to token budget exhaustion */
  pausedForTokens?: boolean;
  labels?: CardLabel[];
  comments?: CardComment[];
  attachments?: CardAttachment[];
  // ── Dependency tree ──
  parentId?: string;        // immediate parent card (tree structure)
  dependsOn?: string[];     // cards that must complete before this one can run
  // ── Context ──
  contextSnapshot?: Record<string, any>;  // snapshot of board context when card started
  // ── Activity Log ──
  activityLog?: CardActivityEntry[];      // real-time step history
}

export interface Board {
  id: string;
  name: string;
  description: string;
  status: BoardStatus;
  createdAt: number;
  updatedAt: number;
  cards: BoardCard[];
  context?: BoardContext;
}