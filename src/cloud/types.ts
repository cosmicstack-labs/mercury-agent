export interface CloudConfig {
  enabled: boolean;
  apiUrl: string;
  wsUrl: string;
  jwt: string;
  refreshToken: string;
  agentId: string;
  tier: string;
}

export interface PairingResult {
  jwt: string;
  refreshToken: string;
  agentId: string;
  tier: string;
}

export interface TokenRefreshResult {
  jwt: string;
  refreshToken: string;
}

export type WSMessageType =
  | 'agent.restart'
  | 'agent.status'
  | 'agent.command'
  | 'skill.install'
  | 'skill.remove'
  | 'memory.extract'
  | 'conversation.history'
  | 'agent.heartbeat'
  | 'agent.state'
  | 'skill.ack'
  | 'memory.dump'
  | 'conversation.dump'
  | 'agent.error'
  | 'agent.message.relay'
  | 'token.refreshed';

export interface WSMessage {
  type: WSMessageType;
  agentId?: string;
  payload?: Record<string, unknown>;
  timestamp?: string;
}