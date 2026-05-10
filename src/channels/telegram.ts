import fs from 'node:fs';
import path from 'node:path';
import { Bot, InputFile, InlineKeyboard } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import type { ChannelMessage } from '../types/channel.js';
import { BaseChannel, type PermissionMode } from './base.js';
import type { MercuryConfig, TelegramAccessUser, TelegramPendingRequest } from '../utils/config.js';
import {
  addTelegramPendingRequest,
  approveTelegramPendingRequest,
  clearTelegramAccess,
  findTelegramAdmin,
  findTelegramApprovedUser,
  findTelegramPendingRequest,
  getTelegramAccessSummary,
  getTelegramAdmins,
  getTelegramApprovedChatIds,
  hasTelegramAdmins,
  rejectTelegramPendingRequest,
  saveConfig,
} from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { mdToTelegram } from '../utils/markdown.js';
import { formatToolStep, formatToolResult } from '../utils/tool-label.js';

const MAX_MESSAGE_LENGTH = 4096;
const ACCESS_ACTION_PREFIX = 'tg_access';
const MEMORY_ACTION_PREFIX = 'tg_memory';

type ApprovalResolver = () => void;

export class TelegramChannel extends BaseChannel {
  readonly type = 'telegram' as const;
  private bot: Bot | null = null;
  private lastActiveChatId: number | null = null;
  private typingInterval: NodeJS.Timeout | null = null;
  private chatCommandContext?: import('../capabilities/registry.js').ChatCommandContext;
  private pendingApprovals: Map<string, ApprovalResolver> = new Map();
  private permissionModes = new Map<number, PermissionMode>();
  private onPermissionMode?: (mode: PermissionMode, chatId: number) => void;
  private statusMessageIds = new Map<string, number>();
  private stepCounters = new Map<string, number>();
  private stepHistory = new Map<string, string[]>();
  private statusText = new Map<string, string>();
  /** Track all ephemeral message IDs (permissions, loops, status) per chat for cleanup */
  private ephemeralMessageIds = new Map<string, number[]>();
  /** Track pinned status message per chat (only one at a time) */
  private pinnedMessageIds = new Map<string, number>();
  /** Minimum steps before we pin the status card */
  private static readonly PIN_STEP_THRESHOLD = 3;
  /** Whether a task is currently active per chat — gates message routing */
  private taskActive = new Map<string, boolean>();
  /** Deferred AI responses to send after task completes */
  private deferredResponses = new Map<string, string>();
  /** Notices appended to the status card during a task (Autopilot warnings, etc.) */
  private statusNotices = new Map<string, string[]>();
  /** Maximum number of notice lines to show in the status card */
  private static readonly MAX_STATUS_NOTICES = 3;

  constructor(private config: MercuryConfig) {
    super();
  }

  setChatCommandContext(ctx: import('../capabilities/registry.js').ChatCommandContext): void {
    this.chatCommandContext = ctx;
  }

  /** Mark a task as active — routes send() through the status card */
  beginTask(targetId?: string): void {
    const key = targetId || 'notification';
    this.taskActive.set(key, true);
    this.deferredResponses.delete(key);
    this.statusNotices.delete(key);
  }

  /** Mark task as ended — allows normal send() again */
  endTask(targetId?: string): void {
    const key = targetId || 'notification';
    this.taskActive.set(key, false);
  }

  /** Check if a task is currently active */
  isTaskActive(targetId?: string): boolean {
    const key = targetId || 'notification';
    return this.taskActive.get(key) ?? false;
  }

  /** Get and clear deferred response text (to send after task cleanup) */
  popDeferredResponse(targetId?: string): string | undefined {
    const key = targetId || 'notification';
    const text = this.deferredResponses.get(key);
    this.deferredResponses.delete(key);
    return text;
  }

  setOnPermissionMode(handler: (mode: PermissionMode, chatId: number) => void): void {
    this.onPermissionMode = handler;
  }

