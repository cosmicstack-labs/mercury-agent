import fs from 'node:fs';
import path from 'node:path';
  import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  AttachmentBuilder,
  ChannelType,
  MessageFlags,
  InteractionContextType,
  type Message,
  type TextChannel,
  type DMChannel,
  type ThreadChannel,
  type Interaction,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
  type StringSelectMenuInteraction,
  type AnySelectMenuInteraction,
  type Snowflake,
} from 'discord.js';
import type { ChannelMessage } from '../types/channel.js';
import { BaseChannel, type PermissionMode } from './base.js';
import type { MercuryConfig, DiscordAccessUser, DiscordPendingRequest } from '../utils/config.js';
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
  getDiscordApprovedUserIds,
  hasDiscordAdmins,
  loadConfig,
  rejectDiscordPendingRequest,
  saveConfig,
} from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { mdToDiscord } from '../utils/markdown.js';
import { formatToolStep, formatToolResult } from '../utils/tool-label.js';

const MAX_MESSAGE_LENGTH = 2000;
const ACCESS_ACTION_PREFIX = 'dc_access';
const MEMORY_ACTION_PREFIX = 'dc_memory';

type SendableChannel = import('discord.js').TextChannel | import('discord.js').DMChannel | import('discord.js').ThreadChannel<boolean> | import('discord.js').NewsChannel | import('discord.js').VoiceChannel;

function isSendable(channel: any): channel is SendableChannel {
  return channel && typeof channel.send === 'function' && !channel.partial;
}

type ApprovalResolver = () => void;

export class DiscordChannel extends BaseChannel {
  readonly type = 'discord' as const;
  private client: Client | null = null;
  private chatCommandContext?: import('../capabilities/registry.js').ChatCommandContext;
  private pendingApprovals: Map<string, ApprovalResolver> = new Map();
  private permissionModes = new Map<string, PermissionMode>();
  private onPermissionMode?: (mode: PermissionMode, channelId: string) => void;
  private statusMessageIds = new Map<string, string>();
  private stepCounters = new Map<string, number>();
  private stepHistory = new Map<string, string[]>();
  /** Track all ephemeral message IDs (permissions, loops, status) per chat for cleanup */
  private ephemeralMessageIds = new Map<string, string[]>();
  /** Whether a task is currently active per chat — gates message routing */
  private taskActive = new Map<string, boolean>();
  /** Deferred AI responses to send after task completes */
  private deferredResponses = new Map<string, string>();
  /** Notices appended to the status card during a task */
  private statusNotices = new Map<string, string[]>();
  /** Track pinned status message per chat (only one at a time) */
  private pinnedMessageIds = new Map<string, string>();
  /** Original user message per channel — used for reaction lifecycle */
  private originalMessageIds = new Map<string, { messageId: string; channelId: string }>();
  /** Minimum steps before we pin the status card */
  private static readonly PIN_STEP_THRESHOLD = 3;
  private static readonly MAX_STATUS_NOTICES = 3;
  /** Deduplicate incoming messages — Discord can fire MessageCreate twice for the same event */
  private processedMessages = new Map<string, number>();

  constructor(private config: MercuryConfig) {
    super();
  }

  private reloadConfig(): void {
    try {
      this.config = loadConfig();
    } catch {
      // keep using in-memory config if disk read fails
    }
  }

  setChatCommandContext(ctx: import('../capabilities/registry.js').ChatCommandContext): void {
    this.chatCommandContext = ctx;
  }

  usesTaskBuffering(): boolean {
    return true;
  }

