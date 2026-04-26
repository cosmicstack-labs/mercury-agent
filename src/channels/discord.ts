import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  type Interaction,
  type ChatInputCommandInteraction,
  type SlashCommandSubcommandBuilder,
  type SlashCommandStringOption,
  MessageFlags,
} from 'discord.js';
import { BaseChannel } from './base.js';
import type { ChannelMessage } from '../types/channel.js';
import type { MercuryConfig } from '../utils/config.js';
import { logger } from '../utils/logger.js';

const DISCORD_MAX_CONTENT = 2000;

interface PendingInteraction {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  interaction: ChatInputCommandInteraction;
}

export class DiscordChannel extends BaseChannel {
  readonly type = 'discord' as const;
  private client: Client | null = null;
  private config: MercuryConfig;
  private pendingInteractions: Map<string, PendingInteraction> = new Map();
  private chatCommandContext?: import('../capabilities/registry.js').ChatCommandContext;

  constructor(config: MercuryConfig) {
    super();
    this.config = config;
  }

  setChatCommandContext(ctx: import('../capabilities/registry.js').ChatCommandContext): void {
    this.chatCommandContext = ctx;
  }

  async start(): Promise<void> {
    const dc = this.config.channels.discord;
    if (!dc || !dc.enabled || !dc.botToken) {
      logger.info('Discord channel disabled or missing token — skipping');
      return;
    }

    if (!dc.clientId) {
      logger.error('Discord: DISCORD_CLIENT_ID is required for slash command registration');
      return;
    }

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
      ],
    });

    this.client.once('ready', async () => {
      logger.info('Discord bot connected and ready');
      await this.registerCommands();
      this.ready = true;
    });

    this.client.on('interactionCreate', async (interaction: Interaction) => {
      try {
        await this.handleInteraction(interaction);
      } catch (err) {
        logger.error({ err }, 'Discord interaction error');
      }
    });

    this.client.on('error', (err: Error) => {
      logger.error({ err }, 'Discord client error');
    });

    try {
      await this.client.login(dc.botToken);
    } catch (err: any) {
      logger.error({ err: err?.message || err }, 'Discord login failed');
    }
  }

  async stop(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
    this.ready = false;
    logger.info('Discord bot stopped');
  }

  async send(content: string, targetId?: string, elapsedMs?: number): Promise<void> {
    if (!targetId || !this.client) return;

    const pending = this.pendingInteractions.get(targetId);
    if (pending) {
      const timeSuffix = elapsedMs != null ? `\n⏱ ${(elapsedMs / 1000).toFixed(1)}s` : '';
      const fullContent = content + timeSuffix;
      const chunks = this.splitForDiscord(fullContent);

      try {
        await pending.interaction.editReply(chunks[0] || '(empty response)');
        for (let i = 1; i < chunks.length; i++) {
          await pending.interaction.followUp({ content: chunks[i] });
        }
      } catch (err: any) {
        logger.warn({ err: err?.message }, 'Discord reply failed');
      }

      pending.resolve(content);
      this.pendingInteractions.delete(targetId);
    }
  }

  async sendFile(_filePath: string, _targetId?: string): Promise<void> {}

  async stream(content: AsyncIterable<string>, targetId?: string): Promise<string> {
    let full = '';
    for await (const chunk of content) {
      full += chunk;
    }
    await this.send(full, targetId);
    return full;
  }

  async typing(_targetId?: string): Promise<void> {}

  async askToContinue(_question: string, _targetId?: string): Promise<boolean> {
    return false;
  }

  private isAllowed(userId: string): boolean {
    const dc = this.config.channels.discord;
    if (!dc) return false;
    if (this.isAdmin(userId)) return true;
    if (dc.allowedUserIds.length === 0) return false;
    return dc.allowedUserIds.includes(userId);
  }

  private isAdmin(userId: string): boolean {
    const dc = this.config.channels.discord;
    if (!dc) return false;
    return dc.adminUserIds.includes(userId);
  }

  private splitForDiscord(text: string, maxLen = DISCORD_MAX_CONTENT): string[] {
    if (text.length <= maxLen) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining);
        break;
      }
      let splitAt = remaining.lastIndexOf('\n', maxLen);
      if (splitAt < maxLen * 0.3) splitAt = maxLen;
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt);
    }
    return chunks;
  }

  private async registerCommands(): Promise<void> {
    const dc = this.config.channels.discord;
    if (!dc || !this.client) return;

    const commands = [
      new SlashCommandBuilder()
        .setName('mercury')
        .setDescription('Mercury Agent commands')
        .addSubcommand((sub: SlashCommandSubcommandBuilder) =>
          sub
            .setName('ask')
            .setDescription('Send a prompt to Mercury')
            .addStringOption((opt: SlashCommandStringOption) =>
              opt.setName('prompt').setDescription('Your prompt').setRequired(true)
            )
        )
        .addSubcommand((sub: SlashCommandSubcommandBuilder) => sub.setName('status').setDescription('Show Mercury status'))
        .addSubcommand((sub: SlashCommandSubcommandBuilder) => sub.setName('help').setDescription('Show available commands'))
        .addSubcommand((sub: SlashCommandSubcommandBuilder) => sub.setName('budget').setDescription('Show token budget'))
        .addSubcommand((sub: SlashCommandSubcommandBuilder) => sub.setName('memory').setDescription('Show memory overview'))
        .addSubcommand((sub: SlashCommandSubcommandBuilder) =>
          sub.setName('permissions').setDescription('Show permission mode')
        ),
    ].map((c) => c.toJSON());

    const rest = new REST({ version: '10' }).setToken(dc.botToken);

    try {
      if (dc.useGlobalCommands) {
        await rest.put(Routes.applicationCommands(dc.clientId), { body: commands });
        logger.info('Discord: global commands registered');
      } else if (dc.guildId) {
        await rest.put(
          Routes.applicationGuildCommands(dc.clientId, dc.guildId),
          { body: commands }
        );
        logger.info('Discord: guild commands registered');
      } else {
        logger.warn('Discord: no GUILD_ID and global commands disabled — commands not registered');
      }
    } catch (err: any) {
      logger.error({ err: err?.message }, 'Discord command registration failed');
    }
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand()) return;

    const userId = interaction.user.id;
    if (!this.isAllowed(userId)) {
      await interaction.reply({
        content: 'You are not authorized to use this bot.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const dc = this.config.channels.discord;
    if (
      interaction.guildId &&
      dc?.allowedChannelIds?.length &&
      !dc.allowedChannelIds.includes(interaction.channelId ?? '')
    ) {
      await interaction.reply({
        content: 'This bot is not available in this channel.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!interaction.guildId && !dc?.allowDms) {
      await interaction.reply({
        content: 'DM access is disabled.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'ask') {
      await this.handleAsk(interaction);
      return;
    }

    if (subcommand === 'status') {
      const embed = new EmbedBuilder()
        .setTitle(`${this.config.identity.name} — Status`)
        .addFields(
          { name: 'Provider', value: this.config.providers.default, inline: true },
          { name: 'Budget', value: `${this.config.tokens.dailyBudget.toLocaleString()} tokens/day`, inline: true },
          { name: 'Telegram', value: this.config.channels.telegram.enabled ? 'enabled' : 'disabled', inline: true },
          { name: 'Web Panel', value: this.config.channels.webPanel.enabled ? 'enabled' : 'disabled', inline: true },
        )
        .setColor(0x58a6ff);
      await interaction.reply({ embeds: [embed] });
      return;
    }

    if (subcommand === 'help') {
      await interaction.reply({
        content: [
          '**Mercury Commands:**',
          '`/mercury ask <prompt>` — Send a prompt',
          '`/mercury status` — Show status',
          '`/mercury budget` — Show token budget',
          '`/mercury memory` — Show memory overview',
          '`/mercury permissions` — Show permission mode',
          '`/mercury help` — This message',
        ].join('\n'),
      });
      return;
    }

    if (subcommand === 'budget') {
      const ctx = this.chatCommandContext;
      const budget = ctx ? ctx.tokenBudget().getStatusText() : 'Budget info unavailable';
      await interaction.reply({ content: `**Token Budget:** ${budget}` });
      return;
    }

    if (subcommand === 'memory') {
      const ctx = this.chatCommandContext;
      if (!ctx) {
        await interaction.reply({ content: 'Memory info unavailable.' });
        return;
      }
      const summary = ctx.memorySummary();
      const lines = [
        `**Memory Overview**`,
        `Total: ${summary.total}`,
        `Learning: ${summary.learningPaused ? 'PAUSED' : 'ACTIVE'}`,
      ];
      await interaction.reply({ content: lines.join('\n') });
      return;
    }

    if (subcommand === 'permissions') {
      await interaction.reply({
        content: 'Permission mode is managed per-session via the Mercury CLI or Telegram.',
      });
      return;
    }
  }

  private async handleAsk(interaction: ChatInputCommandInteraction): Promise<void> {
    const prompt = interaction.options.getString('prompt', true);
    const channelId = `discord:${interaction.id}`;

    await interaction.deferReply();

    const msg: ChannelMessage = {
      id: interaction.id,
      channelId,
      channelType: 'discord',
      senderId: interaction.user.id,
      senderName: interaction.user.username,
      content: prompt,
      timestamp: Date.now(),
      metadata: { interactionId: interaction.id },
    };

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingInteractions.delete(channelId);
        interaction.editReply('(timeout — no response within 60s)').catch(() => {});
        resolve();
      }, 60_000);

      this.pendingInteractions.set(channelId, {
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: () => { clearTimeout(timer); resolve(); },
        interaction,
      });

      this.emit(msg);
    });
  }
}
