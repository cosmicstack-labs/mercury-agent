import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import type { ChannelMessage } from '../types/channel.js';
import { BaseChannel, type PermissionMode } from './base.js';
import { logger } from '../utils/logger.js';
import { renderMarkdown } from '../utils/markdown.js';
import { formatToolStep, formatToolResult } from '../utils/tool-label.js';
import {
  ArrowSelectCancelledError,
  selectWithArrowKeys,
  type ArrowSelectOption,
} from '../utils/arrow-select.js';

const USER_PROMPT = '  You: ';
const SPINNER_FRAMES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];

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
  private streamToolLines = 0;
  private turnHeaderPrinted = false;
  private stepCount = 0;
  private stepStartTime = 0;
  private spinnerFrame = 0;
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;
  private spinnerLine = '';

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
    this.turnHeaderPrinted = false;
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
      this.streamToolLines++;
      process.stdout.write(chalk.dim(`\n  ${label}\n`));
    } else {
      this.stopSpinner();
      if (!this.turnHeaderPrinted) {
        this.turnHeaderPrinted = true;
        console.log('');
        console.log(agentName(this.agentName, ''));
        console.log('');
      }
      this.stepCount += 1;
      this.stepStartTime = Date.now();
      const stepPrefix = chalk.dim(`  ${this.stepCount}.`);
      console.log(`${stepPrefix} ${chalk.dim(label)}`);
      this.startSpinner();
    }
  }

  sendStepDone(toolName: string, result: unknown): void {
    if (this.streamActive) {
      const summary = formatToolResult(toolName, result);
      if (summary) {
        process.stdout.write(chalk.dim(`  ${summary}\n`));
        this.streamToolLines++;
      }
      return;
    }
    this.stopSpinner();
    const elapsed = ((Date.now() - this.stepStartTime) / 1000).toFixed(1);
    const summary = formatToolResult(toolName, result);
    if (summary) {
      console.log(chalk.dim(`     ${summary} (${elapsed}s)`));
    } else {
      process.stdout.write(chalk.dim(`     ${elapsed}s\n`));
    }
  }

  private startSpinner(): void {
    if (!process.stdout.isTTY) return;
    this.spinnerFrame = 0;
    this.spinnerLine = '';
    this.spinnerTimer = setInterval(() => {
      const frame = SPINNER_FRAMES[this.spinnerFrame % SPINNER_FRAMES.length];
      const elapsed = ((Date.now() - this.stepStartTime) / 1000).toFixed(0);
      this.spinnerLine = chalk.dim(`     ${frame} Step ${this.stepCount} · ${elapsed}s`);
      process.stdout.write(`\x1b[2K\r${this.spinnerLine}`);
      this.spinnerFrame++;
    }, 80);
  }

  private stopSpinner(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
    if (this.spinnerLine) {
      process.stdout.write('\x1b[2K\r');
      this.spinnerLine = '';
    }
  }

  async stream(content: AsyncIterable<string>, _targetId?: string): Promise<string> {
    this.closeActiveMenu();
    this.beginOutput();
    this.streamActive = true;
    this.streamToolLines = 0;
    this.stepCount = 0;
    this.turnHeaderPrinted = false;

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

    const headerLines = ['', chalk.cyan(`  ${this.agentName}:`), ''];
    for (const line of headerLines) {
      console.log(line);
    }

    const indent = '  ';
    const cols = process.stdout.columns || 80;
    const contentCols = Math.max(1, cols - indent.length);
    let visualLines = headerLines.length;
    let pendingIndent = true;
    let lineLen = 0;

    let full = '';
    for await (const chunk of content) {
      full += chunk;
      for (let i = 0; i < chunk.length; i++) {
        const ch = chunk[i];
        if (ch === '\n') {
          visualLines += Math.max(1, Math.ceil((lineLen + indent.length) / cols));
          process.stdout.write('\n');
          lineLen = 0;
          pendingIndent = true;
        } else {
          if (pendingIndent) {
            process.stdout.write(indent);
            pendingIndent = false;
          }
          process.stdout.write(ch);
          lineLen++;
        }
      }
    }
    if (lineLen > 0) {
      visualLines += Math.max(1, Math.ceil((lineLen + indent.length) / cols));
      process.stdout.write('\n');
    } else {
      visualLines += 1;
    }
    this.streamActive = false;

    process.stdout.write(`\x1b[${visualLines}A`);
    process.stdout.write('\x1b[J');

    if (full.trim()) {
      const block = this.formatBlock(this.agentName, '', full);
      for (const line of block) {
        console.log(line);
      }
    }

    this.endOutput();
    return full;
  }

  async typing(_targetId?: string): Promise<void> {
    this.stopSpinner();
    if (process.stdout.isTTY) {
      process.stdout.write(chalk.dim(`  ${this.agentName} is thinking...\r`));
    }
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

  async askPermissionMode(): Promise<PermissionMode> {
    if (!process.stdout.isTTY) return 'ask-me';

    this.suspendPrompt();

    console.log('');
    console.log(chalk.bold('  Permission Mode'));
    console.log(chalk.dim('  Choose how Mercury handles risky actions this session.'));
    console.log('');

    const options: ArrowSelectOption[] = [
      { value: 'ask-me', label: 'Ask Me — confirm before file writes, shell commands, and scope changes' },
      { value: 'allow-all', label: 'Allow All — auto-approve everything (scopes, commands, loop continuation)' },
    ];

    try {
      const selected = await selectWithArrowKeys('Select permission mode:', options, {
        helperText: '↑↓ to move, Enter to select',
      });

      if (selected === 'allow-all') {
        console.log('');
        console.log(chalk.yellow('  ⚠ Allow All active for this session:'));
        console.log(chalk.dim('     • All directory scopes auto-approved'));
        console.log(chalk.dim('     • All shell commands auto-approved (except blocked)'));
        console.log(chalk.dim('     • Loop detection will auto-continue'));
        console.log(chalk.dim('     • Resets on restart'));
        console.log('');
      } else {
        console.log('');
        console.log(chalk.dim('  Confirm-before-act mode active.'));
        console.log('');
      }

      return selected as PermissionMode;
    } catch {
      return 'ask-me';
    } finally {
      this.resumePrompt();
    }
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