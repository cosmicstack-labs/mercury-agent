import fs from 'node:fs';
import path from 'node:path';
import { Bot, InputFile } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import type { ChannelMessage } from '../types/channel.js';
import { BaseChannel } from './base.js';
import type { MercuryConfig } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { mdToTelegram } from '../utils/markdown.js';

const MAX_MESSAGE_LENGTH = 4096;

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
      logger.info({ chatId, text: ctx.message.text?.slice(0, 50) }, 'Telegram message received');

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

    bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    this.bot = bot;

    await bot.start({
      onStart: (info) => {
        logger.info({ bot: info.username }, 'Telegram bot started — long polling active');
        this.ready = true;
      },
    });
  }

  async stop(): Promise<void> {
    this.bot?.stop();
    this.ready = false;
    this.stopTypingLoop();
  }

  async send(content: string, targetId?: string, elapsedMs?: number): Promise<void> {
    const chatId = this.parseChatId(targetId);
    if (!chatId || !this.bot) {
      logger.warn({ targetId, chatId }, 'Telegram send: no valid chat ID');
      return;
    }
    const timeSuffix = elapsedMs != null ? `\n⏱ ${(elapsedMs / 1000).toFixed(1)}s` : '';
    const fullContent = content + timeSuffix;
    const html = mdToTelegram(fullContent);
    const chunks = this.splitMessage(html, MAX_MESSAGE_LENGTH);

    for (const chunk of chunks) {
      try {
        await this.bot.api.sendMessage(chatId, chunk, { parse_mode: 'HTML' });
      } catch (err: any) {
        logger.warn({ err: err.message }, 'HTML parse failed, sending as plain text');
        try {
          await this.bot.api.sendMessage(chatId, this.stripHtml(chunk));
        } catch (err2: any) {
          logger.error({ err: err2.message }, 'Telegram send failed');
        }
      }
    }
  }

  async sendFile(filePath: string, targetId?: string): Promise<void> {
    const chatId = this.parseChatId(targetId);
    if (!chatId || !this.bot) {
      logger.warn({ targetId, chatId }, 'Telegram sendFile: no valid chat ID');
      return;
    }
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      await this.bot.api.sendMessage(chatId, `File not found: ${filePath}`);
      return;
    }

    const inputFile = new InputFile(resolved);
    const filename = path.basename(resolved);
    const ext = path.extname(resolved).toLowerCase();

    try {
      if (this.isImageFile(ext)) {
        await this.bot.api.sendPhoto(chatId, inputFile, { caption: filename });
      } else if (this.isAudioFile(ext)) {
        await this.bot.api.sendAudio(chatId, inputFile, { title: filename });
      } else if (this.isVideoFile(ext)) {
        await this.bot.api.sendVideo(chatId, inputFile, { caption: filename });
      } else {
        await this.bot.api.sendDocument(chatId, inputFile, { caption: filename });
      }
      logger.info({ file: resolved, chatId }, 'File sent via Telegram');
    } catch (err: any) {
      logger.error({ err: err.message, file: resolved }, 'Telegram sendFile failed');
      await this.bot.api.sendMessage(chatId, `Failed to send file: ${err.message}`).catch(() => {});
    }
  }

  async stream(content: AsyncIterable<string>, targetId?: string): Promise<string> {
    const chatId = this.parseChatId(targetId);
    if (!chatId || !this.bot) return '';

    let full = '';
    for await (const chunk of content) {
      full += chunk;
    }
    const html = mdToTelegram(full);
    try {
      await this.bot.api.sendMessage(chatId, html, { parse_mode: 'HTML' });
    } catch (err: any) {
      await this.bot.api.sendMessage(chatId, this.stripHtml(html));
    }
    return full;
  }

  async typing(targetId?: string): Promise<void> {
    const chatId = this.parseChatId(targetId);
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
      const html = mdToTelegram(full);
      try {
        await this.bot.api.sendMessage(chatId, html, { parse_mode: 'HTML' });
      } catch {
        await this.bot.api.sendMessage(chatId, this.stripHtml(html));
      }
    } finally {
      this.stopTypingLoop();
    }
  }

  private splitMessage(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      let splitAt = maxLen;
      if (remaining.length > maxLen) {
        const lastNewline = remaining.lastIndexOf('\n', maxLen);
        if (lastNewline > maxLen * 0.5) {
          splitAt = lastNewline + 1;
        }
      }
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt);
    }
    return chunks;
  }

  private stripHtml(html: string): string {
    return html
      .replace(/<\/?(b|i|s|u|code|pre|a|blockquote|strong|em)[^>]*>/gi, '')
      .replace(/<pre><code[^>]*>/gi, '')
      .replace(/<\/code><\/pre>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }

  private isImageFile(ext: string): boolean {
    return ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'].includes(ext);
  }

  private isAudioFile(ext: string): boolean {
    return ['.mp3', '.ogg', '.wav', '.flac', '.m4a'].includes(ext);
  }

  private isVideoFile(ext: string): boolean {
    return ['.mp4', '.mov', '.avi', '.mkv', '.webm'].includes(ext);
  }

  private parseChatId(targetId?: string): number | null {
    if (!targetId) return this.ownerChatId;
    if (targetId.startsWith('telegram:')) {
      const raw = Number(targetId.split(':')[1]);
      return isNaN(raw) ? this.ownerChatId : raw;
    }
    if (targetId === 'notification') return this.ownerChatId;
    const num = Number(targetId);
    return isNaN(num) ? this.ownerChatId : num;
  }

  private isAllowedChat(chatId: number): boolean {
    const allowed = this.config.channels.telegram.allowedChatIds;
    if (!allowed || allowed.length === 0) return true;
    return allowed.includes(chatId);
  }
}