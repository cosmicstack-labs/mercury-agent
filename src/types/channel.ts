export type ChannelType = 'cli' | 'telegram' | 'signal' | 'discord' | 'slack' | 'whatsapp';

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
}

export interface CLIChannelConfig extends ChannelConfig {
  type: 'cli';
}