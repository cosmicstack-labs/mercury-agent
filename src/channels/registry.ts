import type { Channel } from './base.js';
import type { ChannelMessage, ChannelType } from '../types/channel.js';
import { CLIChannel } from './cli.js';
import { TelegramChannel } from './telegram.js';
import { SignalChannel } from './signal.js';
import { DiscordChannel } from './discord.js';
import { SlackChannel } from './slack.js';
import type { MercuryConfig } from '../utils/config.js';
import { logger } from '../utils/logger.js';

/** The messaging channels Mercury runs itself (WhatsApp is a plugin). */
export type ExternalChannel = 'telegram' | 'signal' | 'discord' | 'slack';

export class ChannelRegistry {
  private channels: Map<ChannelType, Channel> = new Map();

  /**
   * @param opts.cliOnly — a foreground runtime beside a live daemon: the daemon
   *   owns Telegram/Signal/Discord/Slack (a second poller on the same token
   *   fights it — Telegram answers 409 to both), so only the terminal is wired.
   */
  constructor(config: MercuryConfig, opts: { cliOnly?: boolean } = {}) {
    this.register('cli', new CLIChannel(config.identity.name));
    if (opts.cliOnly) return;

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

  /** Whether config has what a messaging channel needs to start. */
  static configured(config: MercuryConfig, type: ExternalChannel): boolean {
    const c = config.channels;
    if (type === 'telegram') return c.telegram.enabled && !!c.telegram.botToken;
    if (type === 'signal') return c.signal.enabled && !!c.signal.phoneNumber;
    if (type === 'discord') return c.discord.enabled && !!c.discord.botToken;
    return c.slack.enabled && !!c.slack.botToken && !!c.slack.appToken;
  }

  private static create(config: MercuryConfig, type: ExternalChannel): Channel {
    if (type === 'telegram') return new TelegramChannel(config);
    if (type === 'signal') return new SignalChannel(config);
    if (type === 'discord') return new DiscordChannel(config);
    return new SlackChannel(config);
  }

  /**
   * Stop one messaging channel and, if config says it should run, start a
   * fresh one from the same live config: new tokens, turned on or off, all
   * without restarting Mercury. `wire` repeats the boot-time wiring on the
   * new instance (chat commands). Resolves with whether it came up.
   */
  async restart(type: ExternalChannel, config: MercuryConfig, wire?: (channel: Channel) => void): Promise<{ running: boolean; error?: string }> {
    const old = this.channels.get(type);
    if (old) {
      try { await old.stop(); } catch (err) { logger.warn({ channel: type, err }, 'Stopping the old channel failed'); }
      this.unregister(type, old);
    }
    if (!ChannelRegistry.configured(config, type)) return { running: false };
    const next = ChannelRegistry.create(config, type);
    this.register(type, next);
    try { wire?.(next); } catch (err) { logger.warn({ channel: type, err }, 'Wiring the restarted channel failed'); }
    try {
      await next.start();
    } catch (err) {
      return { running: false, error: err instanceof Error ? err.message : String(err) };
    }
    // Telegram and Discord log in in the background: give them a moment to come up.
    for (let i = 0; i < 40 && !next.isReady(); i++) await new Promise((r) => setTimeout(r, 200));
    return { running: next.isReady() };
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

  /** Remove a channel, only if it is still the one registered (plugin channels come and go). */
  unregister(type: ChannelType, channel: Channel): void {
    if (this.channels.get(type) !== channel) return;
    this.channels.delete(type);
    logger.info({ channel: type }, 'Channel unregistered');
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
    const whatsapp = this.channels.get('whatsapp');
    if (whatsapp?.isReady()) return whatsapp;
    const cli = this.channels.get('cli');
    if (cli?.isReady()) return cli;
    return [...this.channels.values()].find((c) => !c.noBroadcast);
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
