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
      const provider = this.providers.getDefault();
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

      logger.info({ provider: provider.name, model: provider.getModel(), steps: MAX_STEPS }, 'Generating agentic response');

      const result = await generateText({
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

      const finalText = result.text;

      this.tokenBudget.recordUsage({
        provider: provider.name,
        model: provider.getModel(),
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
  }

  async shutdown(): Promise<void> {
    await this.sleep();
    logger.info('Mercury has shut down');
  }
}