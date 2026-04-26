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
const FRIEND_ACTION_PREFIX = 'tg_friend';

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
  private statusText = new Map<string, string>();

  constructor(private config: MercuryConfig) {
    super();
  }

  setChatCommandContext(ctx: import('../capabilities/registry.js').ChatCommandContext): void {
    this.chatCommandContext = ctx;
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

      if (command === '/shared') {
        if (!this.chatCommandContext?.sharedMemorySummary) {
          await this.sendDirectMessage(chatId, 'Shared memory is not enabled.');
          return;
        }
        const summary = this.chatCommandContext.sharedMemorySummary();
        if (!summary) {
          await this.sendDirectMessage(chatId, 'Shared memory is not enabled.');
          return;
        }
        this.chatCommandContext.sharedMemorySetLearningPaused?.(!summary.learningPaused);
        await this.sendDirectMessage(chatId, summary.learningPaused
          ? 'Shared learning resumed. New memories will be stored in shared memory.'
          : 'Shared learning paused. Memories will NOT be shared until resumed.'
        );
        return;
      }

      if (command === '/friend') {
        const friendTgId = text.slice('/friend'.length).trim();
        if (!friendTgId) {
          const friends = this.chatCommandContext?.sharedMemoryGetFriends?.() ?? [];
          const pending = friends.filter(f => f.status === 'pending');
          const approved = friends.filter(f => f.status === 'approved');
          const lines = ['<b>/friend — Send a friend request</b>\n'];
          lines.push('Usage: /friend &lt;TELEGRAM_USER_ID&gt;');
          lines.push('Example: /friend 123456789\n');
          lines.push(`You have <b>${pending.length}</b> pending and <b>${approved.length}</b> approved friend(s).`);
          lines.push('Use /listfriends to see full details.');
          await this.sendDirectMessage(chatId, lines.join('\n'));
          return;
        }
        if (!/^\d+$/.test(friendTgId)) {
          await this.sendDirectMessage(chatId, 'Usage: /friend <TELEGRAM_USER_ID>\nExample: /friend 123456789');
          return;
        }
        let username: string | null = null;
        let firstName: string | null = null;
        try {
          const userInfo = await this.resolveTelegramUser(friendTgId);
          if (userInfo) {
            username = userInfo.username;
            firstName = userInfo.firstName;
          }
        } catch {}
        const displayName = username ? `@${username}` : firstName || friendTgId;
        const existing = this.chatCommandContext?.sharedMemoryGetFriend?.(friendTgId);
        if (existing) {
          const existingName = existing.username ? `@${existing.username}` : existing.firstName || friendTgId;
          await this.sendDirectMessage(chatId, `${existingName} (${friendTgId}) is already in your friend list (status: ${existing.status}).`);
          return;
        }
        this.chatCommandContext?.sharedMemoryAddFriendRequest?.(friendTgId, username ?? undefined, firstName ?? undefined);
        const relayResult = await this.chatCommandContext?.sendFriendRequest?.(friendTgId);
        if (relayResult) {
          await this.sendDirectMessage(chatId, `Friend request for ${displayName} (${friendTgId}) recorded and forwarded via relay.`);
        } else {
          await this.sendDirectMessage(chatId, `Friend request for ${displayName} (${friendTgId}) recorded locally. Relay unavailable — request will sync when relay reconnects.`);
        }
        return;
      }

      if (command === '/listfriends') {
        if (!this.chatCommandContext?.sharedMemorySummary) {
          await this.sendDirectMessage(chatId, 'Shared memory is not enabled.');
          return;
        }
        const friends = this.chatCommandContext.sharedMemoryGetFriends?.() ?? [];
        if (friends.length === 0) {
          await this.sendDirectMessage(chatId, 'No friends yet. Use /friend <TELEGRAM_USER_ID> to add someone.');
          return;
        }
        await this.sendFriendsKeyboard(chatId, friends);
        return;
      }

      if (command === '/exit' || command === '/quit') {
        await this.sendDirectMessage(chatId, 'Goodbye! Shutting down Mercury...');
        process.exit(0);
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

      if (data.startsWith(`${FRIEND_ACTION_PREFIX}:`)) {
        await this.handleFriendCallback(ctx, data);
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
      { command: 'pair', description: 'Request Telegram access to this Mercury instance' },
      { command: 'help', description: 'Show capabilities and commands manual' },
      { command: 'status', description: 'Show agent config, budget, and uptime' },
      { command: 'tools', description: 'List all loaded tools' },
      { command: 'skills', description: 'List installed skills' },
      { command: 'budget', description: 'Show token budget status' },
      { command: 'budget_override', description: 'Override budget for one request' },
      { command: 'budget_reset', description: 'Reset token usage to zero' },
      { command: 'budget_set', description: 'Set new daily token budget' },
      { command: 'stream', description: 'Toggle text streaming on/off' },
      { command: 'memory', description: 'View and manage second brain memory' },
      { command: 'shared', description: 'Toggle shared learning on/off' },
      { command: 'friend', description: 'Add a friend by Telegram user ID' },
      { command: 'listfriends', description: 'View and manage shared memory friends' },
      { command: 'exit', description: 'Shut down Mercury and exit' },
      { command: 'permissions', description: 'Change permission mode (Ask Me / Allow All)' },
      { command: 'tasks', description: 'List scheduled tasks' },
      { command: 'unpair', description: 'Reset all Telegram access for this Mercury instance' },
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

    this.deleteStatusMessage(targetId);

    let full = '';
    for await (const chunk of content) {
      full += chunk;
    }
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
    this.stepCounters.set(key, (this.stepCounters.get(key) || 0) + 1);
    const step = this.stepCounters.get(key)!;
    const label = formatToolStep(toolName, args);
    await this.updateStatusMessage(`**Step ${step}.** ${label}`, targetId);
  }

  async sendStepDone(toolName: string, result: unknown, targetId?: string): Promise<void> {
    const key = targetId || 'notification';
    const step = this.stepCounters.get(key) || 0;
    const summary = formatToolResult(toolName, result);
    const current = this.statusText.get(key) || '';
    const line = summary ? `✓ ${summary}` : '✓ done';
    await this.updateStatusMessage(`${current}\n${line}`, targetId);
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

    try {
      await this.bot.api.sendMessage(chatId, html, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    } catch {
      await this.bot.api.sendMessage(chatId, this.stripHtml(html), {
        reply_markup: keyboard,
      });
    }

    return new Promise((resolve) => {
      this.pendingApprovals.set(`${id}:yes`, () => resolve('yes'));
      this.pendingApprovals.set(`${id}:always`, () => resolve('always'));
      this.pendingApprovals.set(`${id}:no`, () => resolve('no'));

      setTimeout(() => {
        this.pendingApprovals.delete(`${id}:yes`);
        this.pendingApprovals.delete(`${id}:always`);
        this.pendingApprovals.delete(`${id}:no`);
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

    try {
      await this.bot.api.sendMessage(chatId, mdToTelegram(question), {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    } catch {
      await this.bot.api.sendMessage(chatId, question, {
        reply_markup: keyboard,
      });
    }

    return new Promise((resolve) => {
      this.pendingApprovals.set(`${id}:yes`, () => resolve(true));
      this.pendingApprovals.set(`${id}:no`, () => resolve(false));

      setTimeout(() => {
        this.pendingApprovals.delete(`${id}:yes`);
        this.pendingApprovals.delete(`${id}:no`);
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

    try {
      await this.bot.api.sendMessage(chatId, html, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    } catch {
      await this.bot.api.sendMessage(chatId, this.stripHtml(html), {
        reply_markup: keyboard,
      });
    }

    return new Promise((resolve) => {
      this.pendingApprovals.set(`${id}:ask-me`, () => resolve('ask-me'));
      this.pendingApprovals.set(`${id}:allow-all`, () => resolve('allow-all'));

      setTimeout(() => {
        this.pendingApprovals.delete(`${id}:ask-me`);
        this.pendingApprovals.delete(`${id}:allow-all`);
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

  private async sendFriendsKeyboard(chatId: number, friends: import('../memory/shared-memory-store.js').FriendInfo[]): Promise<void> {
    if (!this.bot) return;

    const lines = ['<b>Friends List</b>\n'];
    const pending = friends.filter(f => f.status === 'pending');
    const approved = friends.filter(f => f.status === 'approved');
    const revoked = friends.filter(f => f.status === 'revoked');

    if (pending.length > 0) {
      lines.push('<b>Pending:</b>');
      for (const f of pending) {
        const name = f.username ? `@${f.username}` : f.firstName || 'Unknown';
        lines.push(`  ${this.escapeHtml(name)} (${f.tgId}) [Approve] [Reject]`);
      }
    }

    if (approved.length > 0) {
      lines.push('\n<b>Approved:</b>');
      for (const f of approved) {
        const name = f.username ? `@${f.username}` : f.firstName || 'Unknown';
        lines.push(`  ${this.escapeHtml(name)} (${f.tgId})`);
      }
    }

    if (revoked.length > 0) {
      lines.push('\n<b>Revoked:</b>');
      for (const f of revoked) {
        const name = f.username ? `@${f.username}` : f.firstName || 'Unknown';
        lines.push(`  ${this.escapeHtml(name)} (${f.tgId})`);
      }
    }

    const keyboard = new InlineKeyboard();

    if (pending.length > 0) {
      for (const f of pending) {
        const name = f.username ? `@${f.username}` : f.firstName || f.tgId;
        keyboard
          .text(`✅ ${name}`, `${FRIEND_ACTION_PREFIX}:approve:${f.tgId}`)
          .text(`❌ ${name}`, `${FRIEND_ACTION_PREFIX}:reject:${f.tgId}`)
          .row();
      }
    }

    if (approved.length > 0) {
      for (const f of approved) {
        const name = f.username ? `@${f.username}` : f.firstName || f.tgId;
        keyboard.text(`🚫 Revoke ${name}`, `${FRIEND_ACTION_PREFIX}:revoke:${f.tgId}`).row();
      }
    }

    await this.bot.api.sendMessage(chatId, lines.join('\n'), {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    }).catch(async () => {
      await this.bot!.api.sendMessage(chatId, lines.join('\n'), { reply_markup: keyboard });
    });
  }

  private async sendMemoryKeyboard(chatId: number): Promise<void> {
    if (!this.bot || !this.chatCommandContext) return;

    const summary = this.chatCommandContext.memorySummary();
    const lines = [
      `<b>Memory Overview</b>`,
      `Total memories: ${summary.total}`,
      `Learning: ${summary.learningPaused ? '⏸ PAUSED' : '✅ ACTIVE'}`,
    ];

    const sharedSummary = this.chatCommandContext.sharedMemorySummary?.();
    if (sharedSummary) {
      lines.push(`Shared memory: ${sharedSummary.total} entries`);
      lines.push(`Shared learning: ${sharedSummary.learningPaused ? '⏸ PAUSED' : '✅ ACTIVE'}`);
      lines.push(`Friends: ${sharedSummary.friendCount}`);
    } else {
      lines.push('Shared memory: disabled');
    }

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
    const sharedLearningLabel = sharedSummary
      ? (sharedSummary.learningPaused ? '▶ Shared ON' : '⏸ Shared OFF')
      : null;

    const keyboard = new InlineKeyboard()
      .text('📋 Overview', `${MEMORY_ACTION_PREFIX}:overview`)
      .text('🔍 Recent', `${MEMORY_ACTION_PREFIX}:recent`)
      .row()
      .text(learningLabel, `${MEMORY_ACTION_PREFIX}:toggle_learning`);

    if (sharedLearningLabel) {
      keyboard.text(sharedLearningLabel, `${MEMORY_ACTION_PREFIX}:toggle_shared_learning`);
    }

    keyboard.row()
      .text('🗑 Clear All', `${MEMORY_ACTION_PREFIX}:clear_confirm`);

    if (sharedSummary) {
      keyboard.row()
        .text('📂 Shared Overview', `${MEMORY_ACTION_PREFIX}:shared_overview`)
        .text('👥 Friends', `${FRIEND_ACTION_PREFIX}:list`);
    }

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
      const sharedSummary = this.chatCommandContext.sharedMemorySummary?.();
      if (sharedSummary) {
        lines.push('\n<b>Shared Memory</b>');
        lines.push(`  Entries: ${sharedSummary.total}`);
        lines.push(`  Learning: ${sharedSummary.learningPaused ? '⏸ PAUSED' : '✅ ACTIVE'}`);
        lines.push(`  Friends: ${sharedSummary.friendCount}`);
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

    if (action === 'toggle_shared_learning') {
      const sharedSummary = this.chatCommandContext.sharedMemorySummary?.();
      if (!sharedSummary) {
        await ctx.answerCallbackQuery({ text: 'Shared memory not available' });
        return;
      }
      const currentlyPaused = sharedSummary.learningPaused;
      this.chatCommandContext.sharedMemorySetLearningPaused?.(!currentlyPaused);
      const label = currentlyPaused ? '▶ Shared learning ON' : '⏸ Shared learning OFF';
      await ctx.answerCallbackQuery({ text: label });
      await this.bot.api.sendMessage(chatId, currentlyPaused
        ? 'Shared learning resumed. New memories will be stored in shared memory.'
        : 'Shared learning paused. Memories will NOT be shared until resumed.',
      ).catch(() => {});
      await this.sendMemoryKeyboard(chatId);
      return;
    }

    if (action === 'shared_overview') {
      const sharedSummary = this.chatCommandContext.sharedMemorySummary?.();
      if (!sharedSummary) {
        await ctx.answerCallbackQuery({ text: 'Shared memory not available' });
        return;
      }
      await ctx.answerCallbackQuery({ text: 'Shared memory overview' });
      const lines = [
        '<b>Shared Memory Overview</b>',
        `Entries: ${sharedSummary.total}`,
        `Learning: ${sharedSummary.learningPaused ? '⏸ PAUSED' : '✅ ACTIVE'}`,
        `Friends: ${sharedSummary.friendCount}`,
      ];
      if (sharedSummary.categories.length > 0) {
        lines.push(`\n<b>Categories:</b>`);
        lines.push(...sharedSummary.categories.map(c => `  ${this.escapeHtml(c)}`));
      }
      const byType = Object.entries(sharedSummary.byType);
      if (byType.length > 0) {
        lines.push('\n<b>By type:</b>');
        for (const [type, count] of byType) {
          lines.push(`  ${type}: ${count}`);
        }
      }
      await this.bot.api.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' }).catch(async () => {
        await this.bot!.api.sendMessage(chatId, lines.join('\n'));
      });
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

  private async handleFriendCallback(ctx: any, data: string): Promise<void> {
    if (!this.bot || !this.chatCommandContext) {
      await ctx.answerCallbackQuery({ text: 'Not available' });
      return;
    }

    const action = data.slice(`${FRIEND_ACTION_PREFIX}:`.length);
    const chatId = ctx.callbackQuery.message?.chat?.id;
    if (!chatId) {
      await ctx.answerCallbackQuery({ text: 'Error' });
      return;
    }

    if (action === 'list') {
      const friends = this.chatCommandContext.sharedMemoryGetFriends?.() ?? [];
      await ctx.answerCallbackQuery({ text: 'Friends list' });

      if (friends.length === 0) {
        await this.bot.api.sendMessage(chatId, 'No friends yet. Use /friend <TELEGRAM_USER_ID> to add someone.').catch(() => {});
        return;
      }

      const lines = ['<b>Friends List</b>\n'];
      const pending = friends.filter(f => f.status === 'pending');
      const approved = friends.filter(f => f.status === 'approved');
      const revoked = friends.filter(f => f.status === 'revoked');

      if (pending.length > 0) {
        lines.push('<b>Pending:</b>');
        for (const f of pending) {
          const name = f.username ? `@${f.username}` : f.firstName || 'Unknown';
          lines.push(`  ${this.escapeHtml(name)} (${f.tgId})`);
        }
      }

      if (approved.length > 0) {
        lines.push('\n<b>Approved:</b>');
        for (const f of approved) {
          const name = f.username ? `@${f.username}` : f.firstName || 'Unknown';
          const negList = f.negativeTags.length > 0 ? ` [excluded: ${f.negativeTags.join(', ')}]` : '';
          lines.push(`  ${this.escapeHtml(name)} (${f.tgId})${negList}`);
        }
      }

      if (revoked.length > 0) {
        lines.push('\n<b>Revoked:</b>');
        for (const f of revoked) {
          const name = f.username ? `@${f.username}` : f.firstName || 'Unknown';
          lines.push(`  ${this.escapeHtml(name)} (${f.tgId})`);
        }
      }

      await this.bot.api.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' }).catch(async () => {
        await this.bot!.api.sendMessage(chatId, lines.join('\n'));
      });
      return;
    }

    if (action.startsWith('approve:')) {
      const tgId = action.slice('approve:'.length);
      const approved = this.chatCommandContext.sharedMemoryApproveFriend?.(tgId, []);
      await this.chatCommandContext?.approveFriendRequest?.(tgId, []);
      const name = approved?.username ? `@${approved.username}` : approved?.firstName || tgId;
      await ctx.answerCallbackQuery({ text: 'Approved — configure negative list via /listfriends' });
      await this.bot!.api.sendMessage(chatId, `Approved friend ${name} (${tgId}). Use /listfriends to configure what they can access.`).catch(() => {});
      return;
    }

    if (action.startsWith('reject:')) {
      const tgId = action.slice('reject:'.length);
      await this.chatCommandContext?.rejectFriendRequest?.(tgId);
      this.chatCommandContext.sharedMemoryRejectFriend?.(tgId);
      await ctx.answerCallbackQuery({ text: 'Rejected' });
      await this.bot!.api.sendMessage(chatId, `Rejected friend request from ${tgId}.`).catch(() => {});
      return;
    }

    if (action.startsWith('revoke:')) {
      const tgId = action.slice('revoke:'.length);
      const revoked = this.chatCommandContext.sharedMemoryRevokeFriend?.(tgId);
      await this.chatCommandContext?.revokeFriend?.(tgId);
      const name = revoked?.username ? `@${revoked.username}` : revoked?.firstName || tgId;
      await ctx.answerCallbackQuery({ text: 'Access revoked' });
      await this.bot!.api.sendMessage(chatId, `Revoked access for ${name} (${tgId}).`).catch(() => {});
      return;
    }

    await ctx.answerCallbackQuery({ text: 'Unknown friend action' });
  }

  async resolveTelegramUser(tgId: string): Promise<{ username: string | null; firstName: string | null } | null> {
    if (!this.bot) return null;
    try {
      const chat = await this.bot.api.getChat(Number(tgId));
      if (!chat) return null;
      return {
        username: ('username' in chat ? chat.username : null) ?? null,
        firstName: ('first_name' in chat ? chat.first_name : null) ?? null,
      };
    } catch (err) {
      logger.debug({ err, tgId }, 'Could not resolve Telegram user info');
      return null;
    }
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
      const chatIds = this.resolveTargetChatIds(targetId);
      for (const chatId of chatIds) {
        await this.bot.api.deleteMessage(chatId, msgId).catch(() => {});
      }
      this.statusMessageIds.delete(key);
      this.statusText.delete(key);
      this.stepCounters.delete(key);
    }
  }

  resetStepCounter(targetId?: string): void {
    const key = targetId || 'notification';
    this.stepCounters.delete(key);
    this.statusText.delete(key);
    this.deleteStatusMessage(targetId);
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
