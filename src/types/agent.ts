export type AgentState =
  | 'unborn'
  | 'birthing'
  | 'onboarding'
  | 'idle'
  | 'thinking'
  | 'responding'
  | 'sleeping'
  | 'awakening';

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