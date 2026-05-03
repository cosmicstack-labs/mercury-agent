import type { Channel } from './base.js';
import type { ChannelMessage, ChannelType } from '../types/channel.js';
import { CLIChannel } from './cli.js';
import { FeishuChannel } from './feishu.js';
import { TelegramChannel } from './telegram.js';
import type { MercuryConfig } from '../utils/config.js';
import { logger } from '../utils/logger.js';

export class ChannelRegistry {
  private channels: Map<ChannelType, Channel> = new Map();

  constructor(config: MercuryConfig) {
    this.register('cli', new CLIChannel(config.identity.name));

    if (config.channels.telegram.enabled && config.channels.telegram.botToken) {
      this.register('telegram', new TelegramChannel(config));
    }

    if (config.channels.feishu.enabled && config.channels.feishu.appId && config.channels.feishu.appSecret) {
      this.register('feishu', new FeishuChannel(config));
    }
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
    for (const [type, channel] of this.channels) {
      try {
        await channel.start();
      } catch (err) {
        logger.error({ channel: type, err }, 'Failed to start channel');
      }
    }
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
    const telegram = this.channels.get('telegram');
    if (telegram?.isReady()) return telegram;
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