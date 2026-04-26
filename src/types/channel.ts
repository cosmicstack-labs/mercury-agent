export interface TelegramAccessUser {
  userId: number;
  chatId: number;
  username?: string;
  firstName?: string;
  requestedAt?: string;
  approvedAt: string;
}

export interface TelegramPendingRequest {
  userId: number;
  chatId: number;
  username?: string;
  firstName?: string;
  requestedAt: string;
  pairingCode?: string;
}

export type ChannelType = 'cli' | 'telegram' | 'internal' | 'signal' | 'discord' | 'slack' | 'whatsapp' | 'web-panel';

export interface ChannelMessage {
  id: string;
  channelId: string;
  channelType: ChannelType;
  senderId: string;
  senderName?: string;
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface ChannelConfig {
  type: ChannelType;
  enabled: boolean;
  [key: string]: unknown;
}

export interface TelegramChannelConfig extends ChannelConfig {
  type: 'telegram';
  botToken: string;
  webhookUrl?: string;
  allowedChatIds?: number[];
  streaming?: boolean;
  admins?: TelegramAccessUser[];
  members?: TelegramAccessUser[];
  pending?: TelegramPendingRequest[];
  pairedUserId?: number;
  pairedChatId?: number;
  pairedUsername?: string;
}

export interface CLIChannelConfig extends ChannelConfig {
  type: 'cli';
}
