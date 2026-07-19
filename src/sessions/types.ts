import type { ChannelType } from '../types/channel.js';

export type SessionTitleSource = 'fallback' | 'generated' | 'user';
export type SessionStatus = 'active' | 'archived';
export type SessionMessageRole = 'user' | 'assistant' | 'system' | 'tool';
export type SessionMessageKind = 'message' | 'command' | 'error' | 'permission' | 'progress' | 'tool-call' | 'tool-result';

export interface SessionBinding {
  channelType: ChannelType;
  externalConversationId: string;
  createdAt: number;
  updatedAt: number;
}

export interface SessionMessage {
  id: string;
  sessionId: string;
  role: SessionMessageRole;
  kind: SessionMessageKind;
  content: string;
  timestamp: number;
  sequence: number;
  metadata?: Record<string, unknown>;
  tokenCount?: number;
  reasoning?: string;
  externalMessageId?: string;
}

export interface Session {
  id: string;
  shortId: string;
  alias: string;
  title: string;
  titleSource: SessionTitleSource;
  createdAt: number;
  updatedAt: number;
  status: SessionStatus;
  revision: number;
  bindings: SessionBinding[];
  messages: SessionMessage[];
}

export interface CreateSessionInput {
  id?: string;
  title?: string;
  titleSource?: SessionTitleSource;
  alias?: string;
  binding?: Pick<SessionBinding, 'channelType' | 'externalConversationId'>;
}

export interface AppendSessionMessageInput {
  id?: string;
  role: SessionMessageRole;
  kind?: SessionMessageKind;
  content: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
  tokenCount?: number;
  reasoning?: string;
  externalMessageId?: string;
}
