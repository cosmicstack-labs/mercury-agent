import * as Lark from '@larksuiteoapi/node-sdk';
import type { ChannelMessage } from '../types/channel.js';
import type { MercuryConfig } from '../utils/config.js';
import {
  addFeishuPendingRequest,
  findFeishuApprovedUser,
  isFeishuAutoAllowed,
  saveConfig,
} from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { BaseChannel } from './base.js';

/** Feishu event envelope for message receive events (SDK v1 format). */
export interface FeishuEventEnvelope {
  event_id?: string;
  token?: string;
  create_time?: string;
  event_type?: string;
  tenant_key?: string;
  ts?: string;
  uuid?: string;
  type?: string;
  app_id?: string;
  sender?: {
    sender_id?: { union_id?: string; user_id?: string; open_id?: string };
    sender_type?: string;
    tenant_key?: string;
  };
  message?: {
    message_id?: string;
    root_id?: string;
    parent_id?: string;
    create_time?: string;
    chat_id?: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
  };
}

/** Transport interface for Feishu event handling. */
export interface FeishuTransport {
  start(onEvent: (event: FeishuEventEnvelope) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  sendText(chatId: string, content: string): Promise<void>;
}

/** Resolve Mercury target ids back to Feishu chat ids. */
export function resolveFeishuTargetId(targetId?: string): string | undefined {
  if (!targetId) return undefined;
  return targetId.startsWith('feishu:') ? targetId.slice('feishu:'.length) : targetId;
}

/** Normalize a Feishu event envelope to a Mercury channel message. */
export function normalizeFeishuEvent(envelope: FeishuEventEnvelope): ChannelMessage | null {
  const chatId = envelope.message?.chat_id;
  const openId = envelope.sender?.sender_id?.open_id;
  const rawContent = envelope.message?.content;
  const messageType = envelope.message?.message_type;

  // Only process text messages, ignore others silently
  if (messageType !== 'text' || !rawContent) return null;
  if (!chatId || !openId) return null;

  let parsed: { text?: string };
  try {
    parsed = JSON.parse(rawContent) as { text?: string };
    if (!parsed || typeof parsed !== 'object' || typeof parsed.text !== 'string') {
      return null;
    }
  } catch {
    return null;
  }

  const text = parsed.text.trim();
  if (!text) return null;

  return {
    id: envelope.event_id || envelope.uuid || '',
    channelId: `feishu:${chatId}`,
    channelType: 'feishu',
    senderId: openId,
    content: text,
    timestamp: Number(envelope.create_time || Date.now()),
    metadata: {
      chatId,
      eventId: envelope.event_id,
      messageId: envelope.message?.message_id,
    },
  };
}

/** Feishu channel implementation. */
export class FeishuChannel extends BaseChannel {
  readonly type = 'feishu' as const;
  private transport: FeishuTransport;

  constructor(private config: MercuryConfig) {
    super();
    this.transport = createFeishuTransport(config);
  }

  async start(): Promise<void> {
    await this.transport.start(async (envelope) => {
      const message = normalizeFeishuEvent(envelope);
      if (!message) return;

      if (isFeishuAutoAllowed(this.config, message.senderId) || findFeishuApprovedUser(this.config, message.senderId)) {
        this.emit(message);
        return;
      }

      addFeishuPendingRequest(this.config, {
        openId: message.senderId,
        chatId: message.channelId.slice('feishu:'.length),
        displayName: message.senderName,
      });
      saveConfig(this.config);
      const targetChatId = resolveFeishuTargetId(message.channelId);
      if (targetChatId) {
        await this.transport.sendText(
          targetChatId,
          'Access pending. Ask Mercury CLI to approve this Feishu user.',
        );
      }
    });
    this.ready = true;
  }

  async stop(): Promise<void> {
    await this.transport.stop();
    this.ready = false;
  }

  async send(content: string, targetId?: string, _elapsedMs?: number): Promise<void> {
    const chatId = resolveFeishuTargetId(targetId);
    if (!chatId) return;
    await this.transport.sendText(chatId, content);
  }

  async sendFile(_filePath: string, _targetId?: string): Promise<void> {
    // Feishu file sending is not part of the MVP - no-op
  }

  async stream(content: AsyncIterable<string>, targetId?: string): Promise<string> {
    let full = '';
    for await (const chunk of content) full += chunk;
    await this.send(full, targetId);
    return full;
  }

  async typing(_targetId?: string): Promise<void> {
    return;
  }

  async askToContinue(_question: string, _targetId?: string): Promise<boolean> {
    return true;
  }
}

/** Create a Feishu transport using the official SDK. */
function createFeishuTransport(config: MercuryConfig): FeishuTransport {
  const client = new Lark.Client({
    appId: config.channels.feishu.appId,
    appSecret: config.channels.feishu.appSecret,
  });
  const wsClient = new Lark.WSClient({
    appId: config.channels.feishu.appId,
    appSecret: config.channels.feishu.appSecret,
  });

  return {
    start: async (onEvent) => {
      try {
        wsClient.start({
          eventDispatcher: new Lark.EventDispatcher({}).register({
            'im.message.receive_v1': async (event: FeishuEventEnvelope) => {
              await onEvent(event);
            },
          }),
        });
      } catch (err) {
        logger.error({ err }, 'Failed to start Feishu WebSocket');
        throw err;
      }
    },
    stop: async () => {
      wsClient.close();
    },
    sendText: async (chatId, content) => {
      await client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text: content }),
        },
      });
    },
  };
}
