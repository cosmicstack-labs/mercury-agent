import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import type { ChannelMessage } from '../types/channel.js';
import { BaseChannel } from './base.js';
import { logger } from '../utils/logger.js';
import { renderMarkdown } from '../utils/markdown.js';
import { formatToolStep } from '../utils/tool-label.js';
import {
  ArrowSelectCancelledError,
  selectWithArrowKeys,
  type ArrowSelectOption,
} from '../utils/arrow-select.js';

const USER_PROMPT = '  You: ';

function agentName(name: string, suffix?: string): string {
  return chalk.cyan(`  ${name}:`) + (suffix ?? '');
}

export class CLIChannel extends BaseChannel {
  readonly type = 'cli' as const;
  private rl: readline.Interface | null = null;
  private agentName: string;
  private menuDepth = 0;
  private menuAbortController: AbortController | null = null;
  private outputInProgress = 0;
  private streamActive = false;
  private streamLines = 0;

  constructor(agentName: string = 'Mercury') {
    super();
    this.agentName = agentName;
  }

  setAgentName(name: string): void {
    this.agentName = name;
  }

  async start(): Promise<void> {
    this.createInterface();
    this.ready = true;
    logger.info('CLI channel started');
  }

  private createInterface(): void {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    this.rl.setPrompt(USER_PROMPT);

    this.rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        this.showPrompt();
        return;
      }

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
  }

  async stop(): Promise<void> {
    this.rl?.close();
    this.rl = null;
    this.ready = false;
  }

  async send(content: string, _targetId?: string, elapsedMs?: number): Promise<void> {
    this.closeActiveMenu();
    this.beginOutput();
    const timeStr = elapsedMs != null ? chalk.dim(` (${(elapsedMs / 1000).toFixed(1)}s)`) : '';

    const block = this.formatBlock(this.agentName, timeStr, content);
    for (const line of block) {
      console.log(line);
    }

    this.endOutput();
  }

  async sendFile(filePath: string, _targetId?: string): Promise<void> {
    this.closeActiveMenu();
    this.beginOutput();
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      console.log(chalk.red(`  File not found: ${filePath}`));
      this.endOutput();
      return;
    }
    const stat = fs.statSync(resolved);
    const sizeStr = stat.size > 1024 * 1024
      ? `${(stat.size / (1024 * 1024)).toFixed(1)}MB`
      : stat.size > 1024
        ? `${(stat.size / 1024).toFixed(1)}KB`
        : `${stat.size}B`;

    const block = this.formatBlock(this.agentName, chalk.dim(' (file)'), [
      chalk.dim(`path: ${resolved}`),
      chalk.dim(`size: ${sizeStr}`),
    ].join('\n'));
    for (const line of block) {
      console.log(line);
    }

    this.endOutput();
  }

  async sendToolFeedback(toolName: string, args: Record<string, any>): Promise<void> {
    const label = formatToolStep(toolName, args);
    if (this.streamActive) {
      this.streamLines += 2;
      process.stdout.write(chalk.dim(`\n  ${label}\n`));
    } else {
      console.log(chalk.dim(`  ${label}`));
    }
  }

  async stream(content: AsyncIterable<string>, _targetId?: string): Promise<string> {
    this.closeActiveMenu();
    this.beginOutput();
    this.streamActive = true;
    this.streamLines = 0;

    if (!process.stdout.isTTY) {
      process.stdout.write(chalk.cyan(`  ${this.agentName}: `));
      let full = '';
      for await (const chunk of content) {
        process.stdout.write(chunk);
        full += chunk;
      }
      this.streamActive = false;
      console.log('\n');
      this.endOutput();
      return full;
    }

    let full = '';
    for await (const chunk of content) {
      process.stdout.write(chunk);
      full += chunk;
    }

    this.streamActive = false;

    if (!full.trim()) {
      console.log('');
      this.endOutput();
      return full;
    }

    const termWidth = process.stdout.columns || 80;

    // count how many screen lines the raw text occupied
    let streamedScreenLines = 0;
    for (const line of full.split('\n')) {
      const visualLen = line.replace(/\x1b\[[0-9;]*m/g, '').length;
      streamedScreenLines += Math.max(1, Math.ceil(visualLen / termWidth));
    }

    // +1 trailing newline after the streamed text
    const totalRawLines = streamedScreenLines + this.streamLines + 1;

    // move up and erase every line we wrote
    process.stdout.write(`\x1b[${totalRawLines}A`);
    for (let i = 0; i < totalRawLines; i++) {
      process.stdout.write('\x1b[2K\x1b[1B');
    }
    process.stdout.write(`\x1b[${totalRawLines}A`);

    // print the formatted block
    const block = this.formatBlock(this.agentName, '', full);
    for (const line of block) {
      console.log(line);
    }

    this.endOutput();
    return full;
  }

  async typing(_targetId?: string): Promise<void> {
    process.stdout.write(chalk.dim(`  ${this.agentName} is responding...\r`));
  }

  showPrompt(): void {
    if (this.rl) {
      process.stdout.write('\x1b[2K\r');
      process.stdout.write(chalk.yellow(USER_PROMPT));
    }
  }

  private formatBlock(name: string, suffix: string, content: string): string[] {
    const header = agentName(name, suffix);
    const body = renderMarkdown(content)
      .split('\n')
      .map((line: string) => `  ${line}`)
      .join('\n');
    return ['', header, '', body, ''];
  }

  async withMenu<T>(runner: (select: (title: string, options: ArrowSelectOption[]) => Promise<string>) => Promise<T>): Promise<T | undefined> {
    this.menuDepth += 1;
    this.menuAbortController = new AbortController();
    this.suspendPrompt();

    try {
      return await runner((title, options) => selectWithArrowKeys(title, options, {
        signal: this.menuAbortController?.signal,
      }));
    } catch (error) {
      if (error instanceof ArrowSelectCancelledError) {
        return undefined;
      }
      throw error;
    } finally {
      this.menuDepth = Math.max(0, this.menuDepth - 1);
      if (this.menuDepth === 0) {
        this.menuAbortController = null;
      }
      if (this.menuDepth === 0) {
        this.resumePrompt();
        if (this.outputInProgress === 0) {
          this.showPrompt();
        }
      }
    }
  }

  private closeActiveMenu(): void {
    if (!this.menuAbortController?.signal.aborted) {
      this.menuAbortController?.abort();
    }
  }

  private beginOutput(): void {
    this.outputInProgress += 1;
  }

  private endOutput(): void {
    this.outputInProgress = Math.max(0, this.outputInProgress - 1);
    if (this.menuDepth === 0 && this.outputInProgress === 0) {
      this.showPrompt();
    }
  }

  private suspendPrompt(): void {
    if (!this.rl) return;
    process.stdout.write('\n');
    this.rl.close();
    this.rl = null;
  }

  private resumePrompt(): void {
    if (!this.ready || this.rl) return;
    this.createInterface();
  }

  async prompt(question: string): Promise<string> {
    return new Promise((resolve) => {
      this.rl?.question(question, (answer) => resolve(answer.trim()));
    });
  }

  async askPermission(prompt: string): Promise<string> {
    return new Promise((resolve) => {
      console.log('');
      console.log(chalk.yellow(`  ⚠ ${prompt}`));
      this.rl?.question(chalk.yellow('  > '), (answer) => {
        resolve(answer.trim());
      });
    });
  }

  async askToContinue(question: string, _targetId?: string): Promise<boolean> {
    return new Promise((resolve) => {
      console.log('');
      console.log(chalk.yellow(`  ⚠ ${question}`));
      this.rl?.question(chalk.yellow('  Continue? [y/N] '), (answer) => {
        const val = answer.trim().toLowerCase();
        resolve(val === 'y' || val === 'yes');
      });
    });
  }
}