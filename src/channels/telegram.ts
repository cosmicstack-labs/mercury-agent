import { Bot, type Context } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import type { ChannelMessage } from '../types/channel.js';
import { BaseChannel } from './base.js';
import type { MercuryConfig } from '../utils/config.js';
import { logger } from '../utils/logger.js';

export class TelegramChannel extends BaseChannel {
  readonly type = 'telegram' as const;
  private bot: Bot | null = null;
  private ownerChatId: number | null = null;
  private typingInterval: NodeJS.Timeout | null = null;

  constructor(private config: MercuryConfig) {
    super();
  }

  async start(): Promise<void> {
    const token = this.config.channels.telegram.botToken;
    if (!token) {
      logger.warn('Telegram bot token not set — skipping');
      return;
    }

    const bot = new Bot(token);
    bot.api.config.use(autoRetry());

    bot.on('message:text', async (ctx) => {
      const chatId = ctx.chat.id;
      if (!this.isAllowedChat(chatId)) return;

      this.ownerChatId = chatId;

      const msg: ChannelMessage = {
        id: ctx.message.message_id.toString(),
        channelId: `telegram:${chatId}`,
        channelType: 'telegram',
        senderId: ctx.from?.id.toString() ?? 'unknown',
        senderName: ctx.from?.first_name,
        content: ctx.message.text,
        timestamp: ctx.message.date * 1000,
        metadata: { chatId, messageId: ctx.message.message_id },
      };
      this.emit(msg);
    });

    this.bot = bot;

    await bot.start({
      onStart: (info) => {
        logger.info({ bot: info.username }, 'Telegram bot started');
        this.ready = true;
      },
    });
  }

  async stop(): Promise<void> {
    this.bot?.stop();
    this.ready = false;
    this.stopTypingLoop();
  }

  async send(content: string, targetId?: string): Promise<void> {
    const chatId = targetId ? Number(targetId) : this.ownerChatId;
    if (!chatId || !this.bot) return;
    await this.bot.api.sendMessage(chatId, content);
  }

  async stream(content: AsyncIterable<string>, targetId?: string): Promise<void> {
    const chatId = targetId ? Number(targetId) : this.ownerChatId;
    if (!chatId || !this.bot) return;

    let full = '';
    for await (const chunk of content) {
      full += chunk;
    }
    await this.bot.api.sendMessage(chatId, full);
  }

  async typing(targetId?: string): Promise<void> {
    const chatId = targetId ? Number(targetId) : this.ownerChatId;
    if (!chatId || !this.bot) return;
    await this.bot.api.sendChatAction(chatId, 'typing');
  }

  startTypingLoop(chatId: number): void {
    this.stopTypingLoop();
    this.bot?.api.sendChatAction(chatId, 'typing').catch(() => {});
    this.typingInterval = setInterval(() => {
      this.bot?.api.sendChatAction(chatId, 'typing').catch(() => {});
    }, 4000);
  }

  stopTypingLoop(): void {
    if (this.typingInterval) {
      clearInterval(this.typingInterval);
      this.typingInterval = null;
    }
  }

  async sendStreamToChat(chatId: number, textStream: AsyncIterable<string>): Promise<void> {
    if (!this.bot) return;
    this.startTypingLoop(chatId);
    try {
      let full = '';
      for await (const chunk of textStream) {
        full += chunk;
      }
      await this.bot.api.sendMessage(chatId, full);
    } finally {
      this.stopTypingLoop();
    }
  }

  private isAllowedChat(chatId: number): boolean {
    const allowed = this.config.channels.telegram.allowedChatIds;
    if (!allowed || allowed.length === 0) return true;
    return allowed.includes(chatId);
  }
}