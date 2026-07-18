import type { Channel } from './base.js';
import type { ChannelMessage, ChannelType } from '../types/channel.js';
import { CLIChannel } from './cli.js';
import { TelegramChannel } from './telegram.js';
import { SignalChannel } from './signal.js';
import { DiscordChannel } from './discord.js';
import { SlackChannel } from './slack.js';
import type { MercuryConfig } from '../utils/config.js';
import { logger } from '../utils/logger.js';

export class ChannelRegistry {
  private channels: Map<ChannelType, Channel> = new Map();

  constructor(config: MercuryConfig) {
    this.register('cli', new CLIChannel(config.identity.name));

    if (config.channels.telegram.enabled && config.channels.telegram.botToken) {
      this.register('telegram', new TelegramChannel(config));
    } else if (config.channels.telegram.botToken && !config.channels.telegram.enabled) {
      logger.warn('Telegram channel has a bot token but is disabled. Run `mercury telegram enable` to re-enable it.');
    } else if (config.channels.telegram.enabled && !config.channels.telegram.botToken) {
      logger.warn('Telegram channel is enabled but no bot token is configured. Run `mercury doctor`.');
    }

    if (config.channels.signal.enabled && config.channels.signal.phoneNumber) {
      this.register('signal', new SignalChannel(config));
    } else if (config.channels.signal.phoneNumber && !config.channels.signal.enabled) {
      logger.warn('Signal channel has a phone number but is disabled. Run `mercury doctor` to re-enable it.');
    } else if (config.channels.signal.enabled && !config.channels.signal.phoneNumber) {
      logger.warn('Signal channel is enabled but no phone number is configured. Run `mercury doctor`.');
    }

    if (config.channels.discord.enabled && config.channels.discord.botToken) {
      this.register('discord', new DiscordChannel(config));
    } else if (config.channels.discord.botToken && !config.channels.discord.enabled) {
      logger.warn('Discord channel has a bot token but is disabled. Run `mercury doctor` to re-enable it.');
    } else if (config.channels.discord.enabled && !config.channels.discord.botToken) {
      logger.warn('Discord channel is enabled but no bot token is configured. Run `mercury doctor`.');
    }

    if (config.channels.slack.enabled && config.channels.slack.botToken) {
      this.register('slack', new SlackChannel(config));
    } else if ((config.channels.slack.botToken || config.channels.slack.appToken) && !config.channels.slack.enabled) {
      logger.warn('Slack channel has credentials but is disabled. Run `mercury doctor` to re-enable it.');
    } else if (config.channels.slack.enabled && (!config.channels.slack.botToken || !config.channels.slack.appToken)) {
      logger.warn('Slack channel is enabled but bot/app token credentials are incomplete. Run `mercury doctor`.');
    }
  }

  getCliChannel(): CLIChannel | undefined {
    return this.channels.get('cli') as CLIChannel | undefined;
  }

  getDiscordChannel(): DiscordChannel | undefined {
    return this.channels.get('discord') as DiscordChannel | undefined;
  }

  getSlackChannel(): SlackChannel | undefined {
    return this.channels.get('slack') as SlackChannel | undefined;
  }

  register(type: ChannelType, channel: Channel): void {
    channel.onMessage((msg) => this.handleIncomingMessage(msg));
    this.channels.set(type, channel);
    logger.info({ channel: type }, 'Channel registered');
  }

  get(type: ChannelType): Channel | undefined {
    return this.channels.get(type);
  }

  getChannelForMessage(message: ChannelMessage): Channel | undefined {
    return this.channels.get(message.channelType);
  }

  async startAll(): Promise<void> {
    await Promise.all(
      [...this.channels.entries()].map(async ([type, channel]) => {
        try {
          await channel.start();
        } catch (err) {
          logger.error({ channel: type, err }, 'Failed to start channel');
        }
      })
    );
  }

  async stopAll(): Promise<void> {
    for (const [, channel] of this.channels) {
      await channel.stop();
    }
  }

  getActiveChannels(): ChannelType[] {
    return [...this.channels.entries()]
      .filter(([, ch]) => ch.isReady())
      .map(([type]) => type);
  }

  getNotificationChannel(): Channel | undefined {
    const signal = this.channels.get('signal');
    if (signal?.isReady()) return signal;
    const telegram = this.channels.get('telegram');
    if (telegram?.isReady()) return telegram;
    const discord = this.channels.get('discord');
    if (discord?.isReady()) return discord;
    const slack = this.channels.get('slack');
    if (slack?.isReady()) return slack;
    const cli = this.channels.get('cli');
    if (cli?.isReady()) return cli;
    return this.channels.values().next().value;
  }

  private incomingHandler?: (msg: ChannelMessage) => void;

  onIncomingMessage(handler: (msg: ChannelMessage) => void): void {
    this.incomingHandler = handler;
  }

  private handleIncomingMessage(msg: ChannelMessage): void {
    logger.debug({ from: msg.channelType, sender: msg.senderId }, 'Incoming message');
    this.incomingHandler?.(msg);
  }
}
