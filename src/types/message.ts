export type MessageRole = 'user' | 'assistant' | 'system';

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  channelType: import('./channel').ChannelType;
  channelId: string;
  senderId: string;
  metadata?: Record<string, unknown>;
}

export interface SystemMessage extends Message {
  role: 'system';
}

export interface UserMessage extends Message {
  role: 'user';
}

export interface AssistantMessage extends Message {
  role: 'assistant';
  tokenCount?: number;
}

export interface MessageSummary {
  id: string;
  originalIds: string[];
  summary: string;
  timestamp: number;
  tokenCount: number;
  topics: string[];
}