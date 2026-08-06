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

export type SignalMode = 'private' | 'group';

export interface SignalAccessUser {
  phoneNumber: string;
  uuid?: string;
  name?: string;
  role: 'admin' | 'member';
  pairedAt: string;
}

export interface SignalPendingRequest {
  phoneNumber: string;
  pairingCode: string;
  requestedAt: string;
  uuid?: string;
  name?: string;
}

export interface SignalChannelConfig extends ChannelConfig {
  type: 'signal';
  phoneNumber: string;
  mode: SignalMode;
  groupId?: string;
  groupName?: string;
  admins: SignalAccessUser[];
  members: SignalAccessUser[];
  pending: SignalPendingRequest[];
}

export interface DiscordAccessUser {
  userId: string;
  username?: string;
  displayName?: string;
  role: 'admin' | 'member';
  approvedAt: string;
}

export interface DiscordPendingRequest {
  userId: string;
  username?: string;
  displayName?: string;
  requestedAt: string;
  pairingCode?: string;
}

export interface DiscordChannelConfig extends ChannelConfig {
  type: 'discord';
  botToken: string;
  guildId?: string;
  channelId?: string;
  adminRoleName?: string;
  streaming?: boolean;
  admins: DiscordAccessUser[];
  members: DiscordAccessUser[];
  pending: DiscordPendingRequest[];
}

export interface SlackAccessUser {
  userId: string;
  userName?: string;
  displayName?: string;
  role: 'admin' | 'member';
  approvedAt: string;
}

export interface SlackPendingRequest {
  userId: string;
  userName?: string;
  displayName?: string;
  requestedAt: string;
  pairingCode?: string;
}

export interface SlackChannelConfig extends ChannelConfig {
  type: 'slack';
  botToken: string;
  appToken: string;
  channelId?: string;
  teamId?: string;
  streaming?: boolean;
  admins: SlackAccessUser[];
  members: SlackAccessUser[];
  pending: SlackPendingRequest[];
}
