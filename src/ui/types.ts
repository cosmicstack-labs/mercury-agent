import type { ProgrammingModeState } from '../core/programming-mode.js';
import type { SubAgentStatus } from '../types/agent.js';
import type { PermissionMode } from '../channels/base.js';

export type AppMode = 'splash' | 'chat' | 'coding' | 'workspace' | 'spotify' | 'menu';

export interface WorkspaceTreeNode {
  id: string;
  name: string;
  path: string;
  depth: number;
  isDir: boolean;
  expanded?: boolean;
}

export interface WorkspaceGitFile {
  path: string;
  staged: boolean;
  status: string;
}

export interface WorkspaceState {
  active: boolean;
  rootPath: string;
  nodes: WorkspaceTreeNode[];
  selectedIndex: number;
  selectedPath: string | null;
  openedFilePath: string | null;
  openedFilePreview: string[];
  gitFiles: WorkspaceGitFile[];
  stagedCount: number;
  unstagedCount: number;
  branch: string;
  lastAction: string;
  codeScrollOffset: number;
  focusArea: 'explorer' | 'code' | 'git' | 'chat';
  chatCollapsed: boolean;
  chatScrollOffset: number;
  rightPanel: 'chat' | 'git';
}

export interface CompletionMeta {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  budgetUsed: number;      // daily tokens used so far
  budgetTotal: number;     // daily budget limit
  budgetPercentage: number; // 0-100
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'agent' | 'system';
  content: string;
  timestamp: number;
  streaming?: boolean;
  completionMeta?: CompletionMeta;
}

export interface ToolStep {
  id: string;
  toolName: string;
  label: string;
  status: 'running' | 'done' | 'error';
  elapsed?: number;
  result?: string;
}

export interface SubAgentInfo {
  id: string;
  task: string;
  status: SubAgentStatus;
  progress?: string;
  startedAt: number;
}

export interface SidebarSection {
  title: string;
  items: SidebarItem[];
}

export interface SidebarItem {
  icon: string;
  label: string;
  detail?: string;
  active?: boolean;
}

export interface SkillInfo {
  name: string;
  description: string;
  loaded: boolean;
}

export interface ProviderInfo {
  name: string;
  model: string;
  badge?: string;
}

export interface TokenInfo {
  used: number;
  budget: number;
  percentage: number;
}

export interface MercuryAppState {
  mode: AppMode;
  programmingMode: ProgrammingModeState;
  projectContext: string | null;
  permissionMode: PermissionMode;
  chatMessages: ChatMessage[];
  toolSteps: ToolStep[];
  subAgents: SubAgentInfo[];
  skills: SkillInfo[];
  provider: ProviderInfo | null;
  tokenInfo: TokenInfo | null;
  sidebarSections: SidebarSection[];
  agentName: string;
  version: string;
  isThinking: boolean;
  permissionPrompt: PermissionPromptState | null;
  workspace: WorkspaceState | null;
}

export type BgTaskType = 'shell' | 'agent';
export type BgTaskStatus = 'running' | 'completed' | 'failed' | 'timed_out' | 'cancelled';

export interface BackgroundTaskInfo {
  id: string;
  type: BgTaskType;
  command?: string;
  task?: string;
  status: BgTaskStatus;
  startedAt: number;
  completedAt?: number;
  exitCode: number | null;
  outputPreview: string;
  runningMs?: number;
}

export interface PermissionPromptState {
  type: 'mode' | 'ask' | 'continue';
  message: string;
  options?: Array<{ value: string; label: string }>;
  resolve: (value: string | boolean) => void;
}
