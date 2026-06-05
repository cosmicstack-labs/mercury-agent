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

export type ChannelType = 'cli' | 'telegram' | 'web' | 'internal' | 'signal' | 'discord' | 'slack' | 'whatsapp';

export interface ChannelMessage {
  id: string;
  channelId: string;
  channelType: ChannelType;
  senderId: string;
  senderName?: string;
  /**
   * The sender's access role within the channel.
   * - 'admin': the owner/operator Mercury serves.
   * - 'member': a guest authorized to talk to Mercury, but NOT the owner.
   * Used to give the agent a sense of who is currently speaking so it does
   * not treat every group member as the owner.
   */
  senderRole?: 'admin' | 'member';
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

export interface DiscordAccessUser {
  id: string;
  username?: string;
  discriminator?: string;
  requestedAt?: string;
  approvedAt: string;
}

export interface DiscordPendingRequest {
  id: string;
  username?: string;
  discriminator?: string;
  channelId?: string;
  requestedAt: string;
  pairingCode?: string;
}

export interface SlackAccessUser {
  id: string;
  username?: string;
  teamId?: string;
  requestedAt?: string;
  approvedAt: string;
}

export interface SlackPendingRequest {
  id: string;
  username?: string;
  channelId?: string;
  teamId?: string;
  requestedAt: string;
  pairingCode?: string;
}

export interface CLIChannelConfig extends ChannelConfig {
  type: 'cli';
}
