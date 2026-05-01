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

export type SubAgentStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'halted';

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