import fs from 'node:fs';
import path from 'node:path';
import {
  Client,
  GatewayIntentBits,
  Options,
  Events,
  ChannelType,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  Partials,
  type Message,
  type TextChannel,
  type DMChannel,
  type Guild,
  type GuildMember,
  type Interaction,
  type Snowflake,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { ChannelMessage } from '../types/channel.js';
import { BaseChannel, type PermissionMode } from './base.js';
import type { MercuryConfig } from '../utils/config.js';
import type { DiscordAccessUser } from '../types/channel.js';
import {
  addDiscordPendingRequest,
  approveDiscordPendingRequest,
  approveDiscordPendingRequestByPairingCode,
  clearDiscordAccess,
  findDiscordAdmin,
  findDiscordApprovedUser,
  findDiscordPendingRequest,
  getDiscordAccessSummary,
  getDiscordAdmins,
  hasDiscordAdmins,
  rejectDiscordPendingRequest,
  removeDiscordUser,
  saveConfig,
} from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { mdToDiscord } from '../utils/markdown.js';
import { formatToolStep, formatToolResult } from '../utils/tool-label.js';

const MAX_MESSAGE_LENGTH = 2000;
const DISCORD_DM_PREFIX = 'discord:dm';
const DISCORD_GUILD_PREFIX = 'discord';

type ApprovalResolver = () => void;

export class DiscordChannel extends BaseChannel {
  readonly type = 'discord' as const;
  private client: Client | null = null;
  private lastActiveChannelId: string | null = null;
  private chatCommandContext?: import('../capabilities/registry.js').ChatCommandContext;
  private pendingApprovals: Map<string, ApprovalResolver> = new Map();
  private permissionModes = new Map<string, PermissionMode>();
  private onPermissionMode?: (mode: PermissionMode, channelId: string) => void;

  private statusMessageIds = new Map<string, Snowflake>();
  private stepCounters = new Map<string, number>();
  private stepHistory = new Map<string, string[]>();
  private taskActive = new Map<string, boolean>();
  private deferredResponses = new Map<string, string>();
  private statusNotices = new Map<string, string[]>();
  private static readonly MAX_STATUS_NOTICES = 3;

  private typingInterval: NodeJS.Timeout | null = null;
  private userLastMessageTime = new Map<string, number>();
  private static readonly USER_RATE_LIMIT_MS = 30_000;
  private static readonly BUSY_COOLDOWN_MS = 15_000;
  private lastBusyReplyTime = new Map<string, number>();

  private adminChannel: TextChannel | null = null;
  private lastMessageMetadata: { isDM: boolean; isAdmin: boolean } | null = null;

  constructor(private config: MercuryConfig) {
    super();
  }

  setChatCommandContext(ctx: import('../capabilities/registry.js').ChatCommandContext): void {
    this.chatCommandContext = ctx;
  }

  beginTask(targetId?: string): void {
    const key = targetId || 'notification';
    this.taskActive.set(key, true);
    this.deferredResponses.delete(key);
    this.statusNotices.delete(key);
  }

  endTask(targetId?: string): void {
    const key = targetId || 'notification';
    this.taskActive.set(key, false);
  }

  isTaskActive(targetId?: string): boolean {
    const key = targetId || 'notification';
    return this.taskActive.get(key) ?? false;
  }

  popDeferredResponse(targetId?: string): string | undefined {
    const key = targetId || 'notification';
    const text = this.deferredResponses.get(key);
    this.deferredResponses.delete(key);
    return text;
  }

  setOnPermissionMode(handler: (mode: PermissionMode, channelId: string) => void): void {
    this.onPermissionMode = handler;
  }

  getPermissionMode(channelId: string): PermissionMode {
    return this.permissionModes.get(channelId) ?? 'ask-me';
  }

  async start(): Promise<void> {
    if (this.client) return;

    const token = this.config.channels.discord.botToken;
    if (!token) {
      logger.warn('Discord bot token not set — skipping');
      return;
    }

    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel],
      makeCache: Options.cacheWithLimits({
        MessageManager: 10,
        UserManager: 50,
      }),
    });

    client.on(Events.ClientReady, async () => {
      logger.info({ bot: client.user?.tag }, 'Discord bot started — gateway connected');
      this.ready = true;

      if (this.config.channels.discord.channelId) {
        const channel = client.channels.cache.get(this.config.channels.discord.channelId!);
        if (channel?.isTextBased()) {
          this.adminChannel = channel as TextChannel;
        }
      }

      await this.registerSlashCommands();
    });

    client.on(Events.MessageCreate, async (message) => {
      if (message.author?.bot) return;
      if (message.partial) {
        try {
          message = await message.fetch();
        } catch (err: any) {
          logger.warn({ err: err.message }, 'Failed to fetch partial Discord message');
          return;
        }
      }
      await this.handleMessage(message);
    });

    client.on(Events.InteractionCreate, async (interaction) => {
      await this.handleInteraction(interaction);
    });

    client.on(Events.GuildCreate, (guild: Guild) => {
      if (this.config.channels.discord.guildId && guild.id !== this.config.channels.discord.guildId) {
        logger.warn({ guildId: guild.id }, 'Discord bot joined an unconfigured guild — leaving');
        guild.leave().catch(() => {});
        return;
      }
      logger.info({ guildId: guild.id, guildName: guild.name }, 'Discord bot joined guild');
    });

    this.client = client;

    try {
      await client.login(token);
    } catch (err: any) {
      logger.error({ err: err.message }, 'Discord bot login failed');
      this.client = null;
    }
  }

  async stop(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
    this.ready = false;
    this.stopTypingLoop();
  }

  private async handleMessage(message: Message): Promise<void> {
    const isDM = message.channel.isDMBased();

    if (isDM) {
      await this.handleDMMessage(message);
      return;
    }

    if (this.config.channels.discord.guildId && message.guild?.id !== this.config.channels.discord.guildId) {
      return;
    }

    if (this.config.channels.discord.channelId && message.channel.id !== this.config.channels.discord.channelId) {
      return;
    }

    const userId = message.author.id;
    const guild = message.guild;
    if (!guild) return;

    const isAdmin = await this.isGuildAdmin(message.member, guild);

    if (!isAdmin) {
      const now = Date.now();
      const lastTime = this.userLastMessageTime.get(userId) || 0;
      if (now - lastTime < DiscordChannel.USER_RATE_LIMIT_MS) {
        const remaining = Math.ceil((DiscordChannel.USER_RATE_LIMIT_MS - (now - lastTime)) / 1000);
        await message.reply(`Please wait ${remaining}s before sending another message.`).catch(() => {});
        return;
      }
      this.userLastMessageTime.set(userId, now);
    }

    let content = message.content.trim();
    const botId = this.client?.user?.id;
    if (botId) {
      const mentionPattern = new RegExp(`<@!?${botId}>\\s*`, 'g');
      content = content.replace(mentionPattern, '').trim();
    }
    if (!content) return;

    const command = this.getCommandName(content);

    if (command === '/start' || command === '/pair') {
      await message.reply('To pair with Mercury, send me a **direct message** (DM) with /start. Pairing codes should not be shared in public channels.').catch(() => {});
      return;
    }

    this.lastActiveChannelId = message.channel.id;
    logger.info({ channelId: message.channel.id, userId, text: content.slice(0, 50) }, 'Discord message received');

    if (!this.permissionModes.has(message.channel.id) && this.onPermissionMode) {
      this.askPermissionMode(`${DISCORD_GUILD_PREFIX}:${message.channel.id}`).then((mode) => {
        this.permissionModes.set(message.channel.id, mode);
        if (this.onPermissionMode) {
          this.onPermissionMode(mode, message.channel.id);
        }
      }).catch((e: any) => logger.warn({ e }, 'discord permission ask failed'));
      this.permissionModes.set(message.channel.id, 'ask-me');
    }

    const channelId = `${DISCORD_GUILD_PREFIX}:${message.channel.id}`;
    const msg: ChannelMessage = {
      id: message.id,
      channelId,
      channelType: 'discord',
      senderId: userId,
      senderName: message.member?.displayName || message.author.username,
      content,
      timestamp: message.createdTimestamp,
      metadata: {
        channelId: message.channel.id,
        guildId: guild.id,
        isDM: false,
        isAdmin,
      },
    };
    this.lastMessageMetadata = { isDM: false, isAdmin };
    this.emit(msg);
  }

  private async handleDMMessage(message: Message): Promise<void> {
    const userId = message.author.id;
    const content = message.content.trim();
    if (!content) return;

    const command = this.getCommandName(content);

    if (command === '/start' || command === '/pair') {
      await this.handleDMAccessRequest(message);
      return;
    }

    const approvedUser = findDiscordApprovedUser(this.config, userId);
    if (!approvedUser) {
      const pending = findDiscordPendingRequest(this.config, userId);
      if (pending) {
        await message.reply(this.getPendingStatusMessage(pending)).catch(() => {});
      } else {
        await message.reply('This bot is not available to you. Send /start to request access.').catch(() => {});
      }
      return;
    }

    if (command === '/unpair') {
      if (!findDiscordAdmin(this.config, userId)) {
        await message.reply('Only Discord admins can reset access.').catch(() => {});
        return;
      }
      this.resetDMAccess();
      await message.reply('Discord DM access reset. New users can send /start to request access.').catch(() => {});
      return;
    }

    this.lastActiveChannelId = message.channel.id;
    logger.info({ userId, text: content.slice(0, 50) }, 'Discord DM received');

    const channelId = `${DISCORD_DM_PREFIX}:${userId}`;
    if (!this.permissionModes.has(channelId) && this.onPermissionMode) {
      this.askPermissionMode(channelId).then((mode) => {
        this.permissionModes.set(channelId, mode);
        if (this.onPermissionMode) {
          this.onPermissionMode(mode, channelId);
        }
      }).catch((e: any) => logger.warn({ e }, 'discord permission ask failed'));
      this.permissionModes.set(channelId, 'ask-me');
    }

    const msg: ChannelMessage = {
      id: message.id,
      channelId,
      channelType: 'discord',
      senderId: userId,
      senderName: message.author.username,
      content,
      timestamp: message.createdTimestamp,
      metadata: {
        channelId: message.channel.id,
        isDM: true,
      },
    };
    this.lastMessageMetadata = { isDM: true, isAdmin: false };
    this.emit(msg);
  }

  private async handleDMAccessRequest(message: Message): Promise<void> {
    const userId = message.author.id;
    const username = message.author.username;
    const displayName = message.author.displayName || message.author.username;

    const approvedUser = findDiscordApprovedUser(this.config, userId);
    if (approvedUser) {
      const role = approvedUser.role;
      await message.reply(`You are already approved as a ${role}.`).catch(() => {});
      return;
    }

    const existingRequest = findDiscordPendingRequest(this.config, userId);
    if (existingRequest) {
      await message.reply(this.getPendingStatusMessage(existingRequest)).catch(() => {});
      return;
    }

    if (!hasDiscordAdmins(this.config) && this.config.channels.discord.pending.length > 0) {
      await message.reply(
        'Initial Discord pairing is already in progress for another user. Ask the Mercury operator to finish setup or reset Discord access first.',
      ).catch(() => {});
      return;
    }

    const request = addDiscordPendingRequest(this.config, {
      userId,
      username,
      displayName,
      pairingCode: hasDiscordAdmins(this.config) ? undefined : this.generatePairingCode(),
    });
    saveConfig(this.config);
    logger.info({ userId, username }, 'Discord DM access request recorded');

    await message.reply(this.getPendingStatusMessage(request)).catch(() => {});

    if (hasDiscordAdmins(this.config)) {
      await this.notifyAdminsOfPendingRequest(request);
    }
  }

  private async notifyAdminsOfPendingRequest(request: import('../types/channel.js').DiscordPendingRequest): Promise<void> {
    if (!this.client) return;

    const username = request.username ? ` (@${request.username})` : '';
    const displayName = request.displayName ? ` (${request.displayName})` : '';
    const lines = [
      '**Discord access request pending approval.**',
      '',
      `User ID: \`${request.userId}\`${username}${displayName}`,
      `Requested: ${new Date(request.requestedAt).toLocaleString()}`,
      '',
      'Use the buttons below to approve or reject this user.',
    ];

    const row = new ActionRowBuilder<ButtonBuilder>()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`discord_access:approve:${request.userId}`)
          .setLabel('Approve')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`discord_access:reject:${request.userId}`)
          .setLabel('Reject')
          .setStyle(ButtonStyle.Danger),
      );

    for (const admin of getDiscordAdmins(this.config)) {
      try {
        const dmChannel = await this.client.users.createDM(admin.userId);
        await dmChannel.send({ content: lines.join('\n'), components: [row] });
      } catch (err: any) {
        logger.warn({ err: err.message, adminId: admin.userId }, 'Failed to notify Discord admin');
      }
    }
  }

  private async isGuildAdmin(member: GuildMember | null, guild: Guild): Promise<boolean> {
    if (!member) return false;

    if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
    if (guild.ownerId === member.id) return true;

    const adminRoleName = this.config.channels.discord.adminRoleName;
    if (adminRoleName) {
      return member.roles.cache.some((role) => role.name === adminRoleName);
    }

    return false;
  }

  async send(content: string, targetId?: string, elapsedMs?: number): Promise<void> {
    const channel = await this.resolveTargetChannel(targetId);
    if (!channel || !this.client) {
      logger.warn({ targetId }, 'Discord send: no valid channel');
      return;
    }

    const key = targetId || 'notification';

    if (this.taskActive.get(key)) {
      const timeSuffix = elapsedMs != null ? ` (${(elapsedMs / 1000).toFixed(1)}s)` : '';
      const fullContent = content + timeSuffix;
      if (!fullContent.trim()) return;

      const isSystemNotice = content.startsWith('\u263f ') || content.startsWith('\u26a0') || content.startsWith('  [') || content.length < 200;
      if (isSystemNotice) {
        const notices = this.statusNotices.get(key) || [];
        const truncated = fullContent.length > 80 ? fullContent.slice(0, 77) + '\u2026' : fullContent;
        notices.push(truncated);
        this.statusNotices.set(key, notices);
        await this.refreshStatusCard(targetId);
      } else {
        this.deferredResponses.set(key, fullContent);
      }
      return;
    }

    const timeSuffix = elapsedMs != null ? `\n\u23f1 ${(elapsedMs / 1000).toFixed(1)}s` : '';
    const fullContent = content + timeSuffix;
    if (!fullContent.trim()) {
      logger.info({ targetId }, 'Discord send: skipping empty message');
      return;
    }

    const discordContent = mdToDiscord(fullContent);
    const chunks = this.splitMessage(discordContent, MAX_MESSAGE_LENGTH);

    for (const chunk of chunks) {
      try {
        await channel.send({ content: chunk, allowedMentions: { parse: [] } });
      } catch (err: any) {
        logger.error({ err: err.message, channelId: channel.id }, 'Discord send failed');
      }
    }
  }

  async sendFile(filePath: string, targetId?: string): Promise<void> {
    const channel = await this.resolveTargetChannel(targetId);
    if (!channel || !this.client) {
      logger.warn({ targetId }, 'Discord sendFile: no valid channel');
      return;
    }

    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      await channel.send(`File not found: ${filePath}`).catch(() => {});
      return;
    }

    const filename = path.basename(resolved);

    try {
      await channel.send({
        files: [{ attachment: resolved, name: filename }],
        allowedMentions: { parse: [] },
      });
      logger.info({ file: resolved, channelId: channel.id }, 'File sent via Discord');
    } catch (err: any) {
      logger.error({ err: err.message, file: resolved }, 'Discord sendFile failed');
      await channel.send(`Failed to send file: ${err.message}`).catch(() => {});
    }
  }

  async stream(content: AsyncIterable<string>, targetId?: string): Promise<string> {
    const channel = await this.resolveTargetChannel(targetId);
    if (!channel || !this.client) return '';

    const key = targetId || 'notification';
    if (this.taskActive.get(key)) {
      let full = '';
      for await (const chunk of content) {
        full += chunk;
      }
      this.deferredResponses.set(key, full);
      return full;
    }

    this.deleteStatusMessage(targetId);

    if (!this.config.channels.discord.streaming) {
      let full = '';
      for await (const chunk of content) {
        full += chunk;
      }
      const discordContent = mdToDiscord(full);
      const chunks = this.splitMessage(discordContent, MAX_MESSAGE_LENGTH);
      for (const chunk of chunks) {
        try {
          await channel.send({ content: chunk, allowedMentions: { parse: [] } });
        } catch (err: any) {
          logger.error({ err: err.message }, 'Discord stream send failed');
        }
      }
      return full;
    }

    const STREAM_EDIT_INTERVAL = 2000;
    const STREAM_MIN_LENGTH = 20;

    this.startTypingLoop(channel);

    try {
      let full = '';
      let streamMsg: Message | null = null;
      let lastEditTime = 0;

      for await (const chunk of content) {
        full += chunk;

        const now = Date.now();
        const timeSinceLastEdit = now - lastEditTime;

        if (!streamMsg && full.length >= STREAM_MIN_LENGTH) {
          try {
            streamMsg = await channel.send({
              content: mdToDiscord(full) + ' \u258c',
              allowedMentions: { parse: [] },
            });
            lastEditTime = now;
          } catch {
            streamMsg = null;
          }
        } else if (streamMsg && timeSinceLastEdit >= STREAM_EDIT_INTERVAL) {
          try {
            await streamMsg.edit(mdToDiscord(full) + ' \u258c');
            lastEditTime = now;
          } catch {
            // edit failed — rate limited, skip
          }
        }
      }

      if (streamMsg) {
        const finalContent = mdToDiscord(full);
        const chunks = this.splitMessage(finalContent, MAX_MESSAGE_LENGTH);
        if (chunks.length <= 1) {
          try {
            await streamMsg.edit({ content: finalContent, allowedMentions: { parse: [] } });
          } catch {
            // final edit failed
          }
        } else {
          try {
            await streamMsg.delete();
          } catch {
            // delete failed
          }
          for (const chunk of chunks) {
            try {
              await channel.send({ content: chunk, allowedMentions: { parse: [] } });
            } catch {
              // send failed
            }
          }
        }
      } else if (full.trim()) {
        const discordContent = mdToDiscord(full);
        const chunks = this.splitMessage(discordContent, MAX_MESSAGE_LENGTH);
        for (const chunk of chunks) {
          try {
            await channel.send({ content: chunk, allowedMentions: { parse: [] } });
          } catch {
            // send failed
          }
        }
      }

      return full;
    } finally {
      this.stopTypingLoop();
    }
  }

  async typing(targetId?: string): Promise<void> {
    const channel = await this.resolveTargetChannel(targetId);
    if (!channel || !this.client) return;
    if ('sendTyping' in channel) {
      await channel.sendTyping().catch(() => {});
    }
  }

  startTypingLoop(channel: TextChannel | DMChannel): void {
    this.stopTypingLoop();
    if ('sendTyping' in channel) {
      channel.sendTyping().catch(() => {});
    }
    this.typingInterval = setInterval(() => {
      if ('sendTyping' in channel) {
        channel.sendTyping().catch(() => {});
      }
    }, 8000);
  }

  stopTypingLoop(): void {
    if (this.typingInterval) {
      clearInterval(this.typingInterval);
      this.typingInterval = null;
    }
  }

  async askPermission(prompt: string, targetId?: string): Promise<string> {
    const channel = await this.resolveTargetChannel(targetId);
    if (!channel || !this.client) return 'no';

    const id = `perm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const row = new ActionRowBuilder<ButtonBuilder>()
      .addComponents(
        new ButtonBuilder().setCustomId(`${id}:yes`).setLabel('Allow').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`${id}:always`).setLabel('Always').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`${id}:no`).setLabel('Deny').setStyle(ButtonStyle.Danger),
      );

    const discordContent = mdToDiscord(prompt);
    let sentMsg: Message | undefined;

    try {
      sentMsg = await channel.send({ content: discordContent, components: [row], allowedMentions: { parse: [] } });
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Discord askPermission send failed');
    }

    return new Promise((resolve) => {
      const cleanup = (result: string) => {
        this.pendingApprovals.delete(`${id}:yes`);
        this.pendingApprovals.delete(`${id}:always`);
        this.pendingApprovals.delete(`${id}:no`);
        if (sentMsg) {
          sentMsg.delete().catch(() => {});
        }
        resolve(result);
      };
      this.pendingApprovals.set(`${id}:yes`, () => cleanup('yes'));
      this.pendingApprovals.set(`${id}:always`, () => cleanup('always'));
      this.pendingApprovals.set(`${id}:no`, () => cleanup('no'));

      setTimeout(() => {
        this.pendingApprovals.delete(`${id}:yes`);
        this.pendingApprovals.delete(`${id}:always`);
        this.pendingApprovals.delete(`${id}:no`);
        if (sentMsg) {
          sentMsg.delete().catch(() => {});
        }
        resolve('no');
      }, 120_000);
    });
  }

  async askToContinue(question: string, targetId?: string): Promise<boolean> {
    const channel = await this.resolveTargetChannel(targetId);
    if (!channel || !this.client) return false;

    const id = `loop_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const row = new ActionRowBuilder<ButtonBuilder>()
      .addComponents(
        new ButtonBuilder().setCustomId(`${id}:yes`).setLabel('Continue').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`${id}:no`).setLabel('Stop').setStyle(ButtonStyle.Danger),
      );

    const discordContent = mdToDiscord(question);
    let sentMsg: Message | undefined;

    try {
      sentMsg = await channel.send({ content: discordContent, components: [row], allowedMentions: { parse: [] } });
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Discord askToContinue send failed');
    }

    return new Promise((resolve) => {
      const cleanup = (result: boolean) => {
        this.pendingApprovals.delete(`${id}:yes`);
        this.pendingApprovals.delete(`${id}:no`);
        if (sentMsg) {
          sentMsg.delete().catch(() => {});
        }
        resolve(result);
      };
      this.pendingApprovals.set(`${id}:yes`, () => cleanup(true));
      this.pendingApprovals.set(`${id}:no`, () => cleanup(false));

      setTimeout(() => {
        this.pendingApprovals.delete(`${id}:yes`);
        this.pendingApprovals.delete(`${id}:no`);
        if (sentMsg) {
          sentMsg.delete().catch(() => {});
        }
        resolve(false);
      }, 120_000);
    });
  }

  async askPermissionMode(targetId?: string): Promise<PermissionMode> {
    const channel = await this.resolveTargetChannel(targetId);
    if (!channel || !this.client) return 'ask-me';

    const id = `perm_mode_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const row = new ActionRowBuilder<ButtonBuilder>()
      .addComponents(
        new ButtonBuilder().setCustomId(`${id}:ask-me`).setLabel('\uD83D\uDD12 Ask Me').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`${id}:allow-all`).setLabel('\u2705 Allow All').setStyle(ButtonStyle.Success),
      );

    const content = [
      '**Permission Mode**',
      'How should Mercury handle risky actions this session?',
      '',
      '\uD83D\uDD12 **Ask Me** \u2014 confirm before file writes, commands, and scope changes',
      '\u2705 **Allow All** \u2014 auto-approve everything (scopes, commands, loops)',
    ].join('\n');

    let sentMsg: Message | undefined;
    try {
      sentMsg = await channel.send({ content, components: [row], allowedMentions: { parse: [] } });
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Discord askPermissionMode send failed');
    }

    return new Promise((resolve) => {
      const cleanup = (result: PermissionMode) => {
        this.pendingApprovals.delete(`${id}:ask-me`);
        this.pendingApprovals.delete(`${id}:allow-all`);
        if (sentMsg) {
          sentMsg.delete().catch(() => {});
        }
        resolve(result);
      };
      this.pendingApprovals.set(`${id}:ask-me`, () => cleanup('ask-me'));
      this.pendingApprovals.set(`${id}:allow-all`, () => cleanup('allow-all'));

      setTimeout(() => {
        this.pendingApprovals.delete(`${id}:ask-me`);
        this.pendingApprovals.delete(`${id}:allow-all`);
        if (sentMsg) {
          sentMsg.delete().catch(() => {});
        }
        resolve('ask-me');
      }, 120_000);
    });
  }

  async sendToolFeedback(toolName: string, args: Record<string, any>, targetId?: string): Promise<void> {
    const key = targetId || 'notification';
    const step = (this.stepCounters.get(key) || 0) + 1;
    this.stepCounters.set(key, step);
    const label = formatToolStep(toolName, args);

    const history = this.stepHistory.get(key) || [];
    const recentHistory = history.slice(-5);

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle(`\u2699\uFE0F Mercury working (step ${step})`)
      .setDescription([
        ...recentHistory.map(h => `\u2705 ${h}`),
        `\u23f3 ${label}\u2026`,
      ].join('\n'))
      .setTimestamp();

    await this.updateStatusEmbed(embed, targetId);
  }

  async sendStepDone(toolName: string, result: unknown, targetId?: string): Promise<void> {
    const key = targetId || 'notification';
    const step = this.stepCounters.get(key) || 0;
    const summary = formatToolResult(toolName, result);
    const label = formatToolStep(toolName, {} as any);
    const doneLine = summary ? `${label} \u00b7 ${summary}` : label;

    const history = this.stepHistory.get(key) || [];
    history.push(doneLine);
    this.stepHistory.set(key, history);

    const recentHistory = history.slice(-5);

    const embed = new EmbedBuilder()
      .setColor(0x57F287)
      .setTitle(`\u2699\uFE0F Mercury working (${step} steps done)`)
      .setDescription(recentHistory.map(h => `\u2705 ${h}`).join('\n'))
      .setTimestamp();

    await this.updateStatusEmbed(embed, targetId);
  }

  private async updateStatusEmbed(embed: EmbedBuilder, targetId?: string): Promise<void> {
    const channel = await this.resolveTargetChannel(targetId);
    if (!channel || !this.client) return;

    const key = targetId || 'notification';
    const existingId = this.statusMessageIds.get(key);

    if (existingId) {
      try {
        const msg = await channel.messages.fetch(existingId);
        await msg.edit({ embeds: [embed] });
        return;
      } catch {
        this.statusMessageIds.delete(key);
      }
    }

    try {
      const msg = await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
      this.statusMessageIds.set(key, msg.id);
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Discord status embed send failed');
    }
  }

  private async refreshStatusCard(targetId?: string): Promise<void> {
    const key = targetId || 'notification';
    const notices = this.statusNotices.get(key) || [];
    const step = this.stepCounters.get(key) || 0;
    const history = this.stepHistory.get(key) || [];
    const recentHistory = history.slice(-5);

    const lines = [
      ...recentHistory.map(h => `\u2705 ${h}`),
    ];
    if (notices.length > 0) {
      lines.push('', ...notices.slice(-DiscordChannel.MAX_STATUS_NOTICES));
    }

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle(`\u2699\uFE0F Mercury working (step ${step})`)
      .setDescription(lines.join('\n') || 'Processing\u2026')
      .setTimestamp();

    await this.updateStatusEmbed(embed, targetId);
  }

  private deleteStatusMessage(targetId?: string): void {
    const key = targetId || 'notification';
    this.statusMessageIds.delete(key);
    this.stepCounters.delete(key);
    this.stepHistory.delete(key);
    this.statusNotices.delete(key);
  }

  private async deleteStatusMessageFromDiscord(targetId?: string): Promise<void> {
    const channel = await this.resolveTargetChannel(targetId);
    if (!channel) return;

    const key = targetId || 'notification';
    const existingId = this.statusMessageIds.get(key);
    if (existingId) {
      try {
        const msg = await channel.messages.fetch(existingId);
        await msg.delete();
      } catch {
        // already deleted
      }
      this.statusMessageIds.delete(key);
    }
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    if (interaction.isChatInputCommand()) {
      await this.handleSlashCommand(interaction);
      return;
    }

    if (!interaction.isButton()) return;

    const customId = interaction.customId;

    if (customId.startsWith('discord_access:')) {
      await this.handleAccessButton(interaction, customId);
      return;
    }

    const resolver = this.pendingApprovals.get(customId);
    if (resolver) {
      if (customId.startsWith('perm_') || customId.startsWith('perm_mode_') || customId.startsWith('loop_')) {
        const metadata = this.lastMessageMetadata;
        if (metadata && !metadata.isDM && !metadata.isAdmin) {
          await interaction.reply({ content: 'Only admins can approve actions in server channels.', flags: MessageFlags.Ephemeral });
          return;
        }
      }
      this.pendingApprovals.delete(customId);
      resolver();
      const action = customId.split(':')[1];
      try {
        await interaction.reply({ content: action === 'no' ? 'Denied' : 'Approved', flags: MessageFlags.Ephemeral });
      } catch {
        // interaction already replied or expired
      }
      return;
    }

    try {
      await interaction.reply({ content: 'Expired', flags: MessageFlags.Ephemeral });
    } catch {
      // interaction expired
    }
  }

  private async handleAccessButton(interaction: ButtonInteraction, customId: string): Promise<void> {
    if (!findDiscordAdmin(this.config, interaction.user.id)) {
      await interaction.reply({ content: 'Only Discord admins can approve or reject access requests.', flags: MessageFlags.Ephemeral });
      return;
    }

    const parts = customId.split(':');
    if (parts.length < 3) return;
    const action = parts[1];
    const userId = parts[2];

    if (action === 'approve') {
      const role = hasDiscordAdmins(this.config) ? 'member' : 'admin';
      const approved = approveDiscordPendingRequest(this.config, userId, role);
      if (approved) {
        saveConfig(this.config);
        const label = approved.displayName || approved.username || approved.userId;
        await interaction.reply({ content: `Approved ${label} as ${role}.`, flags: MessageFlags.Ephemeral });

        try {
          const dmChannel = await this.client!.users.createDM(userId);
          await dmChannel.send(`You have been approved as a ${role}! You can now chat with Mercury.`);
        } catch (err: any) {
          logger.warn({ err: err.message }, 'Failed to notify approved Discord user');
        }
      } else {
        await interaction.reply({ content: 'No pending request found for this user.', flags: MessageFlags.Ephemeral });
      }
    } else if (action === 'reject') {
      const rejected = rejectDiscordPendingRequest(this.config, userId);
      if (rejected) {
        saveConfig(this.config);
        await interaction.reply({ content: 'Rejected access request.', flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content: 'No pending request found for this user.', flags: MessageFlags.Ephemeral });
      }
    }
  }

  private async registerSlashCommands(): Promise<void> {
    if (!this.client?.application) return;

    const guildId = this.config.channels.discord.guildId;
    if (!guildId) {
      logger.debug('No Discord guildId configured — skipping slash command registration');
      return;
    }

    try {
      await this.client.application.commands.set(
        [
          { name: 'start', description: 'Request Discord access to this Mercury instance' },
          { name: 'help', description: 'Show available commands' },
          { name: 'status', description: 'Show agent config, budget, and uptime' },
          { name: 'stop', description: 'Stop all agents and clear queue' },
          { name: 'budget', description: 'Token budget status and management' },
          { name: 'saver', description: 'Toggle Token Saver Mode' },
          { name: 'memory', description: 'View and manage second brain memory (admin only)' },
          { name: 'permissions', description: 'Change permission mode' },
          { name: 'models', description: 'List providers or switch AI model' },
          { name: 'unpair', description: 'Reset all Discord DM access (admin only)' },
        ],
        guildId,
      );
      logger.info({ guildId }, 'Discord slash commands registered');
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Failed to register Discord slash commands (non-critical)');
    }
  }

  private async handleSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const commandName = interaction.commandName;

    if (commandName === 'start' || commandName === 'pair') {
      const userId = interaction.user.id;
      const approvedUser = findDiscordApprovedUser(this.config, userId);
      if (approvedUser) {
        await interaction.reply({ content: `You are already approved as a ${approvedUser.role}.`, flags: MessageFlags.Ephemeral });
        return;
      }

      const existingRequest = findDiscordPendingRequest(this.config, userId);
      if (existingRequest) {
        await interaction.reply({ content: this.getPendingStatusMessage(existingRequest), flags: MessageFlags.Ephemeral });
        return;
      }

      if (!hasDiscordAdmins(this.config) && this.config.channels.discord.pending.length > 0) {
        await interaction.reply({ content: 'Initial Discord pairing is already in progress for another user.', flags: MessageFlags.Ephemeral });
        return;
      }

      const request = addDiscordPendingRequest(this.config, {
        userId,
        username: interaction.user.username,
        displayName: interaction.user.displayName || interaction.user.username,
        pairingCode: hasDiscordAdmins(this.config) ? undefined : this.generatePairingCode(),
      });
      saveConfig(this.config);
      logger.info({ userId, username: interaction.user.username }, 'Discord slash command access request recorded');

      await interaction.reply({ content: this.getPendingStatusMessage(request), flags: MessageFlags.Ephemeral });

      if (hasDiscordAdmins(this.config)) {
        await this.notifyAdminsOfPendingRequest(request);
      }
      return;
    }

    if (commandName === 'unpair') {
      const userId = interaction.user.id;
      if (!findDiscordAdmin(this.config, userId)) {
        await interaction.reply({ content: 'Only Discord admins can reset access.', flags: MessageFlags.Ephemeral });
        return;
      }
      this.resetDMAccess();
      await interaction.reply({ content: 'Discord DM access reset. New users can send /start to request access.', flags: MessageFlags.Ephemeral });
      return;
    }

    const channelId = interaction.channel?.id;
    if (!channelId) {
      await interaction.reply({ content: 'This command can only be used in a server channel.', flags: MessageFlags.Ephemeral });
      return;
    }

    const memberPerms = interaction.member?.permissions;
    const isAdmin = (typeof memberPerms !== 'string' && memberPerms?.has(PermissionFlagsBits.Administrator)) ?? false;

    const msg: ChannelMessage = {
      id: interaction.id,
      channelId: `${DISCORD_GUILD_PREFIX}:${channelId}`,
      channelType: 'discord',
      senderId: interaction.user.id,
      senderName: (interaction.member as GuildMember | null)?.displayName || interaction.user.username,
      content: `/${commandName}`,
      timestamp: Date.now(),
      metadata: {
        channelId,
        guildId: interaction.guild?.id,
        isDM: false,
        isAdmin,
      },
    };

    await interaction.reply({ content: 'Command received.', flags: MessageFlags.Ephemeral });
    this.lastActiveChannelId = channelId;
    this.emit(msg);
  }

  private async resolveTargetChannel(targetId?: string): Promise<TextChannel | DMChannel | null> {
    if (!this.client) return null;

    if (!targetId || targetId === 'notification') {
      if (this.lastActiveChannelId) {
        const channel = this.client.channels.cache.get(this.lastActiveChannelId);
        if (channel?.isTextBased()) return channel as TextChannel | DMChannel;
      }
      if (this.config.channels.discord.channelId) {
        const channel = this.client.channels.cache.get(this.config.channels.discord.channelId!);
        if (channel?.isTextBased()) return channel as TextChannel;
      }
      return null;
    }

    if (targetId.startsWith(`${DISCORD_DM_PREFIX}:`)) {
      const userId = targetId.slice(DISCORD_DM_PREFIX.length + 1);
      const cachedUser = this.client.users.cache.get(userId);
      if (cachedUser?.dmChannel) return cachedUser.dmChannel;
      try {
        const dmChannel = await this.client.users.createDM(userId);
        return dmChannel;
      } catch (err: any) {
        logger.warn({ err: err.message, userId }, 'Failed to create Discord DM channel');
        return null;
      }
    }

    if (targetId.startsWith(`${DISCORD_GUILD_PREFIX}:`)) {
      const channelId = targetId.slice(DISCORD_GUILD_PREFIX.length + 1);
      const channel = this.client.channels.cache.get(channelId);
      if (channel?.isTextBased()) return channel as TextChannel;
      return null;
    }

    const channel = this.client.channels.cache.get(targetId);
    if (channel?.isTextBased()) return channel as TextChannel;
    return null;
  }

  private splitMessage(text: string, maxLength: number): string[] {
    if (text.length <= maxLength) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }

      let splitAt = -1;

      const codeBlockMatch = remaining.slice(0, maxLength).match(/```\w*$/);
      if (codeBlockMatch) {
        splitAt = remaining.slice(0, maxLength).lastIndexOf('```');
      }

      if (splitAt === -1) {
        const inCodeBlock = (remaining.slice(0, maxLength).match(/```/g) || []).length % 2 === 1;
        if (inCodeBlock) {
          splitAt = remaining.slice(0, maxLength).lastIndexOf('\n');
        }
      }

      if (splitAt === -1) {
        splitAt = remaining.slice(0, maxLength).lastIndexOf('\n');
      }

      if (splitAt === -1) {
        splitAt = remaining.slice(0, maxLength).lastIndexOf(' ');
      }

      if (splitAt <= 0) {
        splitAt = maxLength;
      }

      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trimStart();
    }

    return chunks;
  }

  private getCommandName(text: string): string {
    const trimmed = text.trim();
    const match = trimmed.match(/^\/(\w+)/);
    return match ? `/${match[1]}` : '';
  }

  private generatePairingCode(): string {
    return Math.random().toString(36).slice(2, 8).toUpperCase();
  }

  private getPendingStatusMessage(request: import('../types/channel.js').DiscordPendingRequest): string {
    if (request.pairingCode) {
      return [
        'Almost there! Your pairing code is being generated.',
        '',
        `Your code: \`${request.pairingCode}\``,
        'Enter this code in the Mercury terminal to complete setup.',
      ].join('\n');
    }
    return 'Your access request has been recorded. An admin will review it shortly.';
  }

  private resetDMAccess(): void {
    clearDiscordAccess(this.config);
    saveConfig(this.config);
  }

  resetStepCounter(targetId?: string): void {
    const key = targetId || 'notification';
    this.stepCounters.delete(key);
    this.stepHistory.delete(key);
    this.statusNotices.delete(key);
  }

  async sendCompletion(elapsedMs: number, stepCount: number, targetId?: string, meta?: {
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    budgetUsed: number;
    budgetTotal: number;
    budgetPercentage: number;
  }): Promise<void> {
    this.endTask(targetId);
    await this.deleteStatusMessageFromDiscord(targetId);

    const deferred = this.popDeferredResponse(targetId);
    if (deferred?.trim()) {
      await this.send(deferred, targetId);
    }

    const channel = await this.resolveTargetChannel(targetId);
    if (!channel || !this.client) return;

    const timeStr = (elapsedMs / 1000).toFixed(1);
    const embed = new EmbedBuilder()
      .setColor(0x57F287)
      .setTitle(`\u2705 Done \u2014 ${stepCount} steps in ${timeStr}s`)
      .addFields(
        { name: 'Provider', value: meta?.provider ?? 'unknown', inline: true },
        { name: 'Model', value: meta?.model ?? 'unknown', inline: true },
        { name: 'Tokens', value: `${meta?.totalTokens ?? 0}`, inline: true },
      )
      .setTimestamp();

    if (meta) {
      embed.addFields({ name: 'Budget', value: `${meta.budgetUsed} / ${meta.budgetTotal} (${meta.budgetPercentage}%)`, inline: false });
    }

    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => {});
    this.resetStepCounter(targetId);
  }

  async sendBusyNotice(targetId?: string): Promise<void> {
    if (!this.client) return;
    const channel = await this.resolveTargetChannel(targetId);
    if (!channel) return;

    const key = targetId || 'notification';
    const now = Date.now();
    const lastBusy = this.lastBusyReplyTime.get(key) || 0;
    if (now - lastBusy < DiscordChannel.BUSY_COOLDOWN_MS) return;

    this.lastBusyReplyTime.set(key, now);
    await channel.send({
      content: '\u23f3 Mercury is busy processing another request. Your message has been queued.',
      allowedMentions: { parse: [] },
    }).catch(() => {});
  }
}