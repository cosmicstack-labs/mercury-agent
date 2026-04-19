import readline from 'node:readline';
import type { ChannelMessage } from '../types/channel.js';
import { BaseChannel } from './base.js';
import { logger } from '../utils/logger.js';

export class CLIChannel extends BaseChannel {
  readonly type = 'cli' as const;
  private rl: readline.Interface | null = null;

  async start(): Promise<void> {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    this.rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      const msg: ChannelMessage = {
        id: Date.now().toString(36),
        channelId: 'cli',
        channelType: 'cli',
        senderId: 'owner',
        content: trimmed,
        timestamp: Date.now(),
      };
      this.emit(msg);
    });

    this.ready = true;
    logger.info('CLI channel started');
  }

  async stop(): Promise<void> {
    this.rl?.close();
    this.rl = null;
    this.ready = false;
  }

  async send(content: string, _targetId?: string): Promise<void> {
    process.stdout.write(content + '\n');
  }

  async stream(content: AsyncIterable<string>, _targetId?: string): Promise<void> {
    for await (const chunk of content) {
      process.stdout.write(chunk);
    }
    process.stdout.write('\n');
  }

  async typing(_targetId?: string): Promise<void> {
    process.stdout.write('...');
  }

  async prompt(question: string): Promise<string> {
    return new Promise((resolve) => {
      this.rl?.question(question, (answer) => resolve(answer.trim()));
    });
  }
}