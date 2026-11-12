export type McpTransportKind = 'stdio' | 'http';

export interface McpToolFilter {
  allow?: string[];
  deny?: string[];
  autoApprove?: string[];
}

export interface McpServerConfig {
  transport: McpTransportKind;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  allowPrivate?: boolean;
  enabled?: boolean;
  timeoutMs?: number;
  tools?: McpToolFilter;
  /** Resource URIs, independent of tools. Hidden unless explicitly allowed. */
  resources?: McpToolFilter;
}

export interface McpConfig {
  servers?: Record<string, McpServerConfig>;
}

export type McpServerState = 'disabled' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

export interface McpToolStatus {
  name: string;
  exposedName: string;
  allowed: boolean;
  autoApprove: boolean;
  skipped?: string;
}

export interface McpServerStatus {
  id: string;
  transport: McpTransportKind;
  enabled: boolean;
  state: McpServerState;
  target: string;
  error?: string;
  toolCount: number;
  tools: McpToolStatus[];
  stderrTail?: string;
}

export interface McpGateRequest {
  serverId: string;
  toolName: string;
  exposedName: string;
  args: unknown;
  autoApprove: boolean;
}

export interface McpGateResult {
  allowed: boolean;
  reason?: string;
}

export type McpGate = (request: McpGateRequest) => Promise<McpGateResult>;

export type McpResourceGateRequest = {
  signal?: AbortSignal;
} & ({ operation: 'servers' } | {
  serverId: string;
  operation: 'list' | 'read';
  uri?: string;
  autoApprove: boolean;
});

export type McpResourceGate = (request: McpResourceGateRequest) => Promise<McpGateResult>;