  supportsStreaming(): boolean {
    return true;
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
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.DirectMessageReactions,
      ],
      partials: [Partials.Channel, Partials.Message],
    });

    client.on(Events.MessageCreate, async (message) => {
      if (message.author.bot) return;
      try {
        await this.handleMessage(message);
      } catch (err: any) {
        logger.error({ err: err.message, content: message.content?.slice(0, 100), channelId: message.channelId }, 'Discord message handler error');
      }
    });

    client.on(Events.InteractionCreate, async (interaction) => {
      try {
        await this.handleInteraction(interaction);
      } catch (err: any) {
        logger.error({ err: err.message, interactionType: interaction.type, customId: interaction.isButton() ? interaction.customId : undefined }, 'Discord unhandled interaction error');
      }
    });

    client.on(Events.ClientReady, async () => {
      logger.info({ bot: client.user?.tag }, 'Discord bot started — gateway active');
      this.ready = true;
      try {
        await this.registerCommands();
      } catch (err: any) {
        logger.error({ err: err.message }, 'Failed to register Discord slash commands on ready');
      }
    });

    client.on(Events.ShardDisconnect, (event) => {
      logger.warn({ code: event.code }, 'Discord shard disconnected');
    });

    client.on(Events.ShardReconnecting, () => {
      logger.info('Discord shard reconnecting');
    });

    client.on(Events.ShardResume, () => {
      logger.info('Discord shard resumed');
    });

    client.on(Events.Error, (err) => {
      logger.error({ err: err.message }, 'Discord client error');
    });

    this.client = client;

    try {
      await client.login(token);
    } catch (err: any) {
      logger.error({ err: err.message }, 'Discord bot login failed');
      this.client = null;
    }
  }

  private async handleMessage(message: Message): Promise<void> {
    const userId = message.author.id;
    const channelId = message.channel.id;
    const username = message.author.username;

    const dedupeKey = `${message.id}:${channelId}`;
    const now = Date.now();
    const lastSeen = this.processedMessages.get(dedupeKey);
    if (lastSeen && now - lastSeen < 30_000) {
      logger.debug({ messageId: message.id, channelId }, 'Discord duplicate message — skipping');
      return;
    }
    this.processedMessages.set(dedupeKey, now);
    // Prune entries older than 60s to prevent memory leak
    if (this.processedMessages.size > 1000) {
      const cutoff = now - 60_000;
      for (const [k, t] of this.processedMessages) {
        if (t < cutoff) this.processedMessages.delete(k);
      }
    }

    const content = message.content.trim();
    const command = this.getCommandName(content);

    logger.debug({ userId, username, channelId, command, content: content.slice(0, 80), isDM: !message.guild }, 'Discord message received');

    if (command === '/start' || command === 'start' || command === '/pair' || command === 'pair') {
      await this.handleAccessRequest(userId, channelId, username, message);
      return;
    }

    const approvedUser = findDiscordApprovedUser(this.config, userId);
    if (!approvedUser) {
      this.reloadConfig();
      const recheckedUser = findDiscordApprovedUser(this.config, userId);
      if (recheckedUser) {
        this.handleMessageWithApprovedUser(message, recheckedUser);
        return;
      }

      const pending = findDiscordPendingRequest(this.config, userId);
      if (pending) {
        await this.sendToChannel(message.channel, this.getPendingStatusMessage(pending));
      } else {
        await this.sendToChannel(message.channel, 'This bot is not available to you. Send /start to request access.');
      }
      return;
    }

    this.handleMessageWithApprovedUser(message, approvedUser);
  }

  private async handleMessageWithApprovedUser(message: Message, approvedUser: DiscordAccessUser): Promise<void> {
    const userId = message.author.id;
    const channelId = message.channel.id;
    const content = message.content.trim();
    const command = this.getCommandName(content);

    if (command === '/memory') {
      if (!this.chatCommandContext) {
        await this.sendToChannel(message.channel, 'Memory not available.');
        return;
      }
      await this.sendMemoryKeyboard(message.channel);
      return;
    }

    if (command === '/unpair') {
      if (!this.isAdminUser(userId)) {
        await this.sendToChannel(message.channel, 'Only Discord admins can reset Discord access.');
        return;
      }
      this.resetAccess();
      await this.sendToChannel(
        message.channel,
        'Discord access reset. New users can send /start to request access.',
      );
      return;
    }

    if (command === '/permissions') {
      this.askPermissionMode(`discord:${channelId}`).then((mode) => {
        this.permissionModes.set(channelId, mode);
        if (this.onPermissionMode) {
          this.onPermissionMode(mode, channelId);
        }
      }).catch(() => {});
      return;
    }

    if (message.guild) {
      if (this.config.channels.discord.ignoredChannels.includes(channelId)) return;

      if (this.config.channels.discord.requireMention &&
          !this.config.channels.discord.freeResponseChannels.includes(channelId) &&
          !message.mentions.has(this.client?.user?.id ?? '')) {
        return;
      }

      if (this.config.channels.discord.autoThread && !message.channel.isThread()) {
        try {
          const thread = await message.startThread({
            name: `Conversation with ${message.author.username}`,
            autoArchiveDuration: 60,
            reason: 'Auto-created conversation thread',
          });
          await thread.sendTyping();
        } catch (err: any) {
          logger.warn({ err: err.message }, 'Failed to auto-create thread');
        }
      }
    }

    if (!this.permissionModes.has(channelId) && this.onPermissionMode) {
      this.askPermissionMode(`discord:${channelId}`).then((mode) => {
        this.permissionModes.set(channelId, mode);
        if (this.onPermissionMode) {
          this.onPermissionMode(mode, channelId);
        }
      }).catch(() => {});
      this.permissionModes.set(channelId, 'ask-me');
    }

    if (this.config.channels.discord.reactions) {
      await message.react('👀').catch(() => {});
    }

    this.originalMessageIds.set(`discord:${channelId}`, { messageId: message.id, channelId });

    const senderRole = this.isAdminUser(userId) ? 'admin' as const : 'member' as const;
    const msg: ChannelMessage = {
      id: message.id,
      channelId: `discord:${channelId}`,
      channelType: 'discord',
      senderId: userId,
      senderName: message.author.username,
      senderRole,
      content: message.content,
      timestamp: message.createdTimestamp,
      metadata: { channelId, messageId: message.id },
    };
    this.emit(msg);
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    try {
      if (interaction.isButton()) {
        await this.handleButtonInteraction(interaction);
        return;
      }

      if (interaction.isStringSelectMenu()) {
        await this.handleSelectMenuInteraction(interaction);
        return;
      }

      if (interaction.isChatInputCommand()) {
        await this.handleSlashCommand(interaction);
        return;
      }
    } catch (err: any) {
      logger.error({ err: err.message, interactionType: interaction.type }, 'Discord interaction handler error');
      try {
        if (interaction.isChatInputCommand() && !interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: 'Something went wrong. Please try again.', flags: MessageFlags.Ephemeral });
        } else if (interaction.isChatInputCommand() && interaction.deferred && !interaction.replied) {
          await interaction.editReply('Something went wrong. Please try again.');
        } else if ((interaction.isButton() || interaction.isStringSelectMenu()) && !interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: 'Something went wrong.', flags: MessageFlags.Ephemeral });
        }
      } catch {
        // already responded or expired
      }
    }
  }

  private async handleButtonInteraction(interaction: ButtonInteraction): Promise<void> {
    const customId = interaction.customId;

    if (customId.startsWith(`${ACCESS_ACTION_PREFIX}:`)) {
      await this.handleAccessCallback(interaction, customId);
      return;
    }

    if (customId.startsWith(`${MEMORY_ACTION_PREFIX}:`)) {
      await this.handleMemoryCallback(interaction, customId);
      return;
    }

    const resolver = this.pendingApprovals.get(customId);
    if (!resolver) {
      await interaction.reply({ content: 'Expired', flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }

    this.pendingApprovals.delete(customId);
    resolver();
    const action = customId.split(':')[1];
    await interaction.update({ content: action === 'no' ? 'Denied' : 'Approved', components: [] }).catch(() => {});
  }

  private async handleSelectMenuInteraction(interaction: StringSelectMenuInteraction): Promise<void> {
    if (interaction.customId.startsWith('perm_mode:')) {
      const value = interaction.values[0] as PermissionMode;
      const channelId = interaction.customId.split(':')[1] || 'unknown';
      this.permissionModes.set(channelId, value);
      if (this.onPermissionMode) {
        this.onPermissionMode(value, channelId);
      }
      await interaction.update({
        content: `Permission mode set to: ${value === 'ask-me' ? '🔒 Ask Me' : '✅ Allow All'}`,
        components: [],
      }).catch(() => {});
      return;
    }
  }

  private async handleSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const userId = interaction.user.id;
    const commandName = interaction.commandName;
    logger.debug({ userId, commandName, channelId: interaction.channelId }, 'Discord slash command received');

    const approvedUser = findDiscordApprovedUser(this.config, userId);
    if (!approvedUser && interaction.commandName !== 'start') {
      await interaction.reply({ content: 'This bot is not available to you. Send /start to request access.', flags: MessageFlags.Ephemeral });
      return;
    }

    if (interaction.commandName === 'start' || interaction.commandName === 'pair') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const channelId = interaction.channelId || `dm:${interaction.user.id}`;
        const result = await this.handleAccessRequest(userId, channelId, interaction.user.username, null);
        await interaction.editReply(result || 'Access request processed.');
      } catch (err: any) {
        logger.error({ err: err.message }, 'Discord /start slash command failed');
        await interaction.editReply('Something went wrong. Try sending "start" as a plain text message instead.').catch(() => {});
      }
      return;
    }

    if (interaction.commandName === 'permissions') {
      const channelId = interaction.channelId || '';
      this.permissionModes.delete(channelId);
      this.askPermissionMode(`discord:${channelId}`).then((mode) => {
        this.permissionModes.set(channelId, mode);
        if (this.onPermissionMode) {
          this.onPermissionMode(mode, channelId);
        }
      }).catch(() => {});
      await interaction.reply({ content: 'Permission mode selector sent. Use the menu below to choose.', flags: MessageFlags.Ephemeral });
      return;
    }

    const msg: ChannelMessage = {
      id: interaction.id,
      channelId: `discord:${interaction.channelId}`,
      channelType: 'discord',
      senderId: userId,
      senderName: interaction.user.username,
      senderRole: this.isAdminUser(userId) ? 'admin' : 'member',
      content: `/${interaction.commandName} ${interaction.options.data.map((o: any) => o.value ?? o.name).join(' ')}`.trim(),
      timestamp: Date.now(),
      metadata: { channelId: interaction.channelId, interactionId: interaction.id },
    };

    await interaction.reply({ content: 'Processing...', flags: MessageFlags.Ephemeral }).catch(() => {});
    this.emit(msg);
  }

  private async registerCommands(): Promise<void> {
    if (!this.client?.application) return;
    const appId = this.config.channels.discord.applicationId;
    if (!appId) {
      logger.warn('Discord application ID not set — skipping slash command registration');
      return;
    }

    try {
      const contexts = [InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel];
      await this.client.application?.commands.set([
        { name: 'start', description: 'Request Discord access to this Mercury instance', dmPermission: true, contexts },
        { name: 'help', description: 'Show available commands', dmPermission: true, contexts },
        { name: 'status', description: 'Show agent config, budget, and uptime', dmPermission: true, contexts },
        { name: 'progress', description: 'Live status for the current task', dmPermission: true, contexts },
        { name: 'stop', description: 'Stop all agents and clear queue', dmPermission: true, contexts },
        { name: 'budget', description: 'Token budget status and management', dmPermission: true, contexts },
        { name: 'stream', description: 'Toggle text streaming on/off', dmPermission: true, contexts },
        { name: 'memory', description: 'View and manage second brain memory', dmPermission: true, contexts },
        { name: 'permissions', description: 'Change permission mode', dmPermission: true, contexts },
        { name: 'models', description: 'List providers or switch AI model', dmPermission: true, contexts },
        { name: 'code', description: 'Programming mode (plan / execute / off)', dmPermission: true, contexts },
        { name: 'agents', description: 'List and manage sub-agents', dmPermission: true, contexts },
        { name: 'bg', description: 'Background tasks (list / cancel / run)', dmPermission: true, contexts },
        { name: 'spotify', description: 'Spotify playback controls', dmPermission: true, contexts },
        { name: 'unpair', description: 'Reset all Discord access (admin only)', dmPermission: true, contexts },
      ]);
      logger.info('Discord slash commands registered');
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Failed to register Discord slash commands');
    }
  }

  async stop(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
    this.ready = false;
  }

  async send(content: string, targetId?: string, elapsedMs?: number): Promise<void> {
    const channelIds = this.resolveTargetChannelIds(targetId);
    if (channelIds.length === 0 || !this.client) return;

    const key = targetId || 'notification';
    logger.debug({ targetId, key, contentLength: content.length, channelIds, taskActive: this.taskActive.get(key) }, 'Discord send()');

    if (this.taskActive.get(key)) {
      const timeSuffix = elapsedMs != null ? ` (${(elapsedMs / 1000).toFixed(1)}s)` : '';
      const fullContent = content + timeSuffix;
      if (!fullContent.trim()) return;

      const isSystemNotice = content.startsWith('☿ ') || content.startsWith('⚠') || content.startsWith('  [') || content.length < 200;
      if (isSystemNotice) {
        const notices = this.statusNotices.get(key) || [];
        const truncated = fullContent.length > 80 ? fullContent.slice(0, 77) + '...' : fullContent;
        notices.push(truncated);
        this.statusNotices.set(key, notices);
        await this.refreshStatusCard(targetId);
      } else {
        this.deferredResponses.set(key, fullContent);
      }
      return;
    }

    const timeSuffix = elapsedMs != null ? `\n${(elapsedMs / 1000).toFixed(1)}s` : '';
    const fullContent = content + timeSuffix;
    if (!fullContent.trim()) return;

    const md = mdToDiscord(fullContent);
    const chunks = this.splitMessage(md, MAX_MESSAGE_LENGTH);

    for (const chId of channelIds) {
      const channel = this.client.channels.cache.get(chId) ??
        await this.client.channels.fetch(chId).catch(() => null);
      if (!channel || !isSendable(channel)) continue;

      for (const chunk of chunks) {
        try {
          await channel.send(chunk);
        } catch (err: any) {
          logger.error({ err: err.message, channelId: chId }, 'Discord send failed');
        }
      }
    }
  }

  async sendFile(filePath: string, targetId?: string): Promise<void> {
    const channelIds = this.resolveTargetChannelIds(targetId);
    if (channelIds.length === 0 || !this.client) return;

    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      for (const chId of channelIds) {
        const channel = this.client.channels.cache.get(chId);
        if (isSendable(channel)) {
          await channel.send(`File not found: ${filePath}`).catch(() => {});
        }
      }
      return;
    }

    const filename = path.basename(resolved);
    const ext = path.extname(resolved).toLowerCase();
    const attachment = new AttachmentBuilder(resolved, { name: filename });

    for (const chId of channelIds) {
      const channel = this.client.channels.cache.get(chId) ??
        await this.client.channels.fetch(chId).catch(() => null);
      if (!channel || !isSendable(channel)) continue;

      try {
        if (this.isImageFile(ext)) {
          await channel.send({ content: filename, files: [attachment] });
        } else {
          await channel.send({ files: [attachment] });
        }
        logger.info({ file: resolved, channelId: chId }, 'File sent via Discord');
      } catch (err: any) {
        logger.error({ err: err.message, file: resolved, channelId: chId }, 'Discord sendFile failed');
        await channel.send(`Failed to send file: ${err.message}`).catch(() => {});
      }
    }
  }

  async stream(content: AsyncIterable<string>, targetId?: string): Promise<string> {
    const channelIds = this.resolveTargetChannelIds(targetId);
    if (channelIds.length === 0 || !this.client) return '';

    let full = '';
    for await (const chunk of content) {
      full += chunk;
    }

    const key = targetId || 'notification';
    if (this.taskActive.get(key)) {
      this.deferredResponses.set(key, full);
      return full;
    }

    this.deleteStatusMessage(targetId);

    const md = mdToDiscord(full);
    for (const chId of channelIds) {
      const channel = this.client.channels.cache.get(chId);
      if (isSendable(channel)) {
        const chunks = this.splitMessage(md, MAX_MESSAGE_LENGTH);
        for (const chunk of chunks) {
          await channel.send(chunk).catch(() => {});
        }
      }
    }
    return full;
  }

  async sendStreamToChat(channelId: string, textStream: AsyncIterable<string>): Promise<string> {
    if (!this.client) return '';

    const activeKey = this.findActiveTaskKey(channelId);
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

    const channel = this.client.channels.cache.get(channelId) ??
      await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel || !isSendable(channel)) {
      let full = '';
      for await (const chunk of textStream) { full += chunk; }
      return full;
    }

    this.startTypingLoop(channelId);

    try {
      let full = '';
      let message: Message | null = null;
      let lastEditTime = 0;
      let lastEditLength = 0;

      for await (const chunk of textStream) {
        full += chunk;

        const now = Date.now();
        const timeSinceLastEdit = now - lastEditTime;
        const charsSinceLastEdit = full.length - lastEditLength;

        if (!message && full.length >= STREAM_MIN_LENGTH) {
          try {
            message = await channel.send(full + ' |');
            lastEditTime = now;
            lastEditLength = full.length;
          } catch {
            message = null;
          }
        } else if (message && timeSinceLastEdit >= STREAM_EDIT_INTERVAL && charsSinceLastEdit >= 20) {
          try {
            await message.edit(full + ' |');
            lastEditTime = now;
            lastEditLength = full.length;
          } catch {
            // edit failed — rate limited or message unchanged
          }
        }
      }

      if (message) {
        const md = mdToDiscord(full);
        try {
          await message.edit(md);
        } catch {
          // final edit failed
        }
      } else if (full.trim()) {
        const md = mdToDiscord(full);
        const chunks = this.splitMessage(md, MAX_MESSAGE_LENGTH);
        for (const chunk of chunks) {
          await channel.send(chunk).catch(() => {});
        }
      }

      return full;
    } finally {
      this.stopTypingLoop(channelId);
    }
  }

  async sendToolFeedback(toolName: string, args: Record<string, any>, targetId?: string): Promise<void> {
    const key = targetId || 'notification';
    const step = (this.stepCounters.get(key) || 0) + 1;
    this.stepCounters.set(key, step);
    const label = formatToolStep(toolName, args);

    const history = this.stepHistory.get(key) || [];
    const recentHistory = history.slice(-5);
    const embed = this.buildStatusEmbed(step, recentHistory, label);
    await this.updateStatusMessage(embed, targetId);

    if (step === DiscordChannel.PIN_STEP_THRESHOLD) {
      await this.pinStatusMessage(targetId);
    }
  }

  async sendStepDone(toolName: string, result: unknown, targetId?: string): Promise<void> {
    const key = targetId || 'notification';
    const step = this.stepCounters.get(key) || 0;
    const summary = formatToolResult(toolName, result);
    const label = formatToolStep(toolName, {} as any);
    const doneLine = summary ? `${label} - ${summary}` : label;

    const history = this.stepHistory.get(key) || [];
    history.push(doneLine);
    this.stepHistory.set(key, history);

    const recentHistory = history.slice(-5);
    const embed = this.buildStatusEmbed(step, recentHistory);
    await this.updateStatusMessage(embed, targetId);
  }

  async typing(targetId?: string): Promise<void> {
    const channelIds = this.resolveTargetChannelIds(targetId);
    if (channelIds.length === 0 || !this.client) return;
    const channel = this.client.channels.cache.get(channelIds[0]);
    if (isSendable(channel)) {
      await channel.sendTyping().catch(() => {});
    }
  }

  private typingIntervals = new Map<string, NodeJS.Timeout>();

  startTypingLoop(channelId: string): void {
    this.stopTypingLoop(channelId);
    const channel = this.client?.channels.cache.get(channelId);
    if (isSendable(channel)) {
      channel.sendTyping().catch(() => {});
    }
    const interval = setInterval(() => {
      const ch = this.client?.channels.cache.get(channelId);
      if (isSendable(ch)) ch.sendTyping().catch(() => {});
    }, 9000);
    this.typingIntervals.set(channelId, interval);
  }

  stopTypingLoop(channelId?: string): void {
    if (channelId) {
      const interval = this.typingIntervals.get(channelId);
      if (interval) {
        clearInterval(interval);
        this.typingIntervals.delete(channelId);
      }
    } else {
      for (const [, interval] of this.typingIntervals) {
        clearInterval(interval);
      }
      this.typingIntervals.clear();
    }
  }

  async askPermission(prompt: string, targetId?: string): Promise<string> {
    const channelIds = this.resolveTargetChannelIds(targetId);
    const channelId = channelIds[0];
    if (!channelId || !this.client) return 'no';

    const id = `perm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${id}:yes`).setLabel('Allow').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`${id}:always`).setLabel('Always').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`${id}:no`).setLabel('Deny').setStyle(ButtonStyle.Danger),
    );

    const channel = this.client.channels.cache.get(channelId);
    if (!isSendable(channel)) return 'no';

    let sentMsgId: string | undefined;
    try {
      const msg = await channel.send({ content: prompt, components: [row] });
      sentMsgId = msg.id;
    } catch (err: any) {
      logger.error({ err: err.message }, 'Discord askPermission send failed');
      return 'no';
    }

    return new Promise((resolve) => {
      const cleanup = (result: string) => {
        this.pendingApprovals.delete(`${id}:yes`);
        this.pendingApprovals.delete(`${id}:always`);
        this.pendingApprovals.delete(`${id}:no`);
        this.deleteInteractionMessage(channelId, sentMsgId);
        resolve(result);
      };
      this.pendingApprovals.set(`${id}:yes`, () => cleanup('yes'));
      this.pendingApprovals.set(`${id}:always`, () => cleanup('always'));
      this.pendingApprovals.set(`${id}:no`, () => cleanup('no'));

      setTimeout(() => {
        this.pendingApprovals.delete(`${id}:yes`);
        this.pendingApprovals.delete(`${id}:always`);
        this.pendingApprovals.delete(`${id}:no`);
        this.deleteInteractionMessage(channelId, sentMsgId);
        resolve('no');
      }, 300_000);
    });
  }

  async askToContinue(question: string, targetId?: string): Promise<boolean> {
    const channelIds = this.resolveTargetChannelIds(targetId);
    const channelId = channelIds[0];
    if (!channelId || !this.client) return false;

    const id = `loop_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${id}:yes`).setLabel('Continue').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`${id}:no`).setLabel('Stop').setStyle(ButtonStyle.Danger),
    );

    const channel = this.client.channels.cache.get(channelId);
    if (!isSendable(channel)) return false;

    let sentMsgId: string | undefined;
    try {
      const msg = await channel.send({ content: question, components: [row] });
      sentMsgId = msg.id;
    } catch {
      return false;
    }

    return new Promise((resolve) => {
      const cleanup = (result: boolean) => {
        this.pendingApprovals.delete(`${id}:yes`);
        this.pendingApprovals.delete(`${id}:no`);
        this.deleteInteractionMessage(channelId, sentMsgId);
        resolve(result);
      };
      this.pendingApprovals.set(`${id}:yes`, () => cleanup(true));
      this.pendingApprovals.set(`${id}:no`, () => cleanup(false));

      setTimeout(() => {
        this.pendingApprovals.delete(`${id}:yes`);
        this.pendingApprovals.delete(`${id}:no`);
        this.deleteInteractionMessage(channelId, sentMsgId);
        resolve(false);
      }, 300_000);
    });
  }

  async askPermissionMode(targetId?: string): Promise<PermissionMode> {
    const channelIds = this.resolveTargetChannelIds(targetId);
    const channelId = channelIds[0];
    if (!channelId || !this.client) return 'ask-me';

    const selectId = `perm_mode:${channelId}`;
    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(selectId)
        .setPlaceholder('Choose permission mode')
        .addOptions(
          { label: 'Ask Me', value: 'ask-me', description: 'Confirm before file writes, commands, and scope changes' },
          { label: 'Allow All', value: 'allow-all', description: 'Auto-approve everything (scopes, commands, loops)' },
        ),
    );

    const channel = this.client.channels.cache.get(channelId);
    if (!isSendable(channel)) return 'ask-me';

    const content = '**Permission Mode**\nHow should Mercury handle risky actions this session?';
    let sentMsgId: string | undefined;
    try {
      const msg = await channel.send({ content, components: [row] });
      sentMsgId = msg.id;
    } catch {
      return 'ask-me';
    }

    return new Promise((resolve) => {
      const handler = (mode: PermissionMode) => {
        this.client?.removeListener('interactionCreate', listener);
        this.deleteInteractionMessage(channelId, sentMsgId);
        resolve(mode);
      };
      const listener = async (interaction: Interaction) => {
        if (!interaction.isStringSelectMenu() || interaction.customId !== selectId) return;
        const value = interaction.values[0] as PermissionMode;
        await interaction.update({ content: `Permission mode: ${value === 'ask-me' ? 'Ask Me' : 'Allow All'}`, components: [] }).catch(() => {});
        handler(value);
      };
      this.client?.on('interactionCreate', listener);

      setTimeout(() => {
        this.client?.removeListener('interactionCreate', listener);
        this.deleteInteractionMessage(channelId, sentMsgId);
        resolve('ask-me');
      }, 300_000);
    });
  }

  async requestChoice(question: string, choices: string[], targetId?: string): Promise<string> {
    const channelIds = this.resolveTargetChannelIds(targetId);
    const channelId = channelIds[0];
    if (!channelId || !this.client) return choices[0] ?? '';

    if (choices.length <= 5) {
      return this.requestChoiceButtons(question, choices, channelId, targetId);
    }

    const id = `choice_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(id)
        .setPlaceholder(question)
        .addOptions(choices.map((c, i) => ({ label: c.length > 100 ? c.slice(0, 97) + '...' : c, value: String(i), description: c.length > 100 ? c.slice(0, 99) + '...' : undefined }))),
    );

    const channel = this.client.channels.cache.get(channelId);
    if (!isSendable(channel)) return choices[0] ?? '';

    try {
      await channel.send({ content: question, components: [row] });
    } catch {
      return choices[0] ?? '';
    }

    return new Promise((resolve) => {
      const listener = async (interaction: Interaction) => {
        if (!interaction.isStringSelectMenu() || interaction.customId !== id) return;
        const idx = parseInt(interaction.values[0], 10);
        await interaction.update({ content: `Selected: ${choices[idx]}`, components: [] }).catch(() => {});
        this.client?.removeListener('interactionCreate', listener);
        resolve(choices[idx] ?? choices[0]);
      };
      this.client?.on('interactionCreate', listener);

      setTimeout(() => {
        this.client?.removeListener('interactionCreate', listener);
        resolve(choices[0] ?? '');
      }, 120_000);
    });
  }

  private async requestChoiceButtons(question: string, choices: string[], channelId: string, targetId?: string): Promise<string> {
    const id = `choice_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const row = new ActionRowBuilder<ButtonBuilder>();
    for (const choice of choices) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`${id}:${choice}`)
          .setLabel(choice.length > 80 ? choice.slice(0, 77) + '...' : choice)
          .setStyle(ButtonStyle.Primary),
      );
    }

    const channel = this.client!.channels.cache.get(channelId);
    if (!isSendable(channel)) return choices[0];

    try {
      await channel.send({ content: question, components: [row] });
    } catch {
      return choices[0];
    }

    return new Promise((resolve) => {
      for (const choice of choices) {
        this.pendingApprovals.set(`${id}:${choice}`, () => {
          for (const c of choices) {
            this.pendingApprovals.delete(`${id}:${c}`);
          }
          resolve(choice);
        });
      }

      setTimeout(() => {
        for (const choice of choices) {
          this.pendingApprovals.delete(`${id}:${choice}`);
        }
        resolve(choices[0]);
      }, 120_000);
    });
  }

  async sendCompletion(elapsedMs: number, stepCount: number, targetId?: string, meta?: { provider: string; model: string; inputTokens: number; outputTokens: number; totalTokens: number; budgetUsed: number; budgetTotal: number; budgetPercentage: number }): Promise<void> {
    const secs = Math.floor(elapsedMs / 1000);
    const mins = Math.floor(secs / 60);
    const remSecs = secs % 60;
    const timeStr = mins > 0 ? `${mins}m ${remSecs}s` : `${secs}s`;
    const stepsStr = stepCount > 0 ? `${stepCount} step${stepCount !== 1 ? 's' : ''}` : '';
    const parts = [stepsStr, timeStr].filter(Boolean).join(' - ');

    const key = targetId || 'notification';
    const history = this.stepHistory.get(key) || [];
    const recentHistory = history.slice(-5);

    const embed = new EmbedBuilder()
      .setColor(0x00FF00)
      .setTitle(`Task complete (${parts})`)
      .setTimestamp();

    if (meta) {
      const formatTokens = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
      const pct = Math.round(meta.budgetPercentage);
      const barLen = 15;
      const filled = Math.round((pct / 100) * barLen);
      const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(barLen - filled);
      embed.addFields(
        { name: 'Model', value: `${meta.model} via ${meta.provider}`, inline: true },
        { name: 'Tokens', value: formatTokens(meta.totalTokens), inline: true },
        { name: 'Budget', value: `${bar} ${pct}%`, inline: true },
      );
    }

    if (recentHistory.length > 0) {
      embed.addFields({
        name: 'Steps',
        value: recentHistory.map(h => `\u2713 ${h}`).join('\n'),
        inline: false,
      });
    }

    await this.deleteStatusMessage(targetId);
    await this.cleanupEphemeralMessages(targetId);
    this.endTask(targetId);

    const channelIds = this.resolveTargetChannelIds(targetId);

    const deferred = this.deferredResponses.get(key);
    if (deferred && deferred.trim()) {
      this.deferredResponses.delete(key);
      const deferredMd = mdToDiscord(deferred);
      const chunks = this.splitMessage(deferredMd, MAX_MESSAGE_LENGTH);
      for (const chId of channelIds) {
        const channel = this.client?.channels.cache.get(chId);
        if (isSendable(channel)) {
          for (const chunk of chunks) {
            await channel.send(chunk).catch(() => {});
          }
        }
      }
    }

    for (const chId of channelIds) {
      const channel = this.client?.channels.cache.get(chId);
      if (isSendable(channel)) {
        await channel.send({ embeds: [embed] }).catch(() => {});
        if (this.config.channels.discord.reactions) {
          await this.reactToOriginalMessage(key, '✅');
        }
      }
    }

    this.stepCounters.delete(key);
    this.stepHistory.delete(key);
    this.statusNotices.delete(key);
  }

  resetStepCounter(targetId?: string): void {
    const key = targetId || 'notification';
    this.stepCounters.delete(key);
    this.stepHistory.delete(key);
    this.statusNotices.delete(key);
    this.endTask(targetId);
    this.deleteStatusMessage(targetId);
    this.originalMessageIds.delete(key);
  }

  async cleanupEphemeralMessages(targetId?: string): Promise<void> {
    if (!this.client) return;
    const key = targetId || 'notification';
    const ids = this.ephemeralMessageIds.get(key) || [];
    const channelIds = this.resolveTargetChannelIds(targetId);
    for (const chId of channelIds) {
      const channel = this.client.channels.cache.get(chId);
      if (!isSendable(channel)) continue;
      for (const msgId of ids) {
        await channel.messages.delete(msgId).catch(() => {});
      }
    }
    this.ephemeralMessageIds.delete(key);
  }

  // ─── Private helpers ───────────────────────────────────────

  private buildStatusEmbed(step: number, history: string[], current?: string): EmbedBuilder {
    const embed = new EmbedBuilder()
      .setColor(0xFFC800)
      .setTitle(`Mercury working (step ${step})`)
      .setTimestamp();

    if (history.length > 0) {
      embed.addFields({
        name: 'Completed',
        value: history.slice(-5).map(h => `\u2705 ${h}`).join('\n'),
        inline: false,
      });
    }
    if (current) {
      embed.addFields({ name: 'Current', value: `\u23f3 ${current}...`, inline: false });
    }
    return embed;
  }

  private async updateStatusMessage(embed: EmbedBuilder, targetId?: string): Promise<void> {
    const channelIds = this.resolveTargetChannelIds(targetId);
    if (channelIds.length === 0 || !this.client) return;

    const key = targetId || 'notification';

    for (const chId of channelIds) {
      const channel = this.client.channels.cache.get(chId) ??
        await this.client.channels.fetch(chId).catch(() => null);
      if (!channel || !isSendable(channel)) continue;

      const existingMsgId = this.statusMessageIds.get(key);
      if (existingMsgId) {
        try {
          const existingMsg = await channel.messages.fetch(existingMsgId).catch(() => null);
          if (existingMsg) {
            await existingMsg.edit({ embeds: [embed] });
            return;
          }
        } catch {
          this.statusMessageIds.delete(key);
        }
      }

      try {
        const msg = await channel.send({ embeds: [embed] });
        this.statusMessageIds.set(key, msg.id);
      } catch (err: any) {
        logger.warn({ err: err.message, channelId: chId }, 'Failed to send Discord status message');
      }
    }
  }

  private async deleteStatusMessage(targetId?: string): Promise<void> {
    if (!this.client) return;
    const key = targetId || 'notification';
    const msgId = this.statusMessageIds.get(key);
    if (!msgId) return;

    await this.unpinStatusMessage(targetId);

    const channelIds = this.resolveTargetChannelIds(targetId);
    for (const chId of channelIds) {
      const channel = this.client.channels.cache.get(chId);
      if (isSendable(channel)) {
        try {
          const msg = await channel.messages.fetch(msgId).catch(() => null);
          if (msg) await msg.delete().catch(() => {});
        } catch {
          // message already deleted
        }
      }
    }
    this.statusMessageIds.delete(key);
  }

  private async refreshStatusCard(targetId?: string): Promise<void> {
    const key = targetId || 'notification';
    const step = this.stepCounters.get(key) || 0;
    const history = this.stepHistory.get(key) || [];
    const notices = this.statusNotices.get(key) || [];

    const recentHistory = history.slice(-5);
    const recentNotices = notices.slice(-DiscordChannel.MAX_STATUS_NOTICES);

    const embed = new EmbedBuilder()
      .setColor(0xFFC800)
      .setTitle(`Mercury working (step ${step})`)
      .setTimestamp();

    if (recentHistory.length > 0) {
      embed.addFields({
        name: 'Completed',
        value: recentHistory.map(h => `\u2705 ${h}`).join('\n'),
        inline: false,
      });
    }

    if (recentNotices.length > 0) {
      embed.addFields({
        name: 'Notices',
        value: recentNotices.map(n => `\u2139 ${n}`).join('\n'),
        inline: false,
      });
    }

    await this.updateStatusMessage(embed, targetId);
  }

  private async handleAccessRequest(
    userId: string,
    channelId: string,
    username: string,
    message: Message | null,
  ): Promise<string | null> {
    logger.info({ userId, username, channelId, isDM: message ? !message.guild : true }, 'Discord access request received');
    this.reloadConfig();
    const approvedUser = findDiscordApprovedUser(this.config, userId);
    if (approvedUser) {
      const role = this.isAdminUser(userId) ? 'admin' as const : 'member' as const;
      const target = message ? message.channel : null;
      if (isSendable(target)) {
        await this.sendToChannel(target, `You are already approved as a Discord ${role}.\n\nDiscord access: ${getDiscordAccessSummary(this.config)}`);
      }
      return null;
    }

    const existingRequest = findDiscordPendingRequest(this.config, userId);
    if (existingRequest) {
      const msg = this.getPendingStatusMessage(existingRequest);
      const target = message ? message.channel : null;
      if (isSendable(target)) {
        await this.sendToChannel(target, msg);
      }
      return msg;
    }

    if (!hasDiscordAdmins(this.config) && this.config.channels.discord.pending.length > 0) {
      const msg = 'Initial Discord pairing is already in progress for another user.';
      const target = message ? message.channel : null;
      if (isSendable(target)) {
        await this.sendToChannel(target, msg);
      }
      return msg;
    }

    const request = addDiscordPendingRequest(this.config, {
      id: userId,
      username,
      channelId,
      pairingCode: hasDiscordAdmins(this.config) ? undefined : this.generatePairingCode(),
    });
    saveConfig(this.config);
    logger.info({ userId, username, channelId }, 'Discord access request recorded');

    const msg = this.getPendingStatusMessage(request);
    const target = message ? message.channel : null;
    if (isSendable(target)) {
      await this.sendToChannel(target, msg);
    }

    if (hasDiscordAdmins(this.config)) {
      await this.notifyAdminsOfPendingRequest(request);
    }
    return msg;
  }

  private async notifyAdminsOfPendingRequest(request: DiscordPendingRequest): Promise<void> {
    if (!this.client) return;

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${ACCESS_ACTION_PREFIX}:approve:${request.id}`).setLabel('Approve').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`${ACCESS_ACTION_PREFIX}:reject:${request.id}`).setLabel('Reject').setStyle(ButtonStyle.Danger),
    );

    const usernameStr = request.username ? ` (${request.username})` : '';
    const content = [
      'Discord access request pending approval.',
      '',
      `User ID: ${request.id}${usernameStr}`,
      `Requested: ${new Date(request.requestedAt).toLocaleString()}`,
      '',
      'Use the buttons below to approve or reject.',
    ].join('\n');

    for (const admin of getDiscordAdmins(this.config)) {
      const channelId = admin.requestedAt ? undefined : undefined;
      if (admin.id && this.client.users.cache.has(admin.id)) {
        try {
          const dm = await this.client.users.createDM(admin.id);
          await dm.send({ content, components: [row] });
        } catch (err: any) {
          logger.warn({ err: err.message, adminId: admin.id }, 'Failed to notify Discord admin via DM');
        }
      }
    }
  }

  private async handleAccessCallback(interaction: ButtonInteraction, data: string): Promise<void> {
    const actorUserId = interaction.user.id;
    if (!this.isAdminUser(actorUserId)) {
      await interaction.reply({ content: 'Admins only', flags: MessageFlags.Ephemeral });
      return;
    }

    const [, action, rawUserId] = data.split(':');
    if (!rawUserId) {
      await interaction.reply({ content: 'Invalid request', flags: MessageFlags.Ephemeral });
      return;
    }

    const request = findDiscordPendingRequest(this.config, rawUserId);
    if (!request) {
      await interaction.reply({ content: 'Already handled', flags: MessageFlags.Ephemeral });
      return;
    }

    if (action === 'approve') {
      const approved = approveDiscordPendingRequest(this.config, rawUserId, 'member');
      if (!approved) {
        await interaction.reply({ content: 'Already handled', flags: MessageFlags.Ephemeral });
        return;
      }
      saveConfig(this.config);
      await interaction.update({ content: `Approved Discord access for ${request.username || request.id}.`, components: [] });

      if (request.channelId && this.client) {
        const channel = this.client.channels.cache.get(request.channelId) ??
          await this.client.channels.fetch(request.channelId).catch(() => null);
        if (isSendable(channel)) {
          await channel.send(`Discord access approved. You can now chat with Mercury.\n\nDiscord access: ${getDiscordAccessSummary(this.config)}`).catch(() => {});
        }
      }
      return;
    }

    if (action === 'reject') {
      const rejected = rejectDiscordPendingRequest(this.config, rawUserId);
      if (!rejected) {
        await interaction.update({ content: 'Already handled', components: [] });
        return;
      }
      saveConfig(this.config);
      await interaction.update({ content: `Rejected Discord access for ${request.username || request.id}.`, components: [] });

      if (request.channelId && this.client) {
        const channel = this.client.channels.cache.get(request.channelId) ??
          await this.client.channels.fetch(request.channelId).catch(() => null);
        if (isSendable(channel)) {
          await channel.send('Your Discord access request was rejected.').catch(() => {});
        }
      }
      return;
    }

    await interaction.reply({ content: 'Unknown action', flags: MessageFlags.Ephemeral });
  }

  private async sendMemoryKeyboard(channel: any): Promise<void> {
    if (!this.chatCommandContext) return;

    const summary = this.chatCommandContext.memorySummary();
    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('Memory Overview')
      .addFields(
        { name: 'Total', value: `${summary.total}`, inline: true },
        { name: 'Learning', value: summary.learningPaused ? 'PAUSED' : 'ACTIVE', inline: true },
      );

    if (summary.profileSummary) {
      embed.addFields({ name: 'Profile', value: summary.profileSummary, inline: false });
    }

    const typeEntries = Object.entries(summary.byType);
    if (typeEntries.length > 0) {
      embed.addFields({
        name: 'By type',
        value: typeEntries.map(([type, count]) => `${type}: ${count}`).join('\n'),
        inline: false,
      });
    }

    const learningLabel = summary.learningPaused ? 'Resume' : 'Pause';
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${MEMORY_ACTION_PREFIX}:overview`).setLabel('Overview').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`${MEMORY_ACTION_PREFIX}:recent`).setLabel('Recent').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`${MEMORY_ACTION_PREFIX}:toggle_learning`).setLabel(learningLabel).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`${MEMORY_ACTION_PREFIX}:clear_confirm`).setLabel('Clear All').setStyle(ButtonStyle.Danger),
    );

    await channel.send({ embeds: [embed], components: [row] }).catch(() => {});
  }

  private async handleMemoryCallback(interaction: ButtonInteraction, data: string): Promise<void> {
    if (!this.chatCommandContext) {
      await interaction.reply({ content: 'Not available', flags: MessageFlags.Ephemeral });
      return;
    }

    const action = data.slice(`${MEMORY_ACTION_PREFIX}:`.length);
    const channel = interaction.channel;
    if (!isSendable(channel)) return;

    if (action === 'overview') {
      await interaction.deferUpdate();
      const summary = this.chatCommandContext.memorySummary();
      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('Memory Overview')
        .addFields(
          { name: 'Total', value: `${summary.total}`, inline: true },
          { name: 'Learning', value: summary.learningPaused ? 'PAUSED' : 'ACTIVE', inline: true },
        );
      if (summary.profileSummary) {
        embed.addFields({ name: 'Profile', value: summary.profileSummary, inline: false });
      }
      if (summary.activeSummary) {
        embed.addFields({ name: 'Active', value: summary.activeSummary, inline: false });
      }
      await channel.send({ embeds: [embed] }).catch(() => {});
      return;
    }

    if (action === 'recent') {
      await interaction.deferUpdate();
      const recent = this.chatCommandContext.memoryRecent(10);
      if (recent.length === 0) {
        await channel.send('No memories yet.').catch(() => {});
        return;
      }
      const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('Recent Memories');
      for (const r of recent.slice(0, 10)) {
        embed.addFields({
          name: `[${r.type}] ${r.scope === 'active' ? '\u23f3' : '\ud83d\udccc'}`,
          value: `${r.summary}\nConfidence: ${r.confidence.toFixed(2)} | Evidence: ${r.evidenceKind} | Seen: ${r.evidenceCount}x`,
          inline: false,
        });
      }
      await channel.send({ embeds: [embed] }).catch(() => {});
      return;
    }

    if (action === 'toggle_learning') {
      const currentSummary = this.chatCommandContext.memorySummary();
      const currentlyPaused = currentSummary.learningPaused;
      this.chatCommandContext.memorySetLearningPaused(!currentlyPaused);
      const label = currentlyPaused ? 'Learning resumed' : 'Learning paused';
      await interaction.update({ content: label, components: [] });
      await this.sendMemoryKeyboard(channel);
      return;
    }

    if (action === 'clear_confirm') {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`${MEMORY_ACTION_PREFIX}:clear_yes`).setLabel('Yes, clear everything').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`${MEMORY_ACTION_PREFIX}:clear_no`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
      );
      await interaction.update({ content: 'Are you sure you want to clear **all** memories? This cannot be undone.', components: [row] });
      return;
    }

    if (action === 'clear_yes') {
      const cleared = this.chatCommandContext.memoryClear();
      await interaction.update({ content: `Cleared ${cleared} memories.`, components: [] });
      return;
    }

    if (action === 'clear_no') {
      await interaction.update({ content: 'Cancelled.', components: [] });
      return;
    }

    await interaction.reply({ content: 'Unknown action', flags: MessageFlags.Ephemeral });
  }

  private resolveTargetChannelIds(targetId?: string): string[] {
    if (!targetId || targetId === 'notification') {
      return getDiscordApprovedUserIds(this.config)
        .flatMap((id) => {
          const user = this.client?.users.cache.get(id);
          return user ? [user.dmChannel?.id ?? ''] : [];
        })
        .filter(Boolean);
    }

    if (targetId.startsWith('discord:')) {
      return [targetId.split(':')[1]];
    }

    return [targetId];
  }

  private isAdminUser(userId: string): boolean {
    return !!findDiscordAdmin(this.config, userId);
  }

  private getCommandName(text: string): string {
    const stripped = text.replace(/<@!?\d+>/g, '').trim();
    return stripped.split(/\s+/)[0]?.toLowerCase() || '';
  }

  private getPendingStatusMessage(request?: DiscordPendingRequest): string {
    if (!hasDiscordAdmins(this.config)) {
      const pairingCode = request?.pairingCode ?? 'unknown';
      return [
        'Your Discord pairing request has been recorded.',
        '',
        `Pairing code: ${pairingCode}`,
        '',
        'Enter this code in the Mercury terminal to finish setup.',
      ].join('\n');
    }
    return 'Your Discord access request has been recorded and is waiting for approval from a Discord admin.';
  }

  private resetAccess(): void {
    clearDiscordAccess(this.config);
    saveConfig(this.config);
    logger.info('Discord access reset');
  }

  private generatePairingCode(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
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

  private async sendToChannel(channel: any, content: string): Promise<void> {
    if (!isSendable(channel)) return;
    const md = mdToDiscord(content);
    const chunks = this.splitMessage(md, MAX_MESSAGE_LENGTH);
    for (const chunk of chunks) {
      await channel.send(chunk).catch(() => {});
    }
  }

  private trackEphemeral(targetId: string | undefined, messageId: string): void {
    const key = targetId || 'notification';
    const ids = this.ephemeralMessageIds.get(key) || [];
    ids.push(messageId);
    this.ephemeralMessageIds.set(key, ids);
  }

  private async deleteInteractionMessage(channelId: string, messageId: string | undefined): Promise<void> {
    if (!this.client || !messageId) return;
    const channel = this.client.channels.cache.get(channelId);
    if (isSendable(channel)) {
      await channel.messages.delete(messageId).catch(() => {});
    }
  }

  private async deleteEphemeralMessage(targetId: string | undefined, messageId: string): Promise<void> {
    if (!this.client) return;
    const channelIds = this.resolveTargetChannelIds(targetId);
    for (const chId of channelIds) {
      const channel = this.client.channels.cache.get(chId);
      if (isSendable(channel)) {
        await channel.messages.delete(messageId).catch(() => {});
      }
    }
    const key = targetId || 'notification';
    const ids = this.ephemeralMessageIds.get(key);
    if (ids) {
      const idx = ids.indexOf(messageId);
      if (idx !== -1) ids.splice(idx, 1);
    }
  }

  private async pinStatusMessage(targetId?: string): Promise<void> {
    if (!this.client) return;
    const key = targetId || 'notification';
    const msgId = this.statusMessageIds.get(key);
    if (!msgId) return;

    const channelIds = this.resolveTargetChannelIds(targetId);
    for (const chId of channelIds) {
      const channel = this.client.channels.cache.get(chId);
      if (!isSendable(channel)) continue;

      const existingPin = this.pinnedMessageIds.get(key);
      if (existingPin && existingPin !== msgId) {
        try {
          const existingMsg = await channel.messages.fetch(existingPin).catch(() => null);
          if (existingMsg) await existingMsg.unpin().catch(() => {});
        } catch {
          // already unpinned
        }
        this.pinnedMessageIds.delete(key);
      }

      if (existingPin === msgId) return;

      try {
        const msg = await channel.messages.fetch(msgId).catch(() => null);
        if (msg) await msg.pin();
        this.pinnedMessageIds.set(key, msgId);
      } catch (err: any) {
        logger.warn({ err: err.message, channelId: chId }, 'Failed to pin Discord status message');
      }
    }
  }

  private async unpinStatusMessage(targetId?: string): Promise<void> {
    if (!this.client) return;
    const key = targetId || 'notification';
    const msgId = this.pinnedMessageIds.get(key);
    if (!msgId) return;

    const channelIds = this.resolveTargetChannelIds(targetId);
    for (const chId of channelIds) {
      const channel = this.client.channels.cache.get(chId);
      if (!isSendable(channel)) continue;
      try {
        const msg = await channel.messages.fetch(msgId).catch(() => null);
        if (msg) await msg.unpin().catch(() => {});
      } catch {
        // already unpinned
      }
    }
    this.pinnedMessageIds.delete(key);
  }

  private findActiveTaskKey(channelId: string): string | undefined {
    for (const [key, active] of this.taskActive) {
      if (!active) continue;
      if (key === 'notification') return key;
      const numericPart = key.startsWith('discord:') ? key.split(':')[1] : key;
      if (numericPart === channelId) return key;
    }
    return undefined;
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

  private async reactToOriginalMessage(key: string, emoji: string): Promise<void> {
    if (!this.client || !this.config.channels.discord.reactions) return;
    const orig = this.originalMessageIds.get(key);
    if (!orig) return;

    const channel = this.client.channels.cache.get(orig.channelId);
    if (!isSendable(channel)) return;

    try {
      const msg = await channel.messages.fetch(orig.messageId).catch(() => null);
      if (msg) await msg.react(emoji).catch(() => {});
    } catch {
      // message may have been deleted
    }
  }

  async reactError(targetId?: string): Promise<void> {
    const key = targetId || 'notification';
    await this.reactToOriginalMessage(key, '❌');
  }

  async reactSuccess(targetId?: string): Promise<void> {
    const key = targetId || 'notification';
    await this.reactToOriginalMessage(key, '✅');
  }

  async sendFeedbackRequest(feedbackId: string, boardName: string, cardTask: string, question: string, options?: string[]): Promise<string | null> {
    if (!this.client) return null;

    const admin = this.getAdminUser();
    if (!admin) return null;

    const content = `\uD83D\uDD14 **Feedback Required**\n\n**Board:** ${boardName}\n**Card:** ${cardTask}\n\n${question}`;

    const row = new ActionRowBuilder<ButtonBuilder>();
    if (options && options.length > 0) {
      for (const opt of options) {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`feedback:${feedbackId}:${opt}`)
            .setLabel(opt.length > 80 ? opt.slice(0, 77) + '...' : opt)
            .setStyle(ButtonStyle.Primary),
        );
      }
    }
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`feedback:${feedbackId}:__custom__`)
        .setLabel('Type custom response')
        .setStyle(ButtonStyle.Secondary),
    );

    try {
      const dm = await this.client.users.createDM(admin.id);
      await dm.send({ content, components: [row] });
    } catch {
      return null;
    }
    return null;
  }

  private getAdminUser(): { id: string } | null {
    if (this.config.channels.discord.admins.length === 0) return null;
    return { id: this.config.channels.discord.admins[0].id };
  }
}