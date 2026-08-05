export interface CloudConfig {
  enabled: boolean;
  apiUrl: string;
  wsUrl: string;
  jwt: string;
  refreshToken: string;
  agentId: string;
  tier: string;
  agentApiKey: string;
}

export interface PairingResult {
  jwt: string;
  refreshToken: string;
  agentId: string;
  tier: string;
  apiKey?: string;
}

export interface TokenRefreshResult {
  jwt: string;
  refreshToken: string;
}

export type WSMessageType =
  | 'agent.restart'
  | 'agent.status'
  | 'agent.command'
  | 'agent.command.ack'
  | 'agent.event.ack'
  | 'skill.install'
  | 'skill.remove'
  | 'memory.extract'
  | 'memory.fetch'
  | 'memory.fetch.result'
  | 'memory.share-learning.toggle'
  | 'conversation.history'
  | 'conversation.sync.toggle'
  | 'agent.heartbeat'
  | 'agent.state'
  | 'skill.ack'
  | 'memory.dump'
  | 'conversation.dump'
  | 'agent.error'
  | 'agent.message.relay'
  | 'agent.response'
  | 'agent.stream'
  | 'research.artifact'
  | 'token.refreshed'
  | 'channel.config.update'
  | 'channel.config.report'
  | 'channel.config.ack';

export interface WSMessage {
  type: WSMessageType;
  agentId?: string;
  payload?: Record<string, unknown>;
  timestamp?: string;
}
