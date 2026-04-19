import { generateText } from 'ai';
import type { ChannelMessage } from '../types/channel.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { Identity } from '../soul/identity.js';
import type { ShortTermMemory, LongTermMemory, EpisodicMemory } from '../memory/store.js';
import type { ChannelRegistry } from '../channels/registry.js';
import type { MercuryConfig } from '../utils/config.js';
import type { TokenBudget } from '../utils/tokens.js';
import type { CapabilityRegistry } from '../capabilities/registry.js';
import type { ScheduledTaskManifest } from './scheduler.js';
import { Lifecycle } from './lifecycle.js';
import { Scheduler } from './scheduler.js';
import { logger } from '../utils/logger.js';

const MAX_STEPS = 10;

export class Agent {
  readonly lifecycle: Lifecycle;
  readonly scheduler: Scheduler;
  readonly capabilities: CapabilityRegistry;
  private running = false;
  private messageQueue: ChannelMessage[] = [];
  private processing = false;

  constructor(
    private config: MercuryConfig,
    private providers: ProviderRegistry,
    private identity: Identity,
    private shortTerm: ShortTermMemory,
    private longTerm: LongTermMemory,
    private episodic: EpisodicMemory,
    private channels: ChannelRegistry,
    private tokenBudget: TokenBudget,
    capabilities: CapabilityRegistry,
    scheduler: Scheduler,
  ) {
    this.lifecycle = new Lifecycle();
    this.scheduler = scheduler;
    this.capabilities = capabilities;

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
    if (isInternal) {
      this.capabilities.permissions.setAutoApproveAll(true);
    }

    try {
      const trimmed = msg.content.trim();
      if (trimmed.startsWith('/budget')) {
        const subcommand = trimmed.slice('/budget'.length).trim();
        await this.handleBudgetCommand(subcommand || 'status', msg.channelType, msg.channelId);
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
      const relevantFacts = this.longTerm.search(msg.content, 3);

      const messages: any[] = [];

      if (relevantFacts.length > 0) {
        messages.push({
          role: 'user',
          content: 'Relevant facts from memory:\n' + relevantFacts.map(f => `- ${f.fact}`).join('\n'),
        });
        messages.push({ role: 'assistant', content: 'Noted. I\'ll use these facts.' });
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

      const fallbackIterator = this.providers.getFallbackIterator();
      let result: any = null;
      let usedProvider: { name: string; model: string } | null = null;
      let lastError: any = null;

      for (const provider of fallbackIterator) {
        try {
          logger.info({ provider: provider.name, model: provider.getModel(), steps: MAX_STEPS }, 'Generating agentic response');

          result = await generateText({
            model: provider.getModelInstance(),
            system: systemPrompt,
            messages,
            tools: this.capabilities.getTools(),
            maxSteps: MAX_STEPS,
            onStepFinish: async ({ toolCalls, text }) => {
              if (toolCalls && toolCalls.length > 0) {
                const names = toolCalls.map((tc: any) => tc.toolName).join(', ');
                logger.info({ tools: names }, 'Tool call step');
                if (channel && msg.channelType !== 'internal') {
                  await channel.send(`  [Using: ${names}]`, msg.channelId).catch(() => {});
                }
              }
            },
          });

          usedProvider = { name: provider.name, model: provider.getModel() };
          this.providers.markSuccess(provider.name);
          break;
        } catch (err: any) {
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

      const finalText = result.text;

      this.tokenBudget.recordUsage({
        provider: usedProvider!.name,
        model: usedProvider!.model,
        inputTokens: result.usage?.promptTokens ?? 0,
        outputTokens: result.usage?.completionTokens ?? 0,
        totalTokens: (result.usage?.promptTokens ?? 0) + (result.usage?.completionTokens ?? 0),
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
        tokenCount: (result.usage?.promptTokens ?? 0) + (result.usage?.completionTokens ?? 0),
      });

      this.episodic.record({
        type: 'message',
        summary: `User: ${msg.content.slice(0, 100)} | Agent: ${finalText.slice(0, 100)}`,
        channelType: msg.channelType,
      });

      if (msg.channelType !== 'internal') {
        this.extractFacts(msg.content, finalText).catch(err => {
          logger.warn({ err }, 'Fact extraction failed');
        });
      }

      if (channel && msg.channelType !== 'internal') {
        logger.info({ channelType: msg.channelType, targetId: msg.channelId }, 'Sending response');
        const elapsed = Date.now() - startTime;
        await channel.send(finalText, msg.channelId, elapsed);
      } else {
        logger.debug('Internal prompt processed, no channel response needed');
      }

      this.lifecycle.transition('idle');
    } catch (err) {
      logger.error({ err }, 'Error handling message');
      this.lifecycle.transition('idle');
    } finally {
      if (isInternal) {
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
    return prompt;
  }

  async processInternalPrompt(prompt: string, channelId?: string): Promise<void> {
    const syntheticMsg: ChannelMessage = {
      id: `internal-${Date.now().toString(36)}`,
      channelId: channelId || 'internal',
      channelType: 'internal',
      senderId: 'system',
      content: prompt,
      timestamp: Date.now(),
    };
    this.enqueueMessage(syntheticMsg);
  }

  private async handleScheduledTask(manifest: ScheduledTaskManifest): Promise<void> {
    logger.info({ task: manifest.id }, 'Processing scheduled task');
    try {
      let prompt = manifest.prompt || '';
      if (manifest.skillName) {
        const skillHint = `Invoke the skill "${manifest.skillName}" using the use_skill tool and follow its instructions.`;
        prompt = prompt ? `${prompt} ${skillHint}` : `Scheduled task triggered. ${skillHint}`;
      }
      if (!prompt) {
        prompt = `Execute scheduled task: ${manifest.description}`;
      }
      await this.processInternalPrompt(prompt);
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

  private async extractFacts(userMessage: string, agentResponse: string): Promise<void> {
    const trivial = /^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|bye|goodbye|good morning|good evening)\b/i;
    if (trivial.test(userMessage.trim())) return;

    if (!this.tokenBudget.canAfford(500)) return;

    try {
      const provider = this.providers.getDefault();
      const result = await generateText({
        model: provider.getModelInstance(),
        system: 'You are a fact extractor. Read the conversation below and extract 1-3 important facts worth remembering long-term. Output each fact on a separate line, prefixed with "- ". Only extract facts that are specific, factual, and not obvious. If nothing is worth remembering, output nothing.',
        messages: [
          { role: 'user', content: `User: ${userMessage}\nAssistant: ${agentResponse}` },
        ],
        maxTokens: 200,
      });

      const text = result.text.trim();
      if (!text) return;

      const facts = text
        .split('\n')
        .map(l => l.replace(/^-\s*/, '').trim())
        .filter(f => f.length > 10 && f.length < 200);

      const existing = this.longTerm.getAll();
      for (const fact of facts.slice(0, 3)) {
        const isDupe = existing.some(e =>
          e.fact.toLowerCase().includes(fact.toLowerCase().slice(0, 30))
        );
        if (!isDupe) {
          this.longTerm.add({
            topic: 'extracted',
            fact,
            source: 'conversation',
          });
          logger.info({ fact: fact.slice(0, 60) }, 'Fact extracted to long-term memory');
        }
      }

      this.tokenBudget.recordUsage({
        provider: provider.name,
        model: provider.getModel(),
        inputTokens: result.usage?.promptTokens ?? 0,
        outputTokens: result.usage?.completionTokens ?? 0,
        totalTokens: (result.usage?.promptTokens ?? 0) + (result.usage?.completionTokens ?? 0),
        channelType: 'internal',
      });
    } catch (err) {
      logger.warn({ err }, 'Fact extraction error');
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
}