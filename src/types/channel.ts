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

/** A file/media attachment received with an incoming message. */
export interface MessageAttachment {
  /** Absolute path where the attachment was saved locally. */
  path: string;
  /** Original filename, if provided by the sender. */
  filename?: string;
  /** MIME type, e.g. image/jpeg, audio/aac, application/pdf. */
  contentType?: string;
  /** Size in bytes. */
  size?: number;
  /** True if this attachment was a voice/audio message that we transcribed. */
  transcribed?: boolean;
}

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
  /** Files/media that arrived with this message (downloaded locally). */
  attachments?: MessageAttachment[];
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
