import { generateText, streamText, stepCountIs } from 'ai';
import type { ChannelMessage, ChannelType } from '../types/channel.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { Identity } from '../soul/identity.js';
import type { ShortTermMemory, LongTermMemory, EpisodicMemory } from '../memory/store.js';
import type { UserMemoryStore } from '../memory/user-memory.js';
import type { SharedMemoryStore } from '../memory/shared-memory-store.js';
import type { ChannelRegistry } from '../channels/registry.js';
import type { MercuryConfig } from '../utils/config.js';
import type { TokenBudget } from '../utils/tokens.js';
import type { CapabilityRegistry } from '../capabilities/registry.js';
import type { ScheduledTaskManifest } from './scheduler.js';
import { DeepSeekProvider } from '../providers/deepseek.js';
import { Lifecycle } from './lifecycle.js';
import { Scheduler } from './scheduler.js';
import { logger } from '../utils/logger.js';
import { CLIChannel } from '../channels/cli.js';
import { TelegramChannel } from '../channels/telegram.js';
import { formatToolStep } from '../utils/tool-label.js';
import type { ArrowSelectOption } from '../utils/arrow-select.js';
import {
  approveTelegramPendingRequest,
  approveTelegramPendingRequestByPairingCode,
  clearTelegramAccess,
  demoteTelegramAdmin,
  getTelegramAccessSummary,
  getTelegramApprovedUsers,
  getTelegramPendingRequests,
  promoteTelegramUserToAdmin,
  rejectTelegramPendingRequest,
  removeTelegramUser,
  saveConfig,
} from '../utils/config.js';

class ToolCallLoopDetector {
  private recentCalls: Array<{ tool: string; params: string; failed: boolean }> = [];
  private totalCalls = 0;
  private hardAborted = false;
  private recentStepTexts: Array<string> = [];
  private consecutiveNoActionSteps = 0;

  private static readonly ABSOLUTE_MAX = 25;
  private static readonly FAILED_ABSOLUTE_MAX = 12;
  private static readonly NO_ACTION_MAX = 5;

  private static readonly HIGH_TOLERANCE_TOOLS = new Set([
    'fetch_url',
    'read_file',
    'list_dir',
    'web_search',
    'github_api',
  ]);

  private static readonly IDENTICAL_THRESHOLD = 3;
  private static readonly SIMILAR_THRESHOLD = 4;
  private static readonly TEXT_REPEAT_THRESHOLD = 3;
  private static readonly MAX_STEP_TEXTS = 12;

  private static getSameToolThreshold(toolName: string, failingCount: number): number {
    const baseHigh = 5;
    const baseNormal = 3;
    const isHigh = ToolCallLoopDetector.HIGH_TOLERANCE_TOOLS.has(toolName);
    let threshold = isHigh ? baseHigh : baseNormal;
    if (failingCount >= 3) {
      threshold = Math.min(threshold, isHigh ? 3 : 2);
    }
    return threshold;
  }

  record(toolName: string, params: Record<string, any>, failed: boolean = false): void {
    const paramsKey = JSON.stringify(params).slice(0, 200);
    this.recentCalls.push({ tool: toolName, params: paramsKey, failed });
    this.totalCalls++;
    this.consecutiveNoActionSteps = 0;
    if (this.recentCalls.length > 30) {
      this.recentCalls.shift();
    }
  }

  recordNoActionResult(): boolean {
    this.consecutiveNoActionSteps++;
    return this.consecutiveNoActionSteps >= ToolCallLoopDetector.NO_ACTION_MAX;
  }

  recordStepText(text: string): void {
    if (!text || text.length < 10) return;
    const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!normalized) return;
    this.recentStepTexts.push(normalized);
    if (this.recentStepTexts.length > ToolCallLoopDetector.MAX_STEP_TEXTS) {
      this.recentStepTexts.shift();
    }
  }

  detectAbsoluteLimit(): boolean {
    if (this.totalCalls >= ToolCallLoopDetector.ABSOLUTE_MAX) return true;
    const failCount = this.recentCalls.filter(c => c.failed).length;
    if (failCount >= ToolCallLoopDetector.FAILED_ABSOLUTE_MAX) return true;
    return false;
  }

  detectIdentical(): { tool: string; count: number; message: string } | null {
    if (this.recentCalls.length < 3) return null;

    const last = this.recentCalls[this.recentCalls.length - 1];

    let identicalCount = 0;
    for (let i = this.recentCalls.length - 1; i >= 0; i--) {
      if (this.recentCalls[i].tool === last.tool && this.recentCalls[i].params === last.params) {
        identicalCount++;
      } else {
        break;
      }
    }

    if (identicalCount >= ToolCallLoopDetector.IDENTICAL_THRESHOLD) {
      this.hardAborted = true;
      return {
        tool: last.tool,
        count: identicalCount,
        message: `[SYSTEM] You called "${last.tool}" ${identicalCount} times with identical parameters and got the same result. This is a hard loop — stop immediately.`,
      };
    }

    return null;
  }

  detectSimilarLoop(): { tool: string; count: number; message: string } | null {
    if (this.recentCalls.length < 4) return null;

    const last = this.recentCalls[this.recentCalls.length - 1];
    let similarCount = 0;

    for (let i = this.recentCalls.length - 1; i >= 0; i--) {
      const call = this.recentCalls[i];
      if (call.tool !== last.tool) break;
      if (call.failed || last.failed) {
        similarCount++;
      } else {
        break;
      }
    }

    if (similarCount >= ToolCallLoopDetector.SIMILAR_THRESHOLD) {
      this.hardAborted = true;
      return {
        tool: last.tool,
        count: similarCount,
        message: `[SYSTEM] You called "${last.tool}" ${similarCount} times with different params but all are failing. This is a failing loop — stop immediately. Tell the user you cannot complete this task.`,
      };
    }

    return null;
  }

  detectTextRepetition(): { pattern: string; count: number } | null {
    if (this.recentStepTexts.length < ToolCallLoopDetector.TEXT_REPEAT_THRESHOLD) return null;

    const texts = this.recentStepTexts;
    const last = texts[texts.length - 1];

    let repeatCount = 0;
    for (let i = texts.length - 1; i >= 0; i--) {
      const similarity = this.textSimilarity(last, texts[i]);
      if (similarity >= 0.7) {
        repeatCount++;
      } else {
        break;
      }
    }

    if (repeatCount >= ToolCallLoopDetector.TEXT_REPEAT_THRESHOLD) {
      return {
        pattern: last.slice(0, 60),
        count: repeatCount,
      };
    }

    return null;
  }

  private textSimilarity(a: string, b: string): number {
    if (a === b) return 1;
    if (!a || !b) return 0;

    const setA = new Set(a.split(' '));
    const setB = new Set(b.split(' '));
    const intersection = [...setA].filter(w => setB.has(w)).length;
    const union = new Set([...setA, ...setB]).size;
    return union === 0 ? 0 : intersection / union;
  }

  detectSameTool(): { tool: string; count: number } | null {
    if (this.recentCalls.length < 3) return null;

    const last = this.recentCalls[this.recentCalls.length - 1];

    let consecutiveCount = 0;
    let failingConsecutive = 0;
    for (let i = this.recentCalls.length - 1; i >= 0; i--) {
      if (this.recentCalls[i].tool === last.tool) {
        consecutiveCount++;
        if (this.recentCalls[i].failed) failingConsecutive++;
      } else {
        break;
      }
    }

    const threshold = ToolCallLoopDetector.getSameToolThreshold(last.tool, failingConsecutive);
    if (consecutiveCount >= threshold) {
      return { tool: last.tool, count: consecutiveCount };
    }

    if (this.recentCalls.length >= 6) {
      const lastN = this.recentCalls.slice(-6);
      const toolCounts: Record<string, number> = {};
      for (const call of lastN) {
        toolCounts[call.tool] = (toolCounts[call.tool] || 0) + 1;
      }
      for (const [tool, count] of Object.entries(toolCounts)) {
        if (count >= 5) {
          return { tool, count };
        }
      }
    }

    return null;
  }

  isHardAborted(): boolean {
    return this.hardAborted;
  }

  reset(): void {
    this.recentCalls = [];
    this.totalCalls = 0;
    this.hardAborted = false;
    this.recentStepTexts = [];
    this.consecutiveNoActionSteps = 0;
  }
}

const MAX_STEPS = 10;

export class Agent {
  readonly lifecycle: Lifecycle;
  readonly scheduler: Scheduler;
  readonly capabilities: CapabilityRegistry;
  private running = false;
  private messageQueue: ChannelMessage[] = [];
  private processing = false;
  private telegramStreaming: boolean;

  constructor(
    private config: MercuryConfig,
    private providers: ProviderRegistry,
    private identity: Identity,
    private shortTerm: ShortTermMemory,
    private longTerm: LongTermMemory,
    private episodic: EpisodicMemory,
    private userMemory: UserMemoryStore | null,
    private sharedMemory: SharedMemoryStore | null,
    private channels: ChannelRegistry,
    private tokenBudget: TokenBudget,
    capabilities: CapabilityRegistry,
    scheduler: Scheduler,
  ) {
    this.lifecycle = new Lifecycle();
    this.scheduler = scheduler;
    this.capabilities = capabilities;
    this.telegramStreaming = config.channels.telegram.streaming ?? true;

    this.scheduler.setOnScheduledTask(async (manifest) => this.handleScheduledTask(manifest));

    this.channels.onIncomingMessage((msg) => this.enqueueMessage(msg));

    this.scheduler.onHeartbeat(async () => {
      await this.heartbeat();
    });
  }

  private enqueueMessage(msg: ChannelMessage): void {
    logger.info({ from: msg.channelType, content: msg.content.slice(0, 50) }, 'Message enqueued');
    this.messageQueue.push(msg);
    this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    if (this.messageQueue.length === 0) return;
    if (!this.lifecycle.is('idle')) return;

    this.processing = true;

    while (this.messageQueue.length > 0) {
      const msg = this.messageQueue.shift()!;
      try {
        await this.handleMessage(msg);
      } catch (err) {
        logger.error({ err, msg: msg.content.slice(0, 50) }, 'Failed to handle message');
      }
    }

    this.processing = false;
  }