  getPermissionMode(chatId: number): PermissionMode {
    return this.permissionModes.get(chatId) ?? 'ask-me';
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
      const userId = ctx.from?.id;
      const username = ctx.from?.username;
      const firstName = ctx.from?.first_name;
      const text = ctx.message.text?.trim() || '';
      const command = this.getCommandName(text);

      if (!userId) return;

      if (ctx.chat.type !== 'private') {
        await this.sendDirectMessage(chatId, 'This bot is only available in private one-to-one chats.');
        return;
      }

      if (command === '/start' || command === '/pair') {
        await this.handleAccessRequest(userId, chatId, username, firstName);
        return;
      }

      const approvedUser = findTelegramApprovedUser(this.config, userId);
      if (!approvedUser) {
        const pending = findTelegramPendingRequest(this.config, userId);
        if (pending) {
          await this.sendDirectMessage(chatId, this.getPendingStatusMessage());
        } else {
          await this.sendDirectMessage(chatId, 'This bot is not available to you. Send /start to request access.');
        }
        return;
      }

      if (command === '/memory') {
        if (!this.chatCommandContext) {
          await this.sendDirectMessage(chatId, 'Memory not available.');
          return;
        }
        await this.sendMemoryKeyboard(chatId);
        return;
      }

      this.lastActiveChatId = chatId;
      logger.info({ chatId, text: ctx.message.text?.slice(0, 50) }, 'Telegram message received');

      if (!this.permissionModes.has(chatId) && this.onPermissionMode) {
        this.askPermissionMode(`telegram:${chatId}`).then((mode) => {
          this.permissionModes.set(chatId, mode);
          if (this.onPermissionMode) {
            this.onPermissionMode(mode, chatId);
          }
        }).catch(() => {});
        this.permissionModes.set(chatId, 'ask-me');
      }

      if (command === '/unpair') {
        if (!this.isAdminUser(userId)) {
          await this.sendDirectMessage(chatId, 'Only Telegram admins can reset Telegram access.');
          return;
        }

        this.resetAccess();
        await this.sendDirectMessage(
          chatId,
          'Telegram access reset. New users can send /start to request access. The first request must be approved from the Mercury CLI.',
        );
        return;
      }

      if (command === '/permissions') {
        this.askPermissionMode(`telegram:${chatId}`).then((mode) => {
          this.permissionModes.set(chatId, mode);
          if (this.onPermissionMode) {
            this.onPermissionMode(mode, chatId);
          }
        }).catch(() => {});
        return;
      }

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

    bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data;
      if (data.startsWith(`${ACCESS_ACTION_PREFIX}:`)) {
        await this.handleAccessCallback(ctx, data);
        return;
      }

      if (data.startsWith(`${MEMORY_ACTION_PREFIX}:`)) {
        await this.handleMemoryCallback(ctx, data);
        return;
      }

      const resolver = this.pendingApprovals.get(data);
      if (!resolver) {
        await ctx.answerCallbackQuery({ text: 'Expired' });
        return;
      }

      this.pendingApprovals.delete(data);
      resolver();
      const action = data.split(':')[1];
      await ctx.answerCallbackQuery({ text: action === 'no' ? 'Denied' : 'Approved' });
    });

    bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    this.bot = bot;

    await new Promise<void>((resolve, reject) => {
      let settled = false;

      void bot.start({
        onStart: async (info) => {
          logger.info({ bot: info.username }, 'Telegram bot started — long polling active');
          this.ready = true;
          await this.registerCommands();
          if (!settled) {
            settled = true;
            resolve();
          }
        },
      }).catch((err: any) => {
        if (!settled) {
          settled = true;
          const message = err?.description || err?.message || String(err);
          if (err?.error_code === 401) {
            reject(new Error(`Telegram bot token is invalid. Get a fresh token from @BotFather via /token.\n  Details: ${message}`));
          } else if (err?.error_code === 404) {
            reject(new Error(`Telegram bot not found — the token may be wrong or the bot was deleted. Verify with @BotFather.\n  Details: ${message}`));
          } else if (err?.error_code === 429) {
            reject(new Error(`Telegram is rate-limiting this bot. Wait a minute and try again.\n  Details: ${message}`));
          } else if (err?.error_code === 403) {
            reject(new Error(`Telegram bot lacks permission for this action. Check bot scopes with @BotFather.\n  Details: ${message}`));
          } else {
            reject(new Error(`Telegram bot failed to start: ${message}`));
          }
          return;
        }
        logger.error({ err: err.message }, 'Telegram bot start loop failed after startup');
      });
    });
  }

  private async registerCommands(): Promise<void> {
    if (!this.bot) return;

    const commands = [
      { command: 'start', description: 'Request Telegram access to this Mercury instance' },
      { command: 'help', description: 'Show available commands' },
      { command: 'status', description: 'Show agent config, budget, and uptime' },
      { command: 'progress', description: 'Live status for the current task' },
      { command: 'stop', description: 'Stop all agents and clear queue' },
      { command: 'budget', description: 'Token budget status and management' },
      { command: 'stream', description: 'Toggle text streaming on/off' },
      { command: 'memory', description: 'View and manage second brain memory' },
      { command: 'permissions', description: 'Change permission mode (Ask Me / Allow All)' },
      { command: 'models', description: 'List providers or switch AI model' },
      { command: 'code', description: 'Programming mode (plan / execute / off)' },
      { command: 'agents', description: 'List and manage sub-agents' },
      { command: 'bg', description: 'Background tasks (list / cancel / run)' },
      { command: 'spotify', description: 'Spotify playback controls' },
      { command: 'unpair', description: 'Reset all Telegram access (admin only)' },
    ];

    try {
      await this.bot.api.setMyCommands(commands);
      logger.info({ count: commands.length }, 'Telegram bot commands registered');
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Failed to register Telegram commands (non-critical)');
    }
  }

  async stop(): Promise<void> {
    this.bot?.stop();
    this.ready = false;
    this.stopTypingLoop();
  }

  async send(content: string, targetId?: string, elapsedMs?: number): Promise<void> {
    const chatIds = this.resolveTargetChatIds(targetId);
    if (chatIds.length === 0 || !this.bot) {
      logger.warn({ targetId, chatIds }, 'Telegram send: no valid chat IDs');
      return;
    }

    const key = targetId || 'notification';

    // During an active task, route messages through the status card instead of creating new messages
    if (this.taskActive.get(key)) {
      const timeSuffix = elapsedMs != null ? ` (${(elapsedMs / 1000).toFixed(1)}s)` : '';
      const fullContent = content + timeSuffix;
      if (!fullContent.trim()) return;

      // If this looks like a final AI response (long, not a system notice), defer it
      const isSystemNotice = content.startsWith('☿ ') || content.startsWith('⚠') || content.startsWith('  [') || content.length < 200;
      if (isSystemNotice) {
        // Append as a notice line in the status card
        const notices = this.statusNotices.get(key) || [];
        // Truncate long notices to keep status card compact
        const truncated = fullContent.length > 80 ? fullContent.slice(0, 77) + '…' : fullContent;
        notices.push(truncated);
        this.statusNotices.set(key, notices);
        // Refresh the status card to include the notice
        await this.refreshStatusCard(targetId);
      } else {
        // Defer the full response — will be sent after task completes
        this.deferredResponses.set(key, fullContent);
      }
      return;
    }

    const timeSuffix = elapsedMs != null ? `\n⏱ ${(elapsedMs / 1000).toFixed(1)}s` : '';
    const fullContent = content + timeSuffix;
    if (!fullContent.trim()) {
      logger.info({ targetId }, 'Telegram send: skipping empty message');
      return;
    }
    const html = mdToTelegram(fullContent);
    const chunks = this.splitMessage(html, MAX_MESSAGE_LENGTH);

    for (const chatId of chatIds) {
      for (const chunk of chunks) {
        try {
          await this.bot.api.sendMessage(chatId, chunk, { parse_mode: 'HTML' });
        } catch (err: any) {
          logger.warn({ err: err.message, chatId }, 'HTML parse failed, sending as plain text');
          try {
            await this.bot.api.sendMessage(chatId, this.stripHtml(chunk));
          } catch (err2: any) {
            logger.error({ err: err2.message, chatId }, 'Telegram send failed');
          }
        }
      }
    }
  }

  async sendFile(filePath: string, targetId?: string): Promise<void> {
    const chatIds = this.resolveTargetChatIds(targetId);
    if (chatIds.length === 0 || !this.bot) {
      logger.warn({ targetId, chatIds }, 'Telegram sendFile: no valid chat IDs');
      return;
    }

    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      for (const chatId of chatIds) {
        await this.bot.api.sendMessage(chatId, `File not found: ${filePath}`).catch(() => {});
      }
      return;
    }

    const filename = path.basename(resolved);
    const ext = path.extname(resolved).toLowerCase();

    for (const chatId of chatIds) {
      const inputFile = new InputFile(resolved);

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
        logger.error({ err: err.message, file: resolved, chatId }, 'Telegram sendFile failed');
        await this.bot.api.sendMessage(chatId, `Failed to send file: ${err.message}`).catch(() => {});
      }
    }
  }

  async stream(content: AsyncIterable<string>, targetId?: string): Promise<string> {
    const chatIds = this.resolveTargetChatIds(targetId);
    if (chatIds.length === 0 || !this.bot) return '';

    let full = '';
    for await (const chunk of content) {
      full += chunk;
    }

    const key = targetId || 'notification';
    // During an active task, defer the streamed response
    if (this.taskActive.get(key)) {
      this.deferredResponses.set(key, full);
      return full;
    }

    this.deleteStatusMessage(targetId);

    const html = mdToTelegram(full);
    for (const chatId of chatIds) {
      try {
        await this.bot.api.sendMessage(chatId, html, { parse_mode: 'HTML' });
      } catch (err: any) {
        await this.bot.api.sendMessage(chatId, this.stripHtml(html)).catch(() => {});
      }
    }
    return full;
  }

  async sendToolFeedback(toolName: string, args: Record<string, any>, targetId?: string): Promise<void> {
    const key = targetId || 'notification';
    const step = (this.stepCounters.get(key) || 0) + 1;
    this.stepCounters.set(key, step);
    const label = formatToolStep(toolName, args);

    // Build a rolling progress view: completed steps + current
    const history = this.stepHistory.get(key) || [];
    // Keep last 5 completed steps visible
    const recentHistory = history.slice(-5);
    const lines = [
      `⚙️ **Mercury working** (step ${step})`,
      '',
      ...recentHistory.map(h => `✅ ${h}`),
      `⏳ ${label}…`,
    ];
    await this.updateStatusMessage(lines.join('\n'), targetId);

    // Pin the status card once we hit the threshold (substantial task)
    if (step === TelegramChannel.PIN_STEP_THRESHOLD) {
      await this.pinStatusMessage(targetId);
    }
  }

  async sendStepDone(toolName: string, result: unknown, targetId?: string): Promise<void> {
    const key = targetId || 'notification';
    const step = this.stepCounters.get(key) || 0;
    const summary = formatToolResult(toolName, result);
    const label = formatToolStep(toolName, {} as any);
    const doneLine = summary ? `${label} · ${summary}` : label;

    // Add to history
    const history = this.stepHistory.get(key) || [];
    history.push(doneLine);
    this.stepHistory.set(key, history);

    // Update progress view
    const recentHistory = history.slice(-5);
    const lines = [
      `⚙️ **Mercury working** (${step} steps done)`,
      '',
      ...recentHistory.map(h => `✅ ${h}`),
    ];
    await this.updateStatusMessage(lines.join('\n'), targetId);
  }

  async typing(targetId?: string): Promise<void> {
    const chatIds = this.resolveTargetChatIds(targetId);
    if (chatIds.length === 0 || !this.bot) return;
    await this.bot.api.sendChatAction(chatIds[0], 'typing');
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

  async sendStreamToChat(chatId: number, textStream: AsyncIterable<string>): Promise<string> {
    if (!this.bot) return '';

    // During an active task, collect the stream and defer it
    // Check all task-active keys since we have chatId not targetId
    const activeKey = this.findActiveTaskKey(chatId);
    if (activeKey) {
      let full = '';
      for await (const chunk of textStream) {
        full += chunk;
      }
      this.deferredResponses.set(activeKey, full);
      return full;
    }

    const STREAM_EDIT_INTERVAL = 1500;
    const STREAM_MIN_LENGTH = 20;

    this.startTypingLoop(chatId);

    try {
      let full = '';
      let messageId: number | null = null;
      let lastEditTime = 0;
      let lastEditLength = 0;

      for await (const chunk of textStream) {
        full += chunk;

        const now = Date.now();
        const timeSinceLastEdit = now - lastEditTime;
        const charsSinceLastEdit = full.length - lastEditLength;

        if (messageId === null && full.length >= STREAM_MIN_LENGTH) {
          try {
            const msg = await this.bot.api.sendMessage(chatId, this.escapeHtml(full) + ' ▌', { parse_mode: 'HTML' });
            messageId = msg.message_id;
            lastEditTime = now;
            lastEditLength = full.length;
          } catch {
            messageId = null;
          }
        } else if (messageId !== null && timeSinceLastEdit >= STREAM_EDIT_INTERVAL && charsSinceLastEdit >= 20) {
          try {
            await this.bot.api.editMessageText(chatId, messageId, this.escapeHtml(full) + ' ▌', { parse_mode: 'HTML' });
            lastEditTime = now;
            lastEditLength = full.length;
          } catch {
            // edit failed — rate limited or message unchanged, skip
          }
        }
      }

      if (messageId !== null) {
        const html = mdToTelegram(full);
        try {
          await this.bot.api.editMessageText(chatId, messageId, html, { parse_mode: 'HTML' });
        } catch {
          try {
            await this.bot.api.editMessageText(chatId, messageId, this.stripHtml(html));
          } catch {
            // final edit failed
          }
        }
      } else if (full.trim()) {
        const html = mdToTelegram(full);
        const stripped = this.stripHtml(html);
        try {
          await this.bot.api.sendMessage(chatId, html, { parse_mode: 'HTML' });
        } catch {
          if (stripped.trim()) {
            try {
              await this.bot.api.sendMessage(chatId, stripped);
            } catch {
              // plain text send also failed
            }
          }
        }
      }

      return full;
    } finally {
      this.stopTypingLoop();
    }
  }

  async askPermission(prompt: string, targetId?: string): Promise<string> {
    const chatIds = this.resolveTargetChatIds(targetId);
    const chatId = chatIds[0];
    if (!chatId || !this.bot) return 'no';

    const id = `perm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const keyboard = new InlineKeyboard()
      .text('Allow', `${id}:yes`)
      .text('Always', `${id}:always`)
      .text('Deny', `${id}:no`);

    const html = mdToTelegram(prompt);
    let sentMsgId: number | undefined;

    try {
      const msg = await this.bot.api.sendMessage(chatId, html, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
      sentMsgId = msg.message_id;
    } catch {
      const msg = await this.bot.api.sendMessage(chatId, this.stripHtml(html), {
        reply_markup: keyboard,
      });
      sentMsgId = msg.message_id;
    }

    if (sentMsgId) this.trackEphemeral(targetId, sentMsgId);

    return new Promise((resolve) => {
      const cleanup = (result: string) => {
        this.pendingApprovals.delete(`${id}:yes`);
        this.pendingApprovals.delete(`${id}:always`);
        this.pendingApprovals.delete(`${id}:no`);
        // Delete the permission card immediately
        if (sentMsgId) this.deleteEphemeralMessage(targetId, sentMsgId);
        resolve(result);
      };
      this.pendingApprovals.set(`${id}:yes`, () => cleanup('yes'));
      this.pendingApprovals.set(`${id}:always`, () => cleanup('always'));
      this.pendingApprovals.set(`${id}:no`, () => cleanup('no'));

      setTimeout(() => {
        this.pendingApprovals.delete(`${id}:yes`);
        this.pendingApprovals.delete(`${id}:always`);
        this.pendingApprovals.delete(`${id}:no`);
        if (sentMsgId) this.deleteEphemeralMessage(targetId, sentMsgId);
        resolve('no');
      }, 120_000);
    });
  }

  async askToContinue(question: string, targetId?: string): Promise<boolean> {
    const chatIds = this.resolveTargetChatIds(targetId);
    const chatId = chatIds[0];
    if (!chatId || !this.bot) return false;

    const id = `loop_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const keyboard = new InlineKeyboard()
      .text('Continue', `${id}:yes`)
      .text('Stop', `${id}:no`);

    let sentMsgId: number | undefined;
    try {
      const msg = await this.bot.api.sendMessage(chatId, mdToTelegram(question), {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
      sentMsgId = msg.message_id;
    } catch {
      const msg = await this.bot.api.sendMessage(chatId, question, {
        reply_markup: keyboard,
      });
      sentMsgId = msg.message_id;
    }

    if (sentMsgId) this.trackEphemeral(targetId, sentMsgId);

    return new Promise((resolve) => {
      const cleanup = (result: boolean) => {
        this.pendingApprovals.delete(`${id}:yes`);
        this.pendingApprovals.delete(`${id}:no`);
        if (sentMsgId) this.deleteEphemeralMessage(targetId, sentMsgId);
        resolve(result);
      };
      this.pendingApprovals.set(`${id}:yes`, () => cleanup(true));
      this.pendingApprovals.set(`${id}:no`, () => cleanup(false));

      setTimeout(() => {
        this.pendingApprovals.delete(`${id}:yes`);
        this.pendingApprovals.delete(`${id}:no`);
        if (sentMsgId) this.deleteEphemeralMessage(targetId, sentMsgId);
        resolve(false);
      }, 120_000);
    });
  }

  async askPermissionMode(targetId?: string): Promise<PermissionMode> {
    const chatIds = this.resolveTargetChatIds(targetId);
    const chatId = chatIds[0];
    if (!chatId || !this.bot) return 'ask-me';

    const id = `perm_mode_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const keyboard = new InlineKeyboard()
      .text('🔒 Ask Me', `${id}:ask-me`)
      .text('✅ Allow All', `${id}:allow-all`);

    const html = `<b>Permission Mode</b>\nHow should Mercury handle risky actions this session?\n\n🔒 <b>Ask Me</b> — confirm before file writes, commands, and scope changes\n✅ <b>Allow All</b> — auto-approve everything (scopes, commands, loops)`;

    let sentMsgId: number | undefined;
    try {
      const msg = await this.bot.api.sendMessage(chatId, html, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
      sentMsgId = msg.message_id;
    } catch {
      const msg = await this.bot.api.sendMessage(chatId, this.stripHtml(html), {
        reply_markup: keyboard,
      });
      sentMsgId = msg.message_id;
    }

    if (sentMsgId) this.trackEphemeral(targetId, sentMsgId);

    return new Promise((resolve) => {
      const cleanup = (result: PermissionMode) => {
        this.pendingApprovals.delete(`${id}:ask-me`);
        this.pendingApprovals.delete(`${id}:allow-all`);
        if (sentMsgId) this.deleteEphemeralMessage(targetId, sentMsgId);
        resolve(result);
      };
      this.pendingApprovals.set(`${id}:ask-me`, () => cleanup('ask-me'));
      this.pendingApprovals.set(`${id}:allow-all`, () => cleanup('allow-all'));

      setTimeout(() => {
        this.pendingApprovals.delete(`${id}:ask-me`);
        this.pendingApprovals.delete(`${id}:allow-all`);
        if (sentMsgId) this.deleteEphemeralMessage(targetId, sentMsgId);
        resolve('ask-me');
      }, 120_000);
    });
  }

  private async handleAccessRequest(
    userId: number,
    chatId: number,
    username?: string,
    firstName?: string,
  ): Promise<void> {
    const approvedUser = findTelegramApprovedUser(this.config, userId);
    if (approvedUser) {
      await this.sendDirectMessage(chatId, this.getApprovedStatusMessage(approvedUser));
      return;
    }

    const existingRequest = findTelegramPendingRequest(this.config, userId);
    if (existingRequest) {
      await this.sendDirectMessage(chatId, this.getPendingStatusMessage(existingRequest));
      return;
    }

    if (!hasTelegramAdmins(this.config) && this.config.channels.telegram.pending.length > 0) {
      await this.sendDirectMessage(
        chatId,
        'Initial Telegram pairing is already in progress for another user. Ask the Mercury operator to finish setup or reset Telegram access first.',
      );
      return;
    }

    const request = addTelegramPendingRequest(this.config, {
      userId,
      chatId,
      username,
      firstName,
      pairingCode: hasTelegramAdmins(this.config) ? undefined : this.generatePairingCode(),
    });
    saveConfig(this.config);
    logger.info({ chatId, userId, username }, 'Telegram access request recorded');

    await this.sendDirectMessage(chatId, this.getPendingStatusMessage(request));

    if (!hasTelegramAdmins(this.config)) {
      return;
    }

    await this.notifyAdminsOfPendingRequest(request);
  }

  private async notifyAdminsOfPendingRequest(request: TelegramPendingRequest): Promise<void> {
    if (!this.bot) return;

    const keyboard = new InlineKeyboard()
      .text('Approve', `${ACCESS_ACTION_PREFIX}:approve:${request.userId}`)
      .text('Reject', `${ACCESS_ACTION_PREFIX}:reject:${request.userId}`);

    const username = request.username ? ` (@${request.username})` : '';
    const firstName = request.firstName ? ` (${request.firstName})` : '';
    const message = [
      'Telegram access request pending approval.',
      '',
      `User ID: ${request.userId}${username}${firstName}`,
      `Requested: ${new Date(request.requestedAt).toLocaleString()}`,
      '',
      'Use the buttons below to approve or reject this user.',
    ].join('\n');

    for (const admin of getTelegramAdmins(this.config)) {
      try {
        await this.bot.api.sendMessage(admin.chatId, mdToTelegram(message), {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        });
      } catch {
        await this.bot.api.sendMessage(admin.chatId, message, {
          reply_markup: keyboard,
        }).catch(() => {});
      }
    }
  }

  private async handleAccessCallback(ctx: Parameters<Bot['on']>[1] extends never ? never : any, data: string): Promise<void> {
    const actorUserId = ctx.from?.id;
    const actorChatId = ctx.chat?.id;
    if (!actorUserId || !actorChatId) {
      await ctx.answerCallbackQuery({ text: 'Unavailable' });
      return;
    }

    if (!this.isAdminUser(actorUserId)) {
      await ctx.answerCallbackQuery({ text: 'Admins only' });
      return;
    }

    const [, action, rawUserId] = data.split(':');
    const requestUserId = Number(rawUserId);
    if (!requestUserId) {
      await ctx.answerCallbackQuery({ text: 'Invalid request' });
      return;
    }

    const request = findTelegramPendingRequest(this.config, requestUserId);
    if (!request) {
      await ctx.answerCallbackQuery({ text: 'Already handled' });
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
      return;
    }

    if (action === 'approve') {
      const approved = approveTelegramPendingRequest(this.config, requestUserId, 'member');
      if (!approved) {
        await ctx.answerCallbackQuery({ text: 'Already handled' });
        return;
      }

      saveConfig(this.config);
      await ctx.answerCallbackQuery({ text: 'Approved' });
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
      await this.sendDirectMessage(
        request.chatId,
        `Telegram access approved. You can now chat with Mercury.\n\nTelegram access: ${getTelegramAccessSummary(this.config)}`,
      );
      await this.sendDirectMessage(actorChatId, `Approved Telegram access for ${this.formatRequestLabel(request)}.`);
      return;
    }

    if (action === 'reject') {
      const rejected = rejectTelegramPendingRequest(this.config, requestUserId);
      if (!rejected) {
        await ctx.answerCallbackQuery({ text: 'Already handled' });
        return;
      }

      saveConfig(this.config);
      await ctx.answerCallbackQuery({ text: 'Rejected' });
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
      await this.sendDirectMessage(
        request.chatId,
        'Your Telegram access request was rejected. This bot is not available to you.',
      );
      await this.sendDirectMessage(actorChatId, `Rejected Telegram access for ${this.formatRequestLabel(request)}.`);
      return;
    }

    await ctx.answerCallbackQuery({ text: 'Unknown action' });
  }

  private async sendMemoryKeyboard(chatId: number): Promise<void> {
    if (!this.bot || !this.chatCommandContext) return;

    const summary = this.chatCommandContext.memorySummary();
    const lines = [
      `<b>Memory Overview</b>`,
      `Total memories: ${summary.total}`,
      `Learning: ${summary.learningPaused ? '⏸ PAUSED' : '✅ ACTIVE'}`,
    ];
    if (summary.profileSummary) {
      lines.push(`\n<i>Profile: ${this.escapeHtml(summary.profileSummary)}</i>`);
    }
    const typeEntries = Object.entries(summary.byType);
    if (typeEntries.length > 0) {
      lines.push('\n<b>By type:</b>');
      for (const [type, count] of typeEntries) {
        lines.push(`  ${type}: ${count}`);
      }
    }

    const learningLabel = summary.learningPaused ? '▶ Resume' : '⏸ Pause';
    const keyboard = new InlineKeyboard()
      .text('📋 Overview', `${MEMORY_ACTION_PREFIX}:overview`)
      .text('🔍 Recent', `${MEMORY_ACTION_PREFIX}:recent`)
      .row()
      .text(learningLabel, `${MEMORY_ACTION_PREFIX}:toggle_learning`)
      .text('🗑 Clear All', `${MEMORY_ACTION_PREFIX}:clear_confirm`);

    await this.bot.api.sendMessage(chatId, lines.join('\n'), {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    }).catch(async () => {
      await this.bot!.api.sendMessage(chatId, lines.join('\n'), { reply_markup: keyboard });
    });
  }

  private async handleMemoryCallback(ctx: any, data: string): Promise<void> {
    if (!this.bot || !this.chatCommandContext) {
      await ctx.answerCallbackQuery({ text: 'Not available' });
      return;
    }

    const action = data.slice(`${MEMORY_ACTION_PREFIX}:`.length);
    const chatId = ctx.callbackQuery.message?.chat?.id;
    if (!chatId) {
      await ctx.answerCallbackQuery({ text: 'Error' });
      return;
    }

    if (action === 'overview') {
      await ctx.answerCallbackQuery({ text: 'Overview' });
      const summary = this.chatCommandContext.memorySummary();
      const lines = [
        `<b>Memory Overview</b>`,
        `Total memories: ${summary.total}`,
        `Learning: ${summary.learningPaused ? '⏸ PAUSED' : '✅ ACTIVE'}`,
      ];
      if (summary.profileSummary) {
        lines.push(`\n<i>Profile: ${this.escapeHtml(summary.profileSummary)}</i>`);
      }
      if (summary.activeSummary) {
        lines.push(`<i>Active: ${this.escapeHtml(summary.activeSummary)}</i>`);
      }
      const typeEntries = Object.entries(summary.byType);
      if (typeEntries.length > 0) {
        lines.push('\n<b>By type:</b>');
        for (const [type, count] of typeEntries) {
          lines.push(`  ${type}: ${count}`);
        }
      }
      await this.bot.api.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' }).catch(async () => {
        await this.bot!.api.sendMessage(chatId, lines.join('\n'));
      });
      return;
    }

    if (action === 'recent') {
      await ctx.answerCallbackQuery({ text: 'Recent memories' });
      const recent = this.chatCommandContext.memoryRecent(10);
      if (recent.length === 0) {
        await this.bot.api.sendMessage(chatId, 'No memories yet.').catch(() => {});
        return;
      }
      const lines = ['<b>Recent Memories:</b>\n'];
      for (const r of recent) {
        const scope = r.scope === 'active' ? '⏳' : '📌';
        lines.push(`${scope} [${r.type}] ${this.escapeHtml(r.summary)}`);
        lines.push(`   Confidence: ${r.confidence.toFixed(2)} | Evidence: ${r.evidenceKind} | Seen: ${r.evidenceCount}x`);
      }
      await this.bot.api.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' }).catch(async () => {
        await this.bot!.api.sendMessage(chatId, lines.join('\n'));
      });
      return;
    }

    if (action === 'toggle_learning') {
      const currentSummary = this.chatCommandContext.memorySummary();
      const currentlyPaused = currentSummary.learningPaused;
      this.chatCommandContext.memorySetLearningPaused(!currentlyPaused);
      const label = currentlyPaused ? '▶ Learning resumed' : '⏸ Learning paused';
      await ctx.answerCallbackQuery({ text: label });
      await this.bot.api.sendMessage(chatId, currentlyPaused
        ? 'Learning resumed. Mercury will remember new things from conversations.'
        : 'Learning paused. Mercury will not store new memories until resumed.',
      ).catch(() => {});
      await this.sendMemoryKeyboard(chatId);
      return;
    }

    if (action === 'clear_confirm') {
      const keyboard = new InlineKeyboard()
        .text('🗑 Yes, clear everything', `${MEMORY_ACTION_PREFIX}:clear_yes`)
        .text('✖ Cancel', `${MEMORY_ACTION_PREFIX}:clear_no`);
      await ctx.answerCallbackQuery({});
      await this.bot.api.sendMessage(chatId, '⚠️ Are you sure you want to clear <b>all</b> memories? This cannot be undone.', {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      }).catch(async () => {
        await this.bot!.api.sendMessage(chatId, '⚠️ Are you sure you want to clear all memories?', { reply_markup: keyboard });
      });
      return;
    }

    if (action === 'clear_yes') {
      const cleared = this.chatCommandContext.memoryClear();
      await ctx.answerCallbackQuery({ text: `Cleared ${cleared} memories` });
      await this.bot.api.sendMessage(chatId, `Cleared ${cleared} memories.`).catch(() => {});
      return;
    }

    if (action === 'clear_no') {
      await ctx.answerCallbackQuery({ text: 'Cancelled' });
      return;
    }

    await ctx.answerCallbackQuery({ text: 'Unknown action' });
  }

  private resolveTargetChatIds(targetId?: string): number[] {
    if (!targetId || targetId === 'notification') {
      return getTelegramApprovedChatIds(this.config);
    }

    if (targetId.startsWith('telegram:')) {
      const raw = Number(targetId.split(':')[1]);
      return isNaN(raw) ? [] : [raw];
    }

    const num = Number(targetId);
    return isNaN(num) ? [] : [num];
  }

  private isAdminUser(userId: number): boolean {
    return !!findTelegramAdmin(this.config, userId);
  }

  private getCommandName(text: string): string {
    return text.trim().split(/\s+/)[0]?.toLowerCase() || '';
  }

  private getPendingStatusMessage(request?: TelegramPendingRequest): string {
    if (!hasTelegramAdmins(this.config)) {
      const pairingCode = request?.pairingCode ?? 'unknown';
      return [
        'Your Telegram pairing request has been recorded.',
        '',
        `Pairing code: ${pairingCode}`,
        '',
        'Enter this code in the Mercury terminal to finish setup.',
      ].join('\n');
    }

    return 'Your Telegram access request has been recorded and is waiting for approval from a Telegram admin.';
  }

  private getApprovedStatusMessage(user: TelegramAccessUser): string {
    const role = this.isAdminUser(user.userId) ? 'admin' : 'member';
    return `You are already approved as a Telegram ${role}.\n\nTelegram access: ${getTelegramAccessSummary(this.config)}`;
  }

  private formatRequestLabel(request: TelegramPendingRequest): string {
    const username = request.username ? ` (@${request.username})` : '';
    const firstName = request.firstName ? ` ${request.firstName}` : '';
    return `${request.userId}${username}${firstName}`;
  }

  private resetAccess(): void {
    clearTelegramAccess(this.config);
    saveConfig(this.config);
    this.lastActiveChatId = null;
    logger.info('Telegram access reset');
  }

  private generatePairingCode(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
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

  /** Find the task-active key that matches a numeric chatId */
  private findActiveTaskKey(chatId: number): string | undefined {
    for (const [key, active] of this.taskActive) {
      if (!active) continue;
      // Keys can be 'notification', 'telegram:12345', or just '12345'
      if (key === 'notification') return key;
      const numericPart = key.startsWith('telegram:') ? key.split(':')[1] : key;
      if (numericPart === String(chatId)) return key;
    }
    return undefined;
  }

  /** Refresh the status card with current step history + notices */
  private async refreshStatusCard(targetId?: string): Promise<void> {
    const key = targetId || 'notification';
    const step = this.stepCounters.get(key) || 0;
    const history = this.stepHistory.get(key) || [];
    const notices = this.statusNotices.get(key) || [];

    const recentHistory = history.slice(-5);
    const recentNotices = notices.slice(-TelegramChannel.MAX_STATUS_NOTICES);

    const lines = [
      `⚙️ **Mercury working** (step ${step})`,
      '',
      ...recentHistory.map(h => `✅ ${h}`),
    ];

    if (recentNotices.length > 0) {
      lines.push('');
      lines.push(...recentNotices.map(n => `💬 ${n}`));
    }

    await this.updateStatusMessage(lines.join('\n'), targetId);
  }

  private async updateStatusMessage(text: string, targetId?: string): Promise<void> {
    const chatIds = this.resolveTargetChatIds(targetId);
    if (chatIds.length === 0 || !this.bot) return;

    const key = targetId || 'notification';
    this.statusText.set(key, text);
    const html = mdToTelegram(text);

    for (const chatId of chatIds) {
      const existingMsgId = this.statusMessageIds.get(key);
      if (existingMsgId) {
        try {
          await this.bot.api.editMessageText(chatId, existingMsgId, html, { parse_mode: 'HTML' });
          return;
        } catch {
          this.statusMessageIds.delete(key);
        }
      }

      try {
        const msg = await this.bot.api.sendMessage(chatId, html, { parse_mode: 'HTML' });
        this.statusMessageIds.set(key, msg.message_id);
      } catch {
        try {
          const msg = await this.bot.api.sendMessage(chatId, this.stripHtml(html));
          this.statusMessageIds.set(key, msg.message_id);
        } catch {
          logger.warn({ chatId }, 'Failed to send status message');
        }
      }
    }
  }

  private async deleteStatusMessage(targetId?: string): Promise<void> {
    const key = targetId || 'notification';
    const msgId = this.statusMessageIds.get(key);
    if (msgId && this.bot) {
      // Unpin before deleting if this was pinned
      await this.unpinStatusMessage(targetId);
      const chatIds = this.resolveTargetChatIds(targetId);
      for (const chatId of chatIds) {
        await this.bot.api.deleteMessage(chatId, msgId).catch(() => {});
      }
      this.statusMessageIds.delete(key);
      this.statusText.delete(key);
      this.stepCounters.delete(key);
    }
  }

  /** Pin the current status message to the top of the chat (silently) */
  private async pinStatusMessage(targetId?: string): Promise<void> {
    if (!this.bot) return;
    const key = targetId || 'notification';
    const msgId = this.statusMessageIds.get(key);
    if (!msgId) return;

    const chatIds = this.resolveTargetChatIds(targetId);
    for (const chatId of chatIds) {
      // Failsafe: unpin any existing pinned message first
      const existingPin = this.pinnedMessageIds.get(key);
      if (existingPin && existingPin !== msgId) {
        await this.bot.api.unpinChatMessage(chatId, existingPin).catch(() => {});
        this.pinnedMessageIds.delete(key);
      }

      // Don't re-pin the same message
      if (existingPin === msgId) return;

      try {
        await this.bot.api.pinChatMessage(chatId, msgId, { disable_notification: true });
        this.pinnedMessageIds.set(key, msgId);
        logger.info({ chatId, msgId }, 'Pinned status message');
      } catch (err: any) {
        logger.warn({ err: err.message, chatId }, 'Failed to pin status message');
      }
    }
  }

  /** Unpin the current status message */
  private async unpinStatusMessage(targetId?: string): Promise<void> {
    if (!this.bot) return;
    const key = targetId || 'notification';
    const msgId = this.pinnedMessageIds.get(key);
    if (!msgId) return;

    const chatIds = this.resolveTargetChatIds(targetId);
    for (const chatId of chatIds) {
      await this.bot.api.unpinChatMessage(chatId, msgId).catch(() => {});
    }
    this.pinnedMessageIds.delete(key);
  }

  /** Track a message ID as ephemeral (will be deleted on task completion) */
  private trackEphemeral(targetId: string | undefined, messageId: number): void {
    const key = targetId || 'notification';
    const ids = this.ephemeralMessageIds.get(key) || [];
    ids.push(messageId);
    this.ephemeralMessageIds.set(key, ids);
  }

  /** Delete a specific ephemeral message immediately (e.g., after permission response) */
  private async deleteEphemeralMessage(targetId: string | undefined, messageId: number): Promise<void> {
    if (!this.bot) return;
    const chatIds = this.resolveTargetChatIds(targetId);
    for (const chatId of chatIds) {
      await this.bot.api.deleteMessage(chatId, messageId).catch(() => {});
    }
    // Remove from tracking
    const key = targetId || 'notification';
    const ids = this.ephemeralMessageIds.get(key);
    if (ids) {
      const idx = ids.indexOf(messageId);
      if (idx !== -1) ids.splice(idx, 1);
    }
  }

  /** Clean up all ephemeral messages for a chat (called on task completion) */
  async cleanupEphemeralMessages(targetId?: string): Promise<void> {
    if (!this.bot) return;
    const key = targetId || 'notification';
    const ids = this.ephemeralMessageIds.get(key) || [];
    const chatIds = this.resolveTargetChatIds(targetId);
    for (const chatId of chatIds) {
      for (const msgId of ids) {
        await this.bot.api.deleteMessage(chatId, msgId).catch(() => {});
      }
    }
    this.ephemeralMessageIds.delete(key);
  }

  resetStepCounter(targetId?: string): void {
    const key = targetId || 'notification';
    this.stepCounters.delete(key);
    this.stepHistory.delete(key);
    this.statusText.delete(key);
    this.statusNotices.delete(key);
    this.endTask(targetId);
    this.deleteStatusMessage(targetId);
  }

  async sendCompletion(elapsedMs: number, stepCount: number, targetId?: string, meta?: { provider: string; model: string; inputTokens: number; outputTokens: number; totalTokens: number; budgetUsed: number; budgetTotal: number; budgetPercentage: number }): Promise<void> {
    const secs = Math.floor(elapsedMs / 1000);
    const mins = Math.floor(secs / 60);
    const remSecs = secs % 60;
    const timeStr = mins > 0 ? `${mins}m ${remSecs}s` : `${secs}s`;
    const stepsStr = stepCount > 0 ? `${stepCount} step${stepCount !== 1 ? 's' : ''}` : '';
    const parts = [stepsStr, timeStr].filter(Boolean).join(' · ');

    const key = targetId || 'notification';
    const history = this.stepHistory.get(key) || [];
    const recentHistory = history.slice(-5);

    const lines = [
      `✅ **Task complete** (${parts})`,
    ];

    if (meta) {
      const formatTokens = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
      lines.push(`☿ ${meta.model} via ${meta.provider} · ${formatTokens(meta.totalTokens)} tokens`);
      const pct = Math.round(meta.budgetPercentage);
      const barLen = 15;
      const filled = Math.round((pct / 100) * barLen);
      const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled);
      lines.push(`Budget: ${bar} ${pct}% (${formatTokens(meta.budgetUsed)} / ${formatTokens(meta.budgetTotal)})`);
    }

    if (recentHistory.length > 0) {
      lines.push('');
      lines.push(...recentHistory.map(h => `  ✓ ${h}`));
    }

    // Clean up: unpin + delete the status card, clean up ephemeral messages
    await this.deleteStatusMessage(targetId);
    await this.cleanupEphemeralMessages(targetId);

    // End the task so deferred response flush uses normal send()
    this.endTask(targetId);

    const chatIds = this.resolveTargetChatIds(targetId);

    // Flush deferred AI response first (the actual answer the user wants to see)
    const deferred = this.deferredResponses.get(key);
    if (deferred && deferred.trim()) {
      this.deferredResponses.delete(key);
      const deferredHtml = mdToTelegram(deferred);
      const chunks = this.splitMessage(deferredHtml, MAX_MESSAGE_LENGTH);
      for (const chatId of chatIds) {
        for (const chunk of chunks) {
          try {
            await this.bot?.api.sendMessage(chatId, chunk, { parse_mode: 'HTML' });
          } catch {
            await this.bot?.api.sendMessage(chatId, this.stripHtml(chunk)).catch(() => {});
          }
        }
      }
    }

    // Send the completion banner as a separate message
    const html = mdToTelegram(lines.join('\n'));
    for (const chatId of chatIds) {
      try {
        await this.bot?.api.sendMessage(chatId, html, { parse_mode: 'HTML' });
      } catch {
        await this.bot?.api.sendMessage(chatId, this.stripHtml(html)).catch(() => {});
      }
    }

    this.stepCounters.delete(key);
    this.stepHistory.delete(key);
    this.statusText.delete(key);
    this.statusMessageIds.delete(key);
    this.statusNotices.delete(key);
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

  private async sendDirectMessage(chatId: number, content: string): Promise<void> {
    if (!this.bot) return;
    try {
      await this.bot.api.sendMessage(chatId, mdToTelegram(content), { parse_mode: 'HTML' });
    } catch {
      await this.bot.api.sendMessage(chatId, content).catch(() => {});
    }
  }
}
