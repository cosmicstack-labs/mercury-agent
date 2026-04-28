export type AgentState =
  | 'unborn'
  | 'birthing'
  | 'onboarding'
  | 'idle'
  | 'thinking'
  | 'responding'
  | 'sleeping'
  | 'awakening';

type AgentMode = 'cli' | 'daemon' | 'hybrid';

interface AgentIdentity {
  name: string;
  owner: string;
  createdAt: number;
  version: string;
}

interface AgentContext {
  identity: AgentIdentity;
  state: AgentState;
  mode: AgentMode;
  activeChannels: string[];
  currentProvider: string;
  tokenUsage: TokenUsage;
}

interface TokenUsage {
  dailyUsed: number;
  dailyBudget: number;
  lastRequestUsed: number;
  lastResetDate: string;
}

interface HeartbeatState {
  lastBeat: number;
  intervalMinutes: number;
  tickCount: number;
  lastReflection?: string;
}