  async birth(): Promise<void> {
    this.lifecycle.transition('birthing');
    logger.info({ name: this.config.identity.name }, 'Mercury is being born...');
    this.lifecycle.transition('onboarding');
  }

  async wake(): Promise<void> {
    this.lifecycle.transition('onboarding');
    this.lifecycle.transition('idle');
    this.scheduler.restorePersistedTasks();
    this.scheduler.startHeartbeat();
    await this.channels.startAll();
    this.running = true;

    const activeChannels = this.channels.getActiveChannels();
    const toolNames = this.capabilities.getToolNames();
    logger.info({ channels: activeChannels, tools: toolNames }, 'Mercury is awake');
  }

  async sleep(): Promise<void> {
    this.running = false;
    this.scheduler.stopAll();
    await this.channels.stopAll();
    this.lifecycle.transition('sleeping');
    logger.info('Mercury is sleeping');
  }

  private async handleMessage(msg: ChannelMessage): Promise<void> {
    this.lifecycle.transition('thinking');
    const startTime = Date.now();

      const isInternal = msg.channelType === 'internal';
      const isScheduled = msg.senderId === 'system' && msg.channelType !== 'internal';
      if (isInternal || isScheduled) {
        this.capabilities.permissions.setAutoApproveAll(true);
        this.capabilities.permissions.addTempScope('/', true, true);
      }

    try {
      const trimmed = msg.content.trim();
      if (trimmed.startsWith('/budget')) {
        const subcommand = trimmed.slice('/budget'.length).trim();
        await this.handleBudgetCommand(subcommand || 'status', msg.channelType, msg.channelId);
        this.lifecycle.transition('idle');
        return;
      }

      if (trimmed === '/budget_override') {
        await this.handleBudgetCommand('override', msg.channelType, msg.channelId);
        this.lifecycle.transition('idle');
        return;
      }
      if (trimmed === '/budget_reset') {
        await this.handleBudgetCommand('reset', msg.channelType, msg.channelId);
        this.lifecycle.transition('idle');
        return;
      }
      if (trimmed.startsWith('/budget_set')) {
        const args = trimmed.slice('/budget_set'.length).trim();
        await this.handleBudgetCommand('set ' + args, msg.channelType, msg.channelId);
        this.lifecycle.transition('idle');
        return;
      }
      if (trimmed.startsWith('/stream')) {
        const sub = trimmed.slice('/stream'.length).trim().toLowerCase();
        if (sub === 'off') {
          this.telegramStreaming = false;
        } else if (sub === 'on') {
          this.telegramStreaming = true;
        } else {
          this.telegramStreaming = !this.telegramStreaming;
        }
        const ch = this.channels.get(msg.channelType as any);
        if (ch) await ch.send(
          this.telegramStreaming
            ? 'Telegram streaming enabled. Responses will appear progressively.'
            : 'Telegram streaming disabled. Responses will arrive as a single message.',
          msg.channelId,
        );
        this.lifecycle.transition('idle');
        return;
      }

      if (await this.handleChatCommand(trimmed, msg.channelType, msg.channelId)) {
        this.lifecycle.transition('idle');
        return;
      }

      if (this.tokenBudget.isOverBudget()) {
        const channel = this.channels.getChannelForMessage(msg);
        if (channel && msg.channelType !== 'internal') {
          if (msg.channelType === 'cli') {
            if (['1', '2', '3', '4'].includes(trimmed)) {
              await this.handleBudgetCommand(trimmed, msg.channelType, msg.channelId);
              this.lifecycle.transition('idle');
              return;
            }
            await this.handleBudgetOverrideCLI(channel, msg);
          } else {
            await channel.send(
              `I've exceeded my daily token budget (${this.tokenBudget.getStatusText()}).\n\nYou can override this:\n• /budget override — allow one more request\n• /budget reset — reset usage to zero\n• /budget set <number> — change daily budget`,
              msg.channelId,
            );
          }
        }
        this.lifecycle.transition('idle');
        return;
      }

      const systemPrompt = this.buildSystemPrompt();
      const recentMemory = this.shortTerm.getRecent(msg.channelId, 10);

      const messages: any[] = [];

      const recentSteps = this.shortTerm.getRecent(msg.channelId, 6);
      let loopWarning: string | null = null;
      if (recentSteps.length >= 3) {
        const toolCallPattern = /\[Using: (.+?)\]/g;
        const toolCalls: string[] = [];
        for (const m of recentSteps) {
          if (m.role === 'assistant') {
            let match;
            while ((match = toolCallPattern.exec(m.content)) !== null) {
              toolCalls.push(match[1]);
            }
          }
        }
        if (toolCalls.length >= 3) {
          const last3 = toolCalls.slice(-3);
          if (last3[0] === last3[1] && last3[1] === last3[2]) {
            loopWarning = `[SYSTEM WARNING] You have called ${last3[0]} 3+ times in a row with the same result. Stop repeating this call. Try a different approach — if you're failing on permissions, try a different path. If you're failing on git push auth, use github_api with PUT /repos/{owner}/{repo}/contents/{path} to push files directly through the API.`;
          }
        }

        if (!loopWarning) {
          const assistantMessages = recentSteps.filter(m => m.role === 'assistant' && m.content.length > 20);
          if (assistantMessages.length >= 3) {
            const last3 = assistantMessages.slice(-3);
            const normalizeText = (t: string) => t.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim().slice(0, 150);
            const normalized = last3.map(m => normalizeText(m.content));
            const words0 = new Set(normalized[0].split(' '));
            const overlap01 = normalized[0] && normalized[1] ? [...words0].filter(w => new Set(normalized[1].split(' ')).has(w)).length / Math.max(words0.size, 1) : 0;
            const overlap12 = normalized[1] && normalized[2] ? [...new Set(normalized[1].split(' '))].filter(w => new Set(normalized[2].split(' ')).has(w)).length / Math.max(new Set(normalized[1].split(' ')).size, 1) : 0;
            if (overlap01 > 0.75 && overlap12 > 0.75) {
              loopWarning = `[SYSTEM WARNING] Your last 3 responses are nearly identical. You are stuck in a text repetition loop. Stop immediately and give a completely different response. If you cannot complete the task, tell the user clearly why.`;
            }
          }
        }
      }

      if (loopWarning) {
        messages.push({ role: 'user', content: loopWarning });
        messages.push({ role: 'assistant', content: 'Acknowledged. I will stop repeating and respond differently, or clearly state if the task cannot be completed.' });
      }

      if (this.userMemory) {
        const memoryContext = this.userMemory.retrieveRelevant(msg.content, { maxRecords: 5, maxChars: 900 });
        if (memoryContext.context) {
          messages.push({
            role: 'user',
            content: memoryContext.context,
          });
          messages.push({ role: 'assistant', content: 'Noted. I\'ll keep this in mind.' });
        }
      } else {
        const relevantFacts = this.longTerm.search(msg.content, 3);
        if (relevantFacts.length > 0) {
          messages.push({
            role: 'user',
            content: 'Relevant facts from memory:\n' + relevantFacts.map(f => `- ${f.fact}`).join('\n'),
          });
          messages.push({ role: 'assistant', content: 'Noted. I\'ll use these facts.' });
        }
      }

      if (recentMemory.length > 0) {
        for (const m of recentMemory) {
          messages.push({
            role: m.role === 'user' ? 'user' : 'assistant',
            content: m.content,
          });
        }
      }

      messages.push({ role: 'user', content: msg.content });

      this.lifecycle.transition('responding');

      const channel = this.channels.getChannelForMessage(msg);
      if (channel) {
        await channel.typing(msg.channelId).catch(() => {});
      }

      this.capabilities.setChannelContext(msg.channelId, msg.channelType);
      this.capabilities.permissions.setCurrentChannelType(msg.channelType);

      const fallbackIterator = this.providers.getFallbackIterator();
      let result: any = null;
      let usedProvider: { name: string; model: string } | null = null;
      let lastError: any = null;
      let streamedText = '';
      const loopDetector = new ToolCallLoopDetector();
      const loopAbortController = new AbortController();
      let loopWarningSent = false;

      const canStream = msg.channelType === 'cli' || (msg.channelType === 'telegram' && this.telegramStreaming);

      const tgChannel = this.channels.get('telegram');
      if (msg.channelType === 'telegram' && tgChannel) {
        (tgChannel as TelegramChannel).resetStepCounter(msg.channelId);
      }

      for (const provider of fallbackIterator) {
        try {
          const deepseekProviderOptions = provider instanceof DeepSeekProvider && provider.isReasoner
            ? { deepseek: { thinking: { type: 'enabled' as const } } }
            : undefined;

          logger.info({ provider: provider.name, model: provider.getModel(), steps: MAX_STEPS, stream: canStream }, 'Generating agentic response');

          if (canStream && channel) {
            const streamResult = streamText({
              model: provider.getModelInstance(),
              system: systemPrompt,
              messages,
              tools: this.capabilities.getTools(),
              stopWhen: stepCountIs(MAX_STEPS),
              abortSignal: loopAbortController.signal,
              ...(deepseekProviderOptions ? { providerOptions: deepseekProviderOptions } : {}),
              onStepFinish: async ({ toolCalls, toolResults }) => {
                if (toolCalls && toolResults && toolCalls.length > 0) {
                  const names = toolCalls.map((tc: any) => tc.toolName).join(', ');
                  logger.info({ tools: names }, 'Tool call step');
                  for (let i = 0; i < toolCalls.length; i++) {
                    const tc = toolCalls[i];
                    const tr = toolResults[i] as any;
                    const resultStr = typeof tr?.result === 'string' ? tr.result : JSON.stringify(tr?.result ?? '');
                    const failed = resultStr.length < 5000 && (
                      resultStr.startsWith('Error:') ||
                      resultStr.startsWith('⚠') ||
                      resultStr.includes('exited with code') ||
                      resultStr.includes('Command failed') ||
                      resultStr.startsWith('Command exited with code')
                    );
                    loopDetector.record(tc.toolName, tc.input as Record<string, any>, failed);
                  }
                  if (loopDetector.detectAbsoluteLimit()) {
                    logger.warn('Absolute tool call limit reached — aborting');
                    if (channel && msg.channelType !== 'internal') {
                      await channel.send('⚠ Tool call limit reached (25 calls). Stopping to prevent runaway loop.', msg.channelId).catch(() => {});
                    }
                    loopAbortController.abort();
                    return;
                  }
                  if (toolCalls.some((tc: any) => tc.toolName === 'use_skill')) {
                    loopDetector.reset();
                  }
                  const hardLoop = loopDetector.detectIdentical();
                  if (hardLoop) {
                    logger.warn({ tool: hardLoop.tool, count: hardLoop.count }, 'Hard loop detected — aborting');
                    if (!loopWarningSent && channel && msg.channelType !== 'internal') {
                      loopWarningSent = true;
                      await channel.send(`⚠ Repeated call detected — ${hardLoop.tool} called ${hardLoop.count}x with same params. Stopping.`, msg.channelId).catch(() => {});
                    }
                    loopAbortController.abort();
                    return;
                  }
                  const similarLoop = loopDetector.detectSimilarLoop();
                  if (similarLoop) {
                    logger.warn({ tool: similarLoop.tool, count: similarLoop.count }, 'Failing loop detected — aborting');
                    if (!loopWarningSent && channel && msg.channelType !== 'internal') {
                      loopWarningSent = true;
                      await channel.send(`⚠ Failing loop detected — ${similarLoop.tool} called ${similarLoop.count}x, all failing. Stopping.`, msg.channelId).catch(() => {});
                    }
                    loopAbortController.abort();
                    return;
                  }
                  const softLoop = loopDetector.detectSameTool();
                  if (softLoop && !loopWarningSent && channel && msg.channelType !== 'internal') {
                    if (this.capabilities.permissions.isAutoApproveAll()) {
                      loopDetector.reset();
                      loopWarningSent = false;
                    } else {
                      loopWarningSent = true;
                      const shouldContinue = await channel.askToContinue(
                        `${softLoop.tool} has been called ${softLoop.count}x in a row. This might be a loop.`,
                        msg.channelId,
                      ).catch(() => false);
                      if (shouldContinue) {
                        loopDetector.reset();
                        loopWarningSent = false;
                      } else {
                        loopAbortController.abort();
                      }
                    }
                  }
                  if (channel && msg.channelType !== 'internal') {
                    if (channel instanceof CLIChannel) {
                      for (const tc of toolCalls) {
                        await (channel as CLIChannel).sendToolFeedback(tc.toolName, tc.input as Record<string, any>).catch(() => {});
                      }
                      if (toolResults) {
                        for (let i = 0; i < toolResults.length; i++) {
                          const tr = toolResults[i] as any;
                          const tcName = toolCalls[i]?.toolName as string | undefined;
                          if (tcName) {
                            (channel as CLIChannel).sendStepDone(tcName, tr.result ?? tr);
                          }
                        }
                      }
                    } else if (channel instanceof TelegramChannel) {
                      const tgCh = channel as TelegramChannel;
                      for (const tc of toolCalls) {
                        await tgCh.sendToolFeedback(tc.toolName, tc.input as Record<string, any>, msg.channelId).catch(() => {});
                      }
                      if (toolResults) {
                        for (let i = 0; i < toolResults.length; i++) {
                          const tr = toolResults[i] as any;
                          const tcName = toolCalls[i]?.toolName as string | undefined;
                          if (tcName) {
                            await tgCh.sendStepDone(tcName, tr.result ?? tr, msg.channelId).catch(() => {});
                          }
                        }
                      }
                    } else {
                      await channel.send(`  [Using: ${names}]`, msg.channelId).catch(() => {});
                    }
                  }
                } else if (toolResults === undefined || (toolCalls === undefined)) {
                  const stepText = (toolResults as any)?.text ?? '';
                  if (stepText) {
                    loopDetector.recordStepText(String(stepText));
                  }
                  const noActionLoop = loopDetector.recordNoActionResult();
                  if (noActionLoop) {
                    logger.warn('Reasoning loop detected — model keeps thinking without acting, aborting');
                    if (!loopWarningSent && channel && msg.channelType !== 'internal') {
                      loopWarningSent = true;
                      await channel.send('⚠ I\'m stuck in a reasoning loop (thinking without taking action). Stopping.', msg.channelId).catch(() => {});
                    }
                    loopAbortController.abort();
                    return;
                  }
                  const textRepeat = loopDetector.detectTextRepetition();
                  if (textRepeat) {
                    logger.warn({ pattern: textRepeat.pattern, count: textRepeat.count }, 'Text repetition loop detected — aborting');
                    if (!loopWarningSent && channel && msg.channelType !== 'internal') {
                      loopWarningSent = true;
                      await channel.send('⚠ I keep generating the same response. Stopping to prevent repetition.', msg.channelId).catch(() => {});
                    }
                    loopAbortController.abort();
                  }
                }
              },
            });

            let fullText: string;

            if (msg.channelType === 'telegram') {
              const tgChannel = this.channels.get('telegram');
              if (tgChannel && 'sendStreamToChat' in tgChannel) {
                const chatId = msg.channelId.startsWith('telegram:')
                  ? Number(msg.channelId.split(':')[1])
                  : Number(msg.channelId);
                if (!isNaN(chatId)) {
                  fullText = await (tgChannel as any).sendStreamToChat(chatId, streamResult.textStream);
                } else {
                  fullText = await channel.stream(streamResult.textStream, msg.channelId);
                }
              } else {
                fullText = await channel.stream(streamResult.textStream, msg.channelId);
              }
            } else {
              fullText = await channel.stream(streamResult.textStream, msg.channelId);
            }

            const [usage] = await Promise.all([
              streamResult.usage,
            ]);

            const streamReasoning = await streamResult.reasoning;
            result = { text: fullText, usage, reasoning: streamReasoning };
            streamedText = fullText;
            loopDetector.recordStepText(fullText);
          } else {
            result = await generateText({
              model: provider.getModelInstance(),
              system: systemPrompt,
              messages,
              tools: this.capabilities.getTools(),
              stopWhen: stepCountIs(MAX_STEPS),
              abortSignal: loopAbortController.signal,
              ...(deepseekProviderOptions ? { providerOptions: deepseekProviderOptions } : {}),
              onStepFinish: async ({ toolCalls, toolResults }) => {
                if (toolCalls && toolResults && toolCalls.length > 0) {
                  const names = toolCalls.map((tc: any) => tc.toolName).join(', ');
                  logger.info({ tools: names }, 'Tool call step');
                  for (let i = 0; i < toolCalls.length; i++) {
                    const tc = toolCalls[i];
                    const tr = toolResults[i] as any;
                    const resultStr = typeof tr?.result === 'string' ? tr.result : JSON.stringify(tr?.result ?? '');
                    const failed = resultStr.length < 5000 && (
                      resultStr.startsWith('Error:') ||
                      resultStr.startsWith('⚠') ||
                      resultStr.includes('exited with code') ||
                      resultStr.includes('Command failed') ||
                      resultStr.startsWith('Command exited with code')
                    );
                    loopDetector.record(tc.toolName, tc.input as Record<string, any>, failed);
                  }
                  if (loopDetector.detectAbsoluteLimit()) {
                    logger.warn('Absolute tool call limit reached — aborting');
                    if (channel && msg.channelType !== 'internal') {
                      await channel.send('⚠ Tool call limit reached (25 calls). Stopping to prevent runaway loop.', msg.channelId).catch(() => {});
                    }
                    loopAbortController.abort();
                    return;
                  }
                  if (toolCalls.some((tc: any) => tc.toolName === 'use_skill')) {
                    loopDetector.reset();
                  }
                  const hardLoop = loopDetector.detectIdentical();
                  if (hardLoop) {
                    logger.warn({ tool: hardLoop.tool, count: hardLoop.count }, 'Hard loop detected — aborting');
                    if (!loopWarningSent && channel && msg.channelType !== 'internal') {
                      loopWarningSent = true;
                      await channel.send(`⚠ Repeated call detected — ${hardLoop.tool} called ${hardLoop.count}x with same params. Stopping.`, msg.channelId).catch(() => {});
                    }
                    loopAbortController.abort();
                    return;
                  }
                  const similarLoop = loopDetector.detectSimilarLoop();
                  if (similarLoop) {
                    logger.warn({ tool: similarLoop.tool, count: similarLoop.count }, 'Failing loop detected — aborting');
                    if (!loopWarningSent && channel && msg.channelType !== 'internal') {
                      loopWarningSent = true;
                      await channel.send(`⚠ Failing loop detected — ${similarLoop.tool} called ${similarLoop.count}x, all failing. Stopping.`, msg.channelId).catch(() => {});
                    }
                    loopAbortController.abort();
                    return;
                  }
                  const softLoop = loopDetector.detectSameTool();
                  if (softLoop && !loopWarningSent && channel && msg.channelType !== 'internal') {
                    if (this.capabilities.permissions.isAutoApproveAll()) {
                      loopDetector.reset();
                      loopWarningSent = false;
                    } else {
                      loopWarningSent = true;
                      const shouldContinue = await channel.askToContinue(
                        `${softLoop.tool} has been called ${softLoop.count}x in a row. This might be a loop.`,
                        msg.channelId,
                      ).catch(() => false);
                      if (shouldContinue) {
                        loopDetector.reset();
                        loopWarningSent = false;
                      } else {
                        loopAbortController.abort();
                      }
                    }
                  }
                  if (channel && msg.channelType !== 'internal') {
                    if (channel instanceof CLIChannel) {
                      for (const tc of toolCalls) {
                        await (channel as CLIChannel).sendToolFeedback(tc.toolName, tc.input as Record<string, any>).catch(() => {});
                      }
                      if (toolResults) {
                        for (let i = 0; i < toolResults.length; i++) {
                          const tr = toolResults[i] as any;
                          const tcName = toolCalls[i]?.toolName as string | undefined;
                          if (tcName) {
                            (channel as CLIChannel).sendStepDone(tcName, tr.result ?? tr);
                          }
                        }
                      }
                    } else if (channel instanceof TelegramChannel) {
                      const tgCh = channel as TelegramChannel;
                      for (const tc of toolCalls) {
                        await tgCh.sendToolFeedback(tc.toolName, tc.input as Record<string, any>, msg.channelId).catch(() => {});
                      }
                      if (toolResults) {
                        for (let i = 0; i < toolResults.length; i++) {
                          const tr = toolResults[i] as any;
                          const tcName = toolCalls[i]?.toolName as string | undefined;
                          if (tcName) {
                            await tgCh.sendStepDone(tcName, tr.result ?? tr, msg.channelId).catch(() => {});
                          }
                        }
                      }
                    } else {
                      await channel.send(`  [Using: ${names}]`, msg.channelId).catch(() => {});
                    }
                  }
                } else if (toolResults === undefined || (toolCalls === undefined)) {
                  const stepText = (toolResults as any)?.text ?? '';
                  if (stepText) {
                    loopDetector.recordStepText(String(stepText));
                  }
                  const noActionLoop = loopDetector.recordNoActionResult();
                  if (noActionLoop) {
                    logger.warn('Reasoning loop detected — model keeps thinking without acting, aborting');
                    if (!loopWarningSent && channel && msg.channelType !== 'internal') {
                      loopWarningSent = true;
                      await channel.send('⚠ I\'m stuck in a reasoning loop (thinking without taking action). Stopping.', msg.channelId).catch(() => {});
                    }
                    loopAbortController.abort();
                    return;
                  }
                  const textRepeat = loopDetector.detectTextRepetition();
                  if (textRepeat) {
                    logger.warn({ pattern: textRepeat.pattern, count: textRepeat.count }, 'Text repetition loop detected — aborting');
                    if (!loopWarningSent && channel && msg.channelType !== 'internal') {
                      loopWarningSent = true;
                      await channel.send('⚠ I keep generating the same response. Stopping to prevent repetition.', msg.channelId).catch(() => {});
                    }
                    loopAbortController.abort();
                  }
                }
              },
            });
          }

          usedProvider = { name: provider.name, model: provider.getModel() };
          this.providers.markSuccess(provider.name);
          break;
        } catch (err: any) {
          if (loopDetector.isHardAborted() || loopAbortController.signal.aborted) {
            logger.info('Generation aborted due to loop detection — using partial response');
            if (!result && streamedText) {
              result = { text: streamedText, usage: undefined };
            }
            if (!result) {
              result = { text: 'I stopped because I detected I was stuck in a loop (repeating the same action without progress). I cannot complete this task as requested. Please let me know if you\'d like me to try a completely different approach, or if there\'s something else I can help with.', usage: undefined };
            }
            if (usedProvider) {
              this.providers.markSuccess(usedProvider.name);
            }
            break;
          }
          lastError = err;
          logger.warn({ provider: provider.name, err: err.message }, 'Provider failed, trying fallback');
          if (channel && msg.channelType !== 'internal') {
            await channel.send(`  [Provider ${provider.name} failed, trying fallback...]`, msg.channelId).catch(() => {});
          }
        }
      }

      if (!result) {
        const errMsg = `All LLM providers failed. Last error: ${lastError?.message || 'unknown'}`;
        logger.error({ err: lastError }, errMsg);
        if (channel && msg.channelType !== 'internal') {
          await channel.send(errMsg, msg.channelId);
        }
        this.lifecycle.transition('idle');
        return;
      }

      const finalText = (streamedText || result.text || '').trim() || '(no text response)';

      this.tokenBudget.recordUsage({
        provider: usedProvider!.name,
        model: usedProvider!.model,
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
        totalTokens: (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
        channelType: msg.channelType,
      });

      this.shortTerm.add(msg.channelId, {
        id: msg.id,
        timestamp: msg.timestamp,
        role: 'user',
        content: msg.content,
      });

      this.shortTerm.add(msg.channelId, {
        id: Date.now().toString(36),
        timestamp: Date.now(),
        role: 'assistant',
        content: finalText,
        tokenCount: (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
        reasoning: result.reasoning || undefined,
      });

      this.episodic.record({
        type: 'message',
        summary: `User: ${msg.content.slice(0, 100)} | Agent: ${finalText.slice(0, 100)}`,
        channelType: msg.channelType,
      });

      if (msg.channelType !== 'internal') {
        this.extractMemory(msg.content, finalText).catch(err => {
          logger.warn({ err }, 'Memory extraction failed');
        });
      }

      if (channel && msg.channelType !== 'internal') {
        const elapsed = Date.now() - startTime;
        if (streamedText && streamedText.trim()) {
          logger.info({ channelType: msg.channelType, elapsed }, 'Streamed response completed');
        } else {
          logger.info({ channelType: msg.channelType, targetId: msg.channelId }, 'Sending response');
          await channel.send(finalText, msg.channelId, elapsed);
        }
      } else {
        logger.debug('Internal prompt processed, no channel response needed');
      }

      this.lifecycle.transition('idle');
    } catch (err) {
      logger.error({ err }, 'Error handling message');
      this.lifecycle.transition('idle');
    } finally {
      if (isInternal || isScheduled) {
        this.capabilities.permissions.setAutoApproveAll(false);
      }
      this.capabilities.permissions.clearElevation();
    }
  }

  private buildSystemPrompt(): string {
    let prompt = this.identity.getSystemPrompt(this.config.identity);
    const skillContext = this.capabilities.getSkillContext();
    if (skillContext) {
      prompt += '\n\n' + skillContext;
    }
    const budgetStatus = this.tokenBudget.getStatusText();
    prompt += '\n\n' + budgetStatus;
    if (this.tokenBudget.getUsagePercentage() > 70) {
      prompt += '\nBe concise to conserve tokens.';
    }

    prompt += `\n\nEnvironment:\n- Platform: ${process.platform}\n- Working directory: ${this.capabilities.getCwd()}`;

    if (this.userMemory) {
      const summary = this.userMemory.getSummary();
      prompt += `\n\nSecond Brain is ENABLED. You have a persistent, structured memory of ${summary.total} facts about this user.`;
      prompt += `\nMemory types: identity, preference, goal, project, habit, decision, constraint, relationship, episode, reflection.`;
      prompt += `\nRelevant memories are automatically injected before each message. You can reference them naturally (e.g. "I remember you prefer TypeScript").`;
      prompt += `\nUsers can manage memory with: /memory (overview, search, pause learning, clear).`;
      if (summary.learningPaused) {
        prompt += `\nLearning is currently PAUSED — no new memories will be extracted from conversations until resumed.`;
      }
    } else {
      prompt += '\n\nSecond Brain is DISABLED. Basic long-term memory (text search over facts) is still active.';
    }

    const toolNames = this.capabilities.getToolNames();
    const githubTools = ['create_pr', 'review_pr', 'list_issues', 'create_issue', 'github_api'];
    const hasGitHub = githubTools.some(t => toolNames.includes(t));
    if (hasGitHub) {
      let githubHint = '\n\nGitHub companion is active.';
      const { defaultOwner, defaultRepo } = this.config.github;
      if (defaultOwner && defaultRepo) {
        githubHint += ` Default repo: ${defaultOwner}/${defaultRepo}. Use this when the user doesn't specify a repo.`;
      }

      githubHint += `

Available GitHub tools and when to use them:
- git_add, git_commit, git_push: LOCAL git operations (stage, commit, push to a remote you have SSH/auth access to). All commits include "Co-authored-by: Mercury <mercury@cosmicstack.org>".
- create_pr: Create a pull request on GitHub. The head branch must already exist on the remote.
- review_pr: Get PR details and optionally post a review comment.
- list_issues, create_issue: Browse and file issues.
- github_api: Raw GitHub API access. IMPORTANT USE CASES:
  - Push files directly to GitHub via PUT /repos/{owner}/{repo}/contents/{path} when git push fails due to auth. The body must include "message" and "content" (base64-encoded file content). This creates a commit on GitHub with Mercury as co-author.
  - Delete files via DELETE /repos/{owner}/{repo}/contents/{path} with a "message" and "sha" in the body.
  - Any other GitHub API operation not covered by the other tools.

When the user asks to "push to GitHub" or "upload files" and git push fails, use github_api with PUT /repos/{owner}/{repo}/contents/{path} to push content directly through the API. This bypasses local git entirely.

Always specify owner and repo parameters on GitHub tools. The user's GitHub username is ${this.config.github.username || 'not set'}.'`;

      prompt += githubHint;
    }
    return prompt;
  }

  async processInternalPrompt(prompt: string, channelId?: string, channelType?: string): Promise<void> {
    const syntheticMsg: ChannelMessage = {
      id: `internal-${Date.now().toString(36)}`,
      channelId: channelId || 'internal',
      channelType: (channelType || 'internal') as ChannelType,
      senderId: 'system',
      content: prompt,
      timestamp: Date.now(),
    };
    this.enqueueMessage(syntheticMsg);
  }

  private async handleScheduledTask(manifest: ScheduledTaskManifest): Promise<void> {
    logger.info({ task: manifest.id, channel: manifest.sourceChannelType }, 'Processing scheduled task');
    try {
      const channel = manifest.sourceChannelType
        ? this.channels.get(manifest.sourceChannelType as ChannelType)
        : this.channels.getNotificationChannel();

      if (channel && manifest.sourceChannelType !== 'internal') {
        const skillInfo = manifest.skillName ? ` (${manifest.skillName})` : '';
        await channel.send(
          ` Scheduled task started${skillInfo}: ${manifest.description}\nAll actions auto-approved for this run.`,
          manifest.sourceChannelId,
        ).catch(() => {});
      }

      let prompt = manifest.prompt || '';
      if (manifest.skillName) {
        const skillHint = `Invoke the skill "${manifest.skillName}" using the use_skill tool and follow its instructions.`;
        prompt = prompt ? `${prompt} ${skillHint}` : `Scheduled task triggered. ${skillHint}`;
      }
      if (!prompt) {
        prompt = `Execute scheduled task: ${manifest.description}`;
      }
      await this.processInternalPrompt(prompt, manifest.sourceChannelId, manifest.sourceChannelType);
    } catch (err) {
      logger.error({ err, task: manifest.id }, 'Scheduled task execution failed');
    }
  }

  private async heartbeat(): Promise<void> {
    logger.debug('Heartbeat tick');

    const pruned = this.episodic.prune(7);
    if (pruned > 0) {
      logger.info({ pruned }, 'Episodic memory pruned');
    }

    if (this.userMemory) {
      try {
        const consolidation = this.userMemory.consolidate();
        if (consolidation.profileUpdated || consolidation.reflectionCount > 0) {
          logger.info({ consolidation }, 'Second brain consolidated');
        }

        const pruning = this.userMemory.prune();
        if (pruning.activePruned > 0 || pruning.durablePruned > 0 || pruning.promoted > 0) {
          logger.info({ pruning }, 'Second brain pruned');
        }
      } catch (err) {
        logger.warn({ err }, 'Second brain heartbeat error');
      }
    }

    const notifications: string[] = [];

    const usagePct = this.tokenBudget.getUsagePercentage();
    if (usagePct >= 80) {
      notifications.push(`Token budget at ${Math.round(usagePct)}% — ${this.tokenBudget.getRemaining().toLocaleString()} tokens remaining today.`);
    }

    const pendingSchedules = this.scheduler.getManifests();
    const now = Date.now();
    for (const task of pendingSchedules) {
      if (task.delaySeconds && task.executeAt) {
        const executeAt = new Date(task.executeAt).getTime();
        const diffMin = Math.round((executeAt - now) / 60000);
        if (diffMin > 0 && diffMin <= 5) {
          notifications.push(`Task "${task.description}" fires in ${diffMin} minute${diffMin !== 1 ? 's' : ''}.`);
        }
      }
    }

    if (notifications.length > 0) {
      const channel = this.channels.getNotificationChannel();
      if (channel) {
        const msg = notifications.join('\n');
        try {
          await channel.send(msg, 'notification');
        } catch (err) {
          logger.warn({ err }, 'Failed to send heartbeat notification');
        }
      }
    }
  }

  private async extractMemory(userMessage: string, agentResponse: string): Promise<void> {
    if (!this.userMemory) return;
    if (this.userMemory.isLearningPaused()) return;

    const trivial = /^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|bye|goodbye|good morning|good evening)\b/i;
    if (trivial.test(userMessage.trim())) return;

    if (!this.tokenBudget.canAfford(800)) return;

    try {
      const provider = this.providers.getDefault();
      const result = await generateText({
        model: provider.getModelInstance(),
        system: `You extract structured memory from conversations. Read the conversation and output a JSON array of memory candidates. Each candidate has: type (one of: identity, preference, goal, project, habit, decision, constraint, relationship, episode), summary (concise fact, 12-220 chars), detail (optional longer explanation), evidenceKind (direct for explicitly stated facts, inferred for patterns you notice), confidence (0.0-1.0), importance (0.0-1.0), durability (0.0-1.0). Extract 0-3 candidates. Only extract specific, durable, user-specific information. Do NOT extract trivial observations, greetings, or assistant behavior. Output pure JSON array, no markdown.`,
        messages: [
          { role: 'user', content: `User: ${userMessage}\nAssistant: ${agentResponse}` },
        ],
        maxOutputTokens: 400,
      });

      this.tokenBudget.recordUsage({
        provider: provider.name,
        model: provider.getModel(),
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
        totalTokens: (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
        channelType: 'internal',
      });

      const text = result.text.trim();
      if (!text) return;

      let candidates: Array<{
        type: string;
        summary: string;
        detail?: string;
        evidenceKind?: string;
        confidence: number;
        importance: number;
        durability: number;
      }>;

      try {
        const jsonStr = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
        candidates = JSON.parse(jsonStr);
      } catch {
        const facts = text
          .split('\n')
          .map(l => l.replace(/^-\s*/, '').trim())
          .filter(f => f.length > 10 && f.length < 200);
        candidates = facts.slice(0, 3).map(f => ({
          type: 'preference',
          summary: f,
          confidence: 0.75,
          importance: 0.7,
          durability: 0.7,
          evidenceKind: 'inferred',
        }));
      }

      const validTypes = ['identity', 'preference', 'goal', 'project', 'habit', 'decision', 'constraint', 'relationship', 'episode'];
      const typed = candidates
        .filter(c => c.summary && c.summary.length >= 12 && c.summary.length <= 220)
        .filter(c => validTypes.includes(c.type))
        .map(c => ({
          type: c.type as any,
          summary: c.summary,
          detail: c.detail,
          evidenceKind: (c.evidenceKind === 'direct' ? 'direct' : 'inferred') as 'direct' | 'inferred',
          confidence: Math.min(1, Math.max(0, c.confidence ?? 0.7)),
          importance: Math.min(1, Math.max(0, c.importance ?? 0.7)),
          durability: Math.min(1, Math.max(0, c.durability ?? 0.7)),
        }));

      if (typed.length > 0) {
        const remembered = this.userMemory.remember(typed, 'conversation');
        if (remembered.length > 0) {
          logger.info({ count: remembered.length, types: remembered.map(r => r.type) }, 'Second brain memories stored');
        }

        if (this.sharedMemory && !this.sharedMemory.isLearningPaused()) {
          try {
            const sharedCandidates = await this.extractSharedMemoryCandidates(userMessage, agentResponse, typed);
            if (sharedCandidates.length > 0) {
              const sharedRemembered = this.sharedMemory.remember(sharedCandidates, 'conversation');
              if (sharedRemembered.length > 0) {
                logger.info({ count: sharedRemembered.length }, 'Shared memory entries stored');
              }
            }
          } catch (err) {
            logger.debug({ err }, 'Shared memory extraction error (non-critical)');
          }
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Memory extraction error');
    }
  }

  private async extractSharedMemoryCandidates(
    userMessage: string,
    agentResponse: string,
    existingCandidates: Array<{ type: string; summary: string; detail?: string }>,
  ): Promise<import('../memory/shared-memory-store.js').SharedMemoryCandidate[]> {
    if (!this.sharedMemory) return [];

    const existingCategories = this.sharedMemory.getSummary().categories;
    const categoryList = existingCategories.length > 0
      ? `Existing categories: ${existingCategories.join(', ')}. Check if a memory fits an existing category first before creating a new one.`
      : 'No categories exist yet. Assign the most fitting category.';

    try {
      const provider = this.providers.getDefault();
      const result = await generateText({
        model: provider.getModelInstance(),
        system: `You categorize memories for shared storage. Given the conversation and the extracted memories, assign a category to each memory. ${categoryList} Output a JSON array. Each object has: type (same as input), category (a short label like "health", "finance", "personal", "professional", "technology", etc.), summary (same as input, 12-220 chars), detail (optional), evidenceKind (direct or inferred), confidence (0.0-1.0), importance (0.0-1.0), durability (0.0-1.0). Output pure JSON array, no markdown.`,
        messages: [
          { role: 'user', content: `Extracted memories:\n${JSON.stringify(existingCandidates)}\n\nConversation:\nUser: ${userMessage}\nAssistant: ${agentResponse}` },
        ],
        maxOutputTokens: 400,
      });

      this.tokenBudget.recordUsage({
        provider: provider.name,
        model: provider.getModel(),
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
        totalTokens: (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
        channelType: 'internal',
      });

      const text = result.text.trim();
      if (!text) return [];

      const jsonStr = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      const parsed = JSON.parse(jsonStr);

      if (!Array.isArray(parsed)) return [];

      const validTypes = ['identity', 'preference', 'goal', 'project', 'habit', 'decision', 'constraint', 'relationship', 'episode'];
      return parsed
        .filter((c: any) => c.summary && c.summary.length >= 12 && c.summary.length <= 220)
        .filter((c: any) => validTypes.includes(c.type))
        .map((c: any) => ({
          type: c.type as import('../memory/shared-memory-store.js').SharedMemoryType,
          category: (c.category || 'general').toLowerCase().trim(),
          summary: c.summary,
          detail: c.detail,
          evidenceKind: (c.evidenceKind === 'direct' ? 'direct' : 'inferred') as 'direct' | 'inferred',
          confidence: Math.min(1, Math.max(0, c.confidence ?? 0.7)),
          importance: Math.min(1, Math.max(0, c.importance ?? 0.7)),
          durability: Math.min(1, Math.max(0, c.durability ?? 0.7)),
        }));
    } catch {
      const validTypes = ['identity', 'preference', 'goal', 'project', 'habit', 'decision', 'constraint', 'relationship', 'episode'];
      return existingCandidates
        .filter(c => validTypes.includes(c.type) && c.summary.length >= 12 && c.summary.length <= 220)
        .map(c => ({
          type: c.type as import('../memory/shared-memory-store.js').SharedMemoryType,
          category: 'general',
          summary: c.summary,
          detail: c.detail,
          evidenceKind: 'inferred' as const,
          confidence: 0.7,
          importance: 0.7,
          durability: 0.7,
        }));
    }
  }

  async shutdown(): Promise<void> {
    await this.sleep();
    logger.info('Mercury has shut down');
  }

  private async handleBudgetOverrideCLI(channel: import('../channels/base.js').Channel, msg: ChannelMessage): Promise<void> {
    const status = this.tokenBudget.getStatusText();
    await channel.send(
      `Token budget exceeded! ${status}\n\nChoose an option:\n  1 — Override (allow this one request)\n  2 — Reset usage to zero\n  3 — Set a new daily budget (current: ${this.tokenBudget.getBudget().toLocaleString()})\n  4 — Cancel\n\nOr use /budget override, /budget reset, /budget set <number> anytime.`,
      msg.channelId,
    );
  }

  async handleBudgetCommand(subcommand: string, channelType: string, channelId: string): Promise<void> {
    const channel = this.channels.get(channelType as any);
    if (!channel) return;

    const parts = subcommand.trim().split(/\s+/);
    const action = parts[0]?.toLowerCase();

    if (action === 'override' || action === '1') {
      this.tokenBudget.forceAllowNext();
      await channel.send('Budget override applied — your next request will proceed.', channelId);
    } else if (action === 'reset' || action === '2') {
      this.tokenBudget.resetUsage();
      await channel.send(`Usage reset to zero. ${this.tokenBudget.getStatusText()}`, channelId);
    } else if (action === 'set' || action === '3') {
      const newBudget = parseInt(parts[1], 10);
      if (isNaN(newBudget) || newBudget <= 0) {
        await channel.send('Please specify the new budget. Usage: `/budget set 100000` or type e.g. `3 100000`', channelId);
        return;
      }
      this.tokenBudget.setBudget(newBudget);
      await channel.send(`Daily budget updated to ${newBudget.toLocaleString()} tokens. ${this.tokenBudget.getStatusText()}`, channelId);
    } else if (action === 'cancel' || action === '4') {
      await channel.send(`Cancelled. ${this.tokenBudget.getStatusText()}`, channelId);
    } else if (!action || action === 'status') {
      await channel.send(this.tokenBudget.getStatusText(), channelId);
    } else {
      await channel.send(`Unknown budget command "${action}". Available: /budget, /budget override, /budget reset, /budget set <number>, /budget status`, channelId);
    }
  }

  private async handleChatCommand(content: string, channelType: string, channelId: string): Promise<boolean> {
    const trimmed = content.trim();
    const cmd = trimmed.toLowerCase();
    const channel = this.channels.get(channelType as any);
    if (!channel) return false;

    const ctx = this.capabilities.getChatCommandContext();
    if (!ctx) return false;

    if (cmd === '/help') {
      await channel.send(ctx.manual(), channelId);
      return true;
    }

    if (cmd === '/exit' || cmd === '/quit') {
      await channel.send('Goodbye! Shutting down Mercury...', channelId);
      this.shutdown();
      return true;
    }

    if (cmd === '/status') {
      const config = ctx.config();
      const budget = ctx.tokenBudget();
      const lines = [
        `**${config.identity.name}** — Status`,
        `Owner: ${config.identity.owner || '(not set)'}`,
        `Provider: ${config.providers.default}`,
        `Telegram: ${config.channels.telegram.enabled ? 'enabled' : 'disabled'}`,
        `Telegram access: ${getTelegramAccessSummary(config)}`,
        `Budget: ${budget.getStatusText()}`,
        `Skills: ${ctx.skillNames().length > 0 ? ctx.skillNames().join(', ') : 'none'}`,
      ];
      await channel.send(lines.join('\n'), channelId);
      return true;
    }

    if (cmd === '/memory') {
      if (!this.userMemory) {
        await channel.send('Second brain is not enabled.', channelId);
        return true;
      }

      if (channelType === 'cli' && channel instanceof CLIChannel) {
        await this.openCliMemoryMenu(channel, channelId);
        return true;
      }

      await this.sendMemoryOverview(channel, channelId);
      return true;
    }

    if (cmd === '/shared') {
      if (!this.sharedMemory) {
        await channel.send('Shared memory is not enabled.', channelId);
        return true;
      }
      const isPaused = this.sharedMemory.isLearningPaused();
      this.sharedMemory.setLearningPaused(!isPaused);
      await channel.send(
        isPaused
          ? 'Shared learning resumed. New memories will be stored in shared memory.'
          : 'Shared learning paused. Memories will NOT be stored in shared memory until resumed.',
        channelId,
      );
      return true;
    }

    if (cmd.startsWith('/friend')) {
      if (!this.sharedMemory) {
        await channel.send('Shared memory is not enabled.', channelId);
        return true;
      }
      const friendTgId = trimmed.slice('/friend'.length).trim();
      if (!friendTgId || !/^\d+$/.test(friendTgId)) {
        await channel.send('Usage: /friend <TELEGRAM_USER_ID>\nExample: /friend 123456789', channelId);
        return true;
      }
      const existing = this.sharedMemory.getFriend(friendTgId);
      if (existing) {
        await channel.send(`User ${friendTgId} is already in your friend list (status: ${existing.status}).`, channelId);
        return true;
      }
      this.sharedMemory.addFriendRequest(friendTgId);
      await channel.send(`Friend request for ${friendTgId} recorded locally. If relay is connected, it will be forwarded.`, channelId);
      return true;
    }

    if (cmd === '/listfriends') {
      if (!this.sharedMemory) {
        await channel.send('Shared memory is not enabled.', channelId);
        return true;
      }
      const friends = this.sharedMemory.getFriends();
      if (friends.length === 0) {
        await channel.send('No friends yet. Use /friend <TELEGRAM_USER_ID> to add someone.', channelId);
        return true;
      }
      const lines = ['**Friends List**\n'];
      const pending = friends.filter(f => f.status === 'pending');
      const approved = friends.filter(f => f.status === 'approved');
      const revoked = friends.filter(f => f.status === 'revoked');
      if (pending.length > 0) {
        lines.push('**Pending:**');
        for (const f of pending) {
          const name = f.username ? `@${f.username}` : f.firstName || f.tgId;
          lines.push(`  ${name} (ID: ${f.tgId})`);
        }
      }
      if (approved.length > 0) {
        lines.push('**Approved:**');
        for (const f of approved) {
          const name = f.username ? `@${f.username}` : f.firstName || f.tgId;
          const negList = f.negativeTags.length > 0 ? ` [excluded: ${f.negativeTags.join(', ')}]` : '';
          lines.push(`  ${name} (ID: ${f.tgId})${negList}`);
        }
      }
      if (revoked.length > 0) {
        lines.push('**Revoked:**');
        for (const f of revoked) {
          const name = f.username ? `@${f.username}` : f.firstName || f.tgId;
          lines.push(`  ${name} (ID: ${f.tgId})`);
        }
      }
      await channel.send(lines.join('\n'), channelId);
      return true;
    }

    if (cmd.startsWith('/telegram')) {
      if (channelType !== 'cli') {
        await channel.send('`/telegram` is only available from the Mercury CLI chat.', channelId);
        return true;
      }

      const config = ctx.config();
      const rawSubcommand = trimmed.slice('/telegram'.length).trim();
      if (!rawSubcommand && channel instanceof CLIChannel) {
        await channel.withMenu(async (select) => {
          await this.openCliTelegramMenu(channel, channelId, select);
        });
        return true;
      }

      const parts = rawSubcommand.split(/\s+/).filter(Boolean);
      const action = parts[0]?.toLowerCase() || 'help';
      const formatTelegramUser = (user: {
        userId: number;
        username?: string;
        firstName?: string;
        pairingCode?: string;
      }) => {
        const username = user.username ? ` (@${user.username})` : '';
        const firstName = user.firstName ? ` ${user.firstName}` : '';
        const pairingCode = user.pairingCode ? ` [code: ${user.pairingCode}]` : '';
        return `${user.userId}${username}${firstName}${pairingCode}`;
      };

      const sendTelegramOverview = async () => {
        const lines = [
          '**Telegram Management**',
          '',
          `Access: ${getTelegramAccessSummary(config)}`,
          `Admins: ${config.channels.telegram.admins.length > 0 ? config.channels.telegram.admins.map(formatTelegramUser).join(', ') : 'none'}`,
          `Members: ${config.channels.telegram.members.length > 0 ? config.channels.telegram.members.map(formatTelegramUser).join(', ') : 'none'}`,
          `Pending: ${config.channels.telegram.pending.length > 0 ? config.channels.telegram.pending.map(formatTelegramUser).join(', ') : 'none'}`,
          '',
          'Commands:',
          '• `/telegram pending`',
          '• `/telegram users`',
          '• `/telegram approve <pairing-code|user-id>`',
          '• `/telegram reject <user-id>`',
          '• `/telegram remove <user-id>`',
          '• `/telegram promote <user-id>`',
          '• `/telegram demote <user-id>`',
          '• `/telegram reset`',
        ];
        await channel.send(lines.join('\n'), channelId);
      };

      if (action === 'help' || action === 'status') {
        await sendTelegramOverview();
        return true;
      }

      if (action === 'pending') {
        const pending = getTelegramPendingRequests(config);
        const lines = [
          '**Telegram Pending Requests**',
          '',
          pending.length > 0 ? pending.map(formatTelegramUser).join('\n') : 'No pending Telegram requests.',
        ];
        await channel.send(lines.join('\n'), channelId);
        return true;
      }

      if (action === 'users') {
        const approved = getTelegramApprovedUsers(config);
        const lines = [
          '**Telegram Approved Users**',
          '',
          `Admins: ${config.channels.telegram.admins.length > 0 ? config.channels.telegram.admins.map(formatTelegramUser).join(', ') : 'none'}`,
          `Members: ${config.channels.telegram.members.length > 0 ? config.channels.telegram.members.map(formatTelegramUser).join(', ') : 'none'}`,
          '',
          `Total approved: ${approved.length}`,
        ];
        await channel.send(lines.join('\n'), channelId);
        return true;
      }

      if (action === 'approve') {
        const value = parts[1];
        if (!value) {
          await channel.send('Usage: `/telegram approve <pairing-code|user-id>`', channelId);
          return true;
        }

        let approved = approveTelegramPendingRequestByPairingCode(config, value);
        let resultLabel = value;

        if (!approved) {
          const userId = Number(value);
          if (!isNaN(userId)) {
            approved = approveTelegramPendingRequest(config, userId, 'member');
            resultLabel = userId.toString();
          }
        }

        if (!approved) {
          await channel.send(`No pending Telegram request found for \`${resultLabel}\`.`, channelId);
          return true;
        }

        saveConfig(config);
        await channel.send(`Approved Telegram user ${formatTelegramUser(approved)}.`, channelId);
        return true;
      }

      if (action === 'reject') {
        const value = Number(parts[1]);
        if (isNaN(value)) {
          await channel.send('Usage: `/telegram reject <user-id>`', channelId);
          return true;
        }

        const rejected = rejectTelegramPendingRequest(config, value);
        if (!rejected) {
          await channel.send(`No pending Telegram request found for \`${value}\`.`, channelId);
          return true;
        }

        saveConfig(config);
        await channel.send(`Rejected Telegram request for ${formatTelegramUser(rejected)}.`, channelId);
        return true;
      }

      if (action === 'remove') {
        const value = Number(parts[1]);
        if (isNaN(value)) {
          await channel.send('Usage: `/telegram remove <user-id>`', channelId);
          return true;
        }

        const removed = removeTelegramUser(config, value);
        if (!removed) {
          await channel.send(`No approved Telegram user found for \`${value}\`.`, channelId);
          return true;
        }

        saveConfig(config);
        await channel.send(`Removed Telegram access for ${formatTelegramUser(removed)}.`, channelId);
        return true;
      }

      if (action === 'promote') {
        const value = Number(parts[1]);
        if (isNaN(value)) {
          await channel.send('Usage: `/telegram promote <user-id>`', channelId);
          return true;
        }

        const promoted = promoteTelegramUserToAdmin(config, value);
        if (!promoted) {
          await channel.send(`No Telegram member found for \`${value}\`.`, channelId);
          return true;
        }

        saveConfig(config);
        await channel.send(`Promoted ${formatTelegramUser(promoted)} to Telegram admin.`, channelId);
        return true;
      }

      if (action === 'demote') {
        const value = Number(parts[1]);
        if (isNaN(value)) {
          await channel.send('Usage: `/telegram demote <user-id>`', channelId);
          return true;
        }

        const demoted = demoteTelegramAdmin(config, value);
        if (!demoted) {
          await channel.send('Could not demote that Telegram admin. Mercury must keep at least one admin.', channelId);
          return true;
        }

        saveConfig(config);
        await channel.send(`Demoted ${formatTelegramUser(demoted)} to Telegram member.`, channelId);
        return true;
      }

      if (action === 'reset' || action === 'unpair') {
        config.channels.telegram.admins = [];
        config.channels.telegram.members = [];
        config.channels.telegram.pending = [];
        saveConfig(config);
        await channel.send('Telegram access reset. New users can send /start to begin pairing again.', channelId);
        return true;
      }

      await channel.send(
      `Unknown Telegram command "${action}". Try \`/telegram\`, \`/telegram pending\`, or \`/telegram users\`.`,
        channelId,
      );
      return true;
    }

    if ((cmd === '/' || cmd === '/menu') && channelType === 'cli' && channel instanceof CLIChannel) {
      await this.openCliCommandMenu(channel, channelId);
      return true;
    }

    if (cmd === '/tools') {
      const tools = ctx.toolNames();
      const grouped = [
        `**${tools.length} tools loaded:**`,
        '',
        ...tools.sort().map(t => `• \`${t}\``),
      ];
      await channel.send(grouped.join('\n'), channelId);
      return true;
    }

    if (cmd === '/skills') {
      const names = ctx.skillNames();
      if (names.length === 0) {
        await channel.send('No skills installed. Ask me to "install skill from <url>" to add one.', channelId);
      } else {
        const lines = [
          `**${names.length} skill${names.length > 1 ? 's' : ''} installed:**`,
          '',
          ...names.map(n => `• ${n}`),
        ];
        await channel.send(lines.join('\n'), channelId);
      }
      return true;
    }

    if (cmd === '/stream on') {
      this.telegramStreaming = true;
      await channel.send('Telegram streaming enabled. Responses will appear progressively.', channelId);
      return true;
    }

    if (cmd === '/stream off') {
      this.telegramStreaming = false;
      await channel.send('Telegram streaming disabled. Responses will arrive as a single message.', channelId);
      return true;
    }

    if (cmd === '/stream') {
      this.telegramStreaming = !this.telegramStreaming;
      await channel.send(
        this.telegramStreaming
          ? 'Telegram streaming enabled. Responses will appear progressively.'
          : 'Telegram streaming disabled. Responses will arrive as a single message.',
        channelId,
      );
      return true;
    }
    if (cmd === '/stream off') {
      this.telegramStreaming = false;
      await channel.send('Telegram streaming disabled. Responses will arrive as a single message.', channelId);
      return true;
    }

    return false;
  }

  private async openCliCommandMenu(channel: CLIChannel, channelId: string): Promise<void> {
    const ctx = this.capabilities.getChatCommandContext();
    if (!ctx) return;

    await channel.withMenu(async (select) => {
      while (true) {
        const streamLabel = this.telegramStreaming ? 'Disable Telegram Streaming' : 'Enable Telegram Streaming';
        const action = await select('Mercury Commands', [
          { value: 'status', label: 'Status' },
          { value: 'memory', label: 'Memory' },
          { value: 'telegram', label: 'Telegram' },
          { value: 'tools', label: 'Tools' },
          { value: 'skills', label: 'Skills' },
          { value: 'stream', label: streamLabel },
          { value: 'help', label: 'Help' },
          { value: 'exit', label: 'Exit' },
        ]);

        if (action === 'exit') {
          return;
        }

        if (action === 'status') {
          await this.handleChatCommand('/status', 'cli', channelId);
          continue;
        }

        if (action === 'memory') {
          if (this.userMemory) {
            await this.openCliMemoryMenu(channel, channelId, select);
          } else {
            await channel.send('Second brain is not enabled.', channelId);
          }
          continue;
        }

        if (action === 'telegram') {
          await this.openCliTelegramMenu(channel, channelId, select);
          continue;
        }

        if (action === 'tools') {
          await this.handleChatCommand('/tools', 'cli', channelId);
          continue;
        }

        if (action === 'skills') {
          await this.handleChatCommand('/skills', 'cli', channelId);
          continue;
        }

        if (action === 'stream') {
          await this.handleChatCommand('/stream', 'cli', channelId);
          continue;
        }

        if (action === 'help') {
          await channel.send(ctx.manual(), channelId);
        }
      }
    });
  }

  private async sendMemoryOverview(channel: any, channelId: string): Promise<void> {
    if (!this.userMemory) return;
    const summary = this.userMemory.getSummary();
    const lines = [
      `**Memory Overview**`,
      `Total memories: ${summary.total}`,
      `Learning: ${summary.learningPaused ? 'PAUSED' : 'ACTIVE'}`,
    ];
    if (summary.profileSummary) {
      lines.push(`Profile: ${summary.profileSummary}`);
    }
    if (summary.activeSummary) {
      lines.push(`Active: ${summary.activeSummary}`);
    }
    const typeEntries = Object.entries(summary.byType);
    if (typeEntries.length > 0) {
      lines.push('');
      lines.push('By type:');
      for (const [type, count] of typeEntries) {
        lines.push(`  ${type}: ${count}`);
      }
    }
    if (this.sharedMemory) {
      const sharedSummary = this.sharedMemory.getSummary();
      lines.push('');
      lines.push('**Shared Memory**');
      lines.push(`  Entries: ${sharedSummary.total}`);
      lines.push(`  Learning: ${sharedSummary.learningPaused ? 'PAUSED' : 'ACTIVE'}`);
      lines.push(`  Friends: ${sharedSummary.friendCount}`);
      if (sharedSummary.categories.length > 0) {
        lines.push(`  Categories: ${sharedSummary.categories.join(', ')}`);
      }
    }
    await channel.send(lines.join('\n'), channelId);
  }

  private async openCliMemoryMenu(channel: CLIChannel, channelId: string, select?: (title: string, options: ArrowSelectOption[]) => Promise<string>): Promise<void> {
    if (!this.userMemory) return;

    const runMenu = async (sel: (title: string, options: ArrowSelectOption[]) => Promise<string>) => {
      while (true) {
        const learningLabel = this.userMemory!.isLearningPaused() ? 'Resume Learning' : 'Pause Learning';
        const sharedLearningLabel = this.sharedMemory
          ? (this.sharedMemory.isLearningPaused() ? '▶ Shared Learning ON' : '⏸ Shared Learning OFF')
          : null;

        const options: ArrowSelectOption[] = [
          { value: 'overview', label: 'Overview' },
          { value: 'recent', label: 'Recent Memories' },
          { value: 'search', label: 'Search' },
          { value: 'toggle', label: learningLabel },
        ];

        if (sharedLearningLabel) {
          options.push({ value: 'shared_toggle', label: sharedLearningLabel });
          options.push({ value: 'shared_overview', label: 'Shared Memory Overview' });
          options.push({ value: 'shared_recent', label: 'Shared Recent Memories' });
          options.push({ value: 'friends', label: 'Friends List' });
        }

        options.push(
          { value: 'clear', label: 'Clear All Memories' },
          { value: 'back', label: 'Back' },
        );

        const action = await sel('Memory', options);

        if (action === 'back') return;

        if (action === 'overview') {
          await this.sendMemoryOverview(channel, channelId);
          continue;
        }

        if (action === 'recent') {
          const recent = this.userMemory!.getRecent(10);
          if (recent.length === 0) {
            await channel.send('No memories yet.', channelId);
            continue;
          }
          const lines = ['**Recent Memories:**', ''];
          for (const r of recent) {
            const scope = r.scope === 'active' ? '⏳' : '📌';
            const kind = r.evidenceKind === 'direct' ? 'direct' : r.evidenceKind === 'inferred' ? 'inferred' : r.evidenceKind;
            lines.push(`${scope} [${r.type}] ${r.summary}`);
            lines.push(`   Confidence: ${r.confidence.toFixed(2)} | Evidence: ${kind} | Seen: ${r.evidenceCount}x`);
          }
          await channel.send(lines.join('\n'), channelId);
          continue;
        }

        if (action === 'search') {
          const query = await channel.prompt('Search memories: ');
          if (!query) continue;
          const results = this.userMemory!.search(query, 10);
          if (results.length === 0) {
            await channel.send(`No memories found matching "${query}".`, channelId);
            continue;
          }
          const lines = [`**Search results for "${query}":**`, ''];
          for (const r of results) {
            const scope = r.scope === 'active' ? '⏳' : '📌';
            lines.push(`${scope} [${r.type}] ${r.summary}`);
            lines.push(`   Confidence: ${r.confidence.toFixed(2)} | Evidence: ${r.evidenceKind} | Seen: ${r.evidenceCount}x`);
          }
          await channel.send(lines.join('\n'), channelId);
          continue;
        }

        if (action === 'toggle') {
          const currentlyPaused = this.userMemory!.isLearningPaused();
          this.userMemory!.setLearningPaused(!currentlyPaused);
          await channel.send(currentlyPaused ? 'Learning resumed. Mercury will remember new things from conversations.' : 'Learning paused. Mercury will not store new memories until resumed.', channelId);
          continue;
        }

        if (action === 'shared_toggle' && this.sharedMemory) {
          const currentlyPaused = this.sharedMemory.isLearningPaused();
          this.sharedMemory.setLearningPaused(!currentlyPaused);
          await channel.send(currentlyPaused
            ? 'Shared learning resumed. New memories will be stored in shared memory.'
            : 'Shared learning paused. Memories will NOT be shared until resumed.',
            channelId);
          continue;
        }

        if (action === 'shared_overview' && this.sharedMemory) {
          const summary = this.sharedMemory.getSummary();
          const lines = [
            '**Shared Memory Overview**',
            `Total entries: ${summary.total}`,
            `Learning: ${summary.learningPaused ? '⏸ PAUSED' : '✅ ACTIVE'}`,
            `Friends: ${summary.friendCount}`,
          ];
          if (summary.categories.length > 0) {
            lines.push('', '**Categories:**');
            lines.push(...summary.categories.map(c => `  ${c}`));
          }
          const byType = Object.entries(summary.byType);
          if (byType.length > 0) {
            lines.push('', '**By type:**');
            for (const [type, count] of byType) {
              lines.push(`  ${type}: ${count}`);
            }
          }
          await channel.send(lines.join('\n'), channelId);
          continue;
        }

        if (action === 'shared_recent' && this.sharedMemory) {
          const recent = this.sharedMemory.getRecent(10);
          if (recent.length === 0) {
            await channel.send('No shared memories yet.', channelId);
            continue;
          }
          const lines = ['**Recent Shared Memories:**', ''];
          for (const r of recent) {
            const scope = r.scope === 'active' ? '⏳' : '📌';
            lines.push(`${scope} [${r.type}|${r.category}] ${r.summary}`);
            lines.push(`   Confidence: ${r.confidence.toFixed(2)} | Evidence: ${r.evidenceKind}`);
          }
          await channel.send(lines.join('\n'), channelId);
          continue;
        }

        if (action === 'friends' && this.sharedMemory) {
          const friends = this.sharedMemory.getFriends();
          if (friends.length === 0) {
            await channel.send('No friends yet. Use /friend <TELEGRAM_ID> to add someone.', channelId);
            continue;
          }
          const lines = ['**Friends List**', ''];
          const pending = friends.filter(f => f.status === 'pending');
          const approved = friends.filter(f => f.status === 'approved');
          const revoked = friends.filter(f => f.status === 'revoked');
          if (pending.length > 0) {
            lines.push('**Pending:**');
            for (const f of pending) {
              lines.push(`  ${f.username ? `@${f.username}` : f.firstName || 'Unknown'} (ID: ${f.tgId})`);
            }
          }
          if (approved.length > 0) {
            lines.push('**Approved:**');
            for (const f of approved) {
              const negList = f.negativeTags.length > 0 ? ` [excluded: ${f.negativeTags.join(', ')}]` : '';
              lines.push(`  ${f.username ? `@${f.username}` : f.firstName || 'Unknown'} (ID: ${f.tgId})${negList}`);
            }
          }
          if (revoked.length > 0) {
            lines.push('**Revoked:**');
            for (const f of revoked) {
              lines.push(`  ${f.username ? `@${f.username}` : f.firstName || 'Unknown'} (ID: ${f.tgId})`);
            }
          }
          await channel.send(lines.join('\n'), channelId);
          continue;
        }

        if (action === 'clear') {
          const confirm = await sel('Clear all memories?', [
            { value: 'cancel', label: 'Cancel' },
            { value: 'confirm', label: 'Clear everything' },
          ]);
          if (confirm === 'confirm') {
            const cleared = this.userMemory!.clear();
            await channel.send(`Cleared ${cleared} memories.`, channelId);
          }
          continue;
        }
      }
    };

    if (select) {
      await runMenu(select);
    } else {
      await channel.withMenu(runMenu);
    }
  }

  private async openCliTelegramMenu(
    channel: CLIChannel,
    channelId: string,
    select: (title: string, options: ArrowSelectOption[]) => Promise<string>,
  ): Promise<void> {
    const ctx = this.capabilities.getChatCommandContext();
    if (!ctx) return;
    const formatTelegramUser = (user: {
      userId: number;
      username?: string;
      firstName?: string;
      pairingCode?: string;
    }) => {
      const username = user.username ? ` (@${user.username})` : '';
      const firstName = user.firstName ? ` ${user.firstName}` : '';
      const pairingCode = user.pairingCode ? ` [code: ${user.pairingCode}]` : '';
      return `${user.userId}${username}${firstName}${pairingCode}`;
    };

    const selectFromUsers = async (
      title: string,
      users: Array<{ userId: number; username?: string; firstName?: string; pairingCode?: string }>,
      emptyMessage: string,
      backValue: string = 'back',
    ): Promise<string> => {
      if (users.length === 0) {
        await channel.send(emptyMessage, channelId);
        return backValue;
      }

      return select(title, [
        ...users.map((user) => ({
          value: user.pairingCode || user.userId.toString(),
          label: formatTelegramUser(user),
        })),
        { value: backValue, label: 'Back' },
      ]);
    };

    while (true) {
      const config = ctx.config();
      const action = await select('Telegram Commands', [
        { value: 'overview', label: 'Overview' },
        { value: 'pending', label: `Pending Requests (${config.channels.telegram.pending.length})` },
        { value: 'users', label: `Approved Users (${getTelegramApprovedUsers(config).length})` },
        { value: 'approve', label: 'Approve Request' },
        { value: 'reject', label: 'Reject Request' },
        { value: 'remove', label: 'Remove User' },
        { value: 'promote', label: 'Promote to Admin' },
        { value: 'demote', label: 'Demote Admin' },
        { value: 'reset', label: 'Reset Telegram Access' },
        { value: 'back', label: 'Back' },
        { value: 'exit', label: 'Exit' },
      ]);

      if (action === 'exit') {
        return;
      }

      if (action === 'back') {
        return;
      }

      if (action === 'overview') {
        await this.handleChatCommand('/telegram status', 'cli', channelId);
        continue;
      }

      if (action === 'pending') {
        await this.handleChatCommand('/telegram pending', 'cli', channelId);
        continue;
      }

      if (action === 'users') {
        await this.handleChatCommand('/telegram users', 'cli', channelId);
        continue;
      }

      if (action === 'approve') {
        const pending = getTelegramPendingRequests(config);
        const selected = await selectFromUsers(
          'Approve Telegram Request',
          pending,
          'There are no pending Telegram requests to approve.',
        );

        if (selected === 'back') {
          continue;
        }

        await this.handleChatCommand(`/telegram approve ${selected}`, 'cli', channelId);
        continue;
      }

      if (action === 'reject') {
        const pending = getTelegramPendingRequests(config);
        const selected = await selectFromUsers(
          'Reject Telegram Request',
          pending,
          'There are no pending Telegram requests to reject.',
        );

        if (selected === 'back') {
          continue;
        }

        const request = pending.find((entry) => (entry.pairingCode || entry.userId.toString()) === selected);
        if (!request) {
          await channel.send('That Telegram request is no longer pending.', channelId);
          continue;
        }

        await this.handleChatCommand(`/telegram reject ${request.userId}`, 'cli', channelId);
        continue;
      }

      if (action === 'remove') {
        const approved = getTelegramApprovedUsers(config);
        const selected = await selectFromUsers(
          'Remove Telegram User',
          approved,
          'There are no approved Telegram users to remove.',
        );

        if (selected === 'back') {
          continue;
        }

        const user = approved.find((entry) => entry.userId.toString() === selected);
        if (!user) {
          await channel.send('That Telegram user is no longer approved.', channelId);
          continue;
        }

        await this.handleChatCommand(`/telegram remove ${user.userId}`, 'cli', channelId);
        continue;
      }

      if (action === 'promote') {
        const members = config.channels.telegram.members;
        const selected = await selectFromUsers(
          'Promote Telegram Member',
          members,
          'There are no Telegram members available to promote.',
        );

        if (selected === 'back') {
          continue;
        }

        const member = members.find((entry) => entry.userId.toString() === selected);
        if (!member) {
          await channel.send('That Telegram member is no longer available.', channelId);
          continue;
        }

        await this.handleChatCommand(`/telegram promote ${member.userId}`, 'cli', channelId);
        continue;
      }

      if (action === 'demote') {
        const admins = config.channels.telegram.admins;
        const selected = await selectFromUsers(
          'Demote Telegram Admin',
          admins,
          'There are no Telegram admins available to demote.',
        );

        if (selected === 'back') {
          continue;
        }

        const admin = admins.find((entry) => entry.userId.toString() === selected);
        if (!admin) {
          await channel.send('That Telegram admin is no longer available.', channelId);
          continue;
        }

        await this.handleChatCommand(`/telegram demote ${admin.userId}`, 'cli', channelId);
        continue;
      }

      if (action === 'reset') {
        const confirmation = await select('Reset Telegram Access?', [
          { value: 'cancel', label: 'Cancel' },
          { value: 'confirm', label: 'Reset all Telegram access' },
          { value: 'back', label: 'Back' },
        ]);

        if (confirmation === 'confirm') {
          clearTelegramAccess(config);
          saveConfig(config);
          await channel.send('Telegram access reset. New users can send /start to begin pairing again.', channelId);
        }

        continue;
      }
    }
  }
}
