import type { MercuryConfig } from '../utils/config.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { Identity } from '../soul/identity.js';
import type { ShortTermMemory, LongTermMemory, EpisodicMemory } from '../memory/store.js';
import type { UserMemoryStore } from '../memory/user-memory.js';
import type { TokenBudget } from '../utils/tokens.js';
import type { CapabilityRegistry } from '../capabilities/registry.js';
import type { SubAgentConfig, SubAgentResult, SubAgentStatus, ResourceUsage } from '../types/agent.js';
import type { ChannelRegistry } from '../channels/registry.js';
import { SubAgent } from './sub-agent.js';
import { FileLockManager } from './file-lock.js';
import { TaskBoard } from './task-board.js';
import { ResourceManager } from './resource-manager.js';
import { logger } from '../utils/logger.js';

export type NotifyCallback = (channelType: string, channelId: string, message: string) => Promise<void>;

export class SubAgentSupervisor {
  private activeAgents: Map<string, SubAgent> = new Map();
  private waitQueue: SubAgentConfig[] = [];
  private fileLockManager: FileLockManager;
  private taskBoard: TaskBoard;
  private resourceManager: ResourceManager;
  private scheduleLock = false;

  private agentConfig: MercuryConfig;
  private providers: ProviderRegistry;
  private identity: Identity;
  private shortTerm: ShortTermMemory;
  private longTerm: LongTermMemory;
  private episodic: EpisodicMemory;
  private userMemory: UserMemoryStore | null;
  private capabilities: CapabilityRegistry;
  private tokenBudget: TokenBudget;
  private channels: ChannelRegistry;

  private notifyCallback?: NotifyCallback;
  private pausedAgents: Set<string> = new Set();
  private pauseResolvers: Map<string, () => void> = new Map();

  constructor(
    dependencies: {
      agentConfig: MercuryConfig;
      providers: ProviderRegistry;
      identity: Identity;
      shortTerm: ShortTermMemory;
      longTerm: LongTermMemory;
      episodic: EpisodicMemory;
      userMemory: UserMemoryStore | null;
      capabilities: CapabilityRegistry;
      tokenBudget: TokenBudget;
      channels: ChannelRegistry;
    },
  ) {
    this.agentConfig = dependencies.agentConfig;
    this.providers = dependencies.providers;
    this.identity = dependencies.identity;
    this.shortTerm = dependencies.shortTerm;
    this.longTerm = dependencies.longTerm;
    this.episodic = dependencies.episodic;
    this.userMemory = dependencies.userMemory;
    this.capabilities = dependencies.capabilities;
    this.tokenBudget = dependencies.tokenBudget;
    this.channels = dependencies.channels;

    this.fileLockManager = new FileLockManager();
    this.taskBoard = new TaskBoard();
    this.taskBoard.load();
    this.resourceManager = new ResourceManager();
  }

  setNotifyCallback(cb: NotifyCallback): void {
    this.notifyCallback = cb;
  }

  private async notify(channelType: string, channelId: string, message: string): Promise<void> {
    if (this.notifyCallback) {
      await this.notifyCallback(channelType, channelId, message);
    }
  }

  async spawn(config: Omit<SubAgentConfig, 'id'>): Promise<string> {
    const id = this.taskBoard.nextId();
    const fullConfig: SubAgentConfig = { ...config, id };

    if (!this.resourceManager.canSpawn()) {
      logger.info({ task: config.task.slice(0, 50) }, 'No resources available, queuing sub-agent task');
      this.waitQueue.push(fullConfig);
      this.taskBoard.create({
        agentId: id,
        task: config.task,
        status: 'pending',
        priority: config.priority || 'normal',
        startedAt: Date.now(),
        filesLocked: [],
        progress: 'Queued — waiting for resources',
        sourceChannelId: config.sourceChannelId,
        sourceChannelType: config.sourceChannelType,
      });
      return id;
    }

    const running = this.getRunningCount();
    const max = this.resourceManager.getMaxConcurrent();
    if (running >= max) {
      logger.info({ task: config.task.slice(0, 50), running, max }, 'Max concurrent agents reached, queuing');
      this.waitQueue.push(fullConfig);
      this.taskBoard.create({
        agentId: id,
        task: config.task,
        status: 'pending',
        priority: config.priority || 'normal',
        startedAt: Date.now(),
        filesLocked: [],
        progress: 'Queued — waiting for slot',
        sourceChannelId: config.sourceChannelId,
        sourceChannelType: config.sourceChannelType,
      });
      return id;
    }

    this.taskBoard.create({
      agentId: id,
      task: config.task,
      status: 'pending',
      priority: config.priority || 'normal',
      startedAt: Date.now(),
      filesLocked: [],
      progress: 'Initializing...',
      sourceChannelId: config.sourceChannelId,
      sourceChannelType: config.sourceChannelType,
    });

    this.startAgentInBackground(fullConfig);
    return id;
  }

  private startAgentInBackground(config: SubAgentConfig): void {
    const subAgent = new SubAgent(config, {
      agentConfig: this.agentConfig,
      providers: this.providers,
      identity: this.identity,
      shortTerm: this.shortTerm,
      longTerm: this.longTerm,
      episodic: this.episodic,
      userMemory: this.userMemory,
      capabilities: this.capabilities,
      tokenBudget: this.tokenBudget,
      fileLockManager: this.fileLockManager,
      taskBoard: this.taskBoard,
    });

    this.activeAgents.set(config.id, subAgent);

    subAgent.setProgressCallback((agentId, progress) => {
      this.taskBoard.update(agentId, { progress });

      const entry = this.taskBoard.get(agentId);
      if (entry) {
        const channelType = entry.sourceChannelType || 'cli';
        const channelId = entry.sourceChannelId || 'cli';
        this.notify(channelType, channelId, `🔄 Agent ${agentId}: ${progress}`).catch(() => {});
      }
    });

    logger.info({ agentId: config.id, task: config.task.slice(0, 60) }, 'Starting sub-agent');

    subAgent.run().then(async (result) => {
      await this.onAgentComplete(config.id, result);
    }).catch(async (err) => {
      logger.error({ agentId: config.id, err }, 'Sub-agent threw unexpected error');
      this.taskBoard.update(config.id, {
        status: 'failed',
        completedAt: Date.now(),
        error: String(err),
        progress: 'Failed unexpectedly',
      });
      this.activeAgents.delete(config.id);
      this.fileLockManager.releaseAll(config.id);
      this.pausedAgents.delete(config.id);
      this.scheduleLock = false;
      await this.processWaitQueue();
    });
  }

  private async onAgentComplete(agentId: string, result: SubAgentResult): Promise<void> {
    this.activeAgents.delete(agentId);
    this.fileLockManager.releaseAll(agentId);
    this.pausedAgents.delete(agentId);

    logger.info({ agentId, status: result.status, duration: result.duration }, 'Sub-agent completed');

    const entry = this.taskBoard.get(agentId);
    if (entry) {
      const channelType = entry.sourceChannelType || 'cli';
      const channelId = entry.sourceChannelId || 'cli';

      if (result.status === 'completed') {
        const duration = result.duration ? `${(result.duration / 1000).toFixed(1)}s` : 'unknown';
        const output = result.output.length > 500 ? result.output.slice(0, 500) + '...' : result.output;
        await this.notify(channelType, channelId, `✅ **Agent ${agentId}** completed (${duration}): "${entry.task.slice(0, 40)}"\n\n${output}\n\nType a message to continue.`);
      } else if (result.status === 'halted') {
        await this.notify(channelType, channelId, `⛔ **Agent ${agentId}** halted: "${entry.task.slice(0, 40)}"`);
      } else if (result.status === 'failed') {
        await this.notify(channelType, channelId, `❌ **Agent ${agentId}** failed: "${entry.task.slice(0, 40)}"\nError: ${result.error || 'unknown'}`);
      }
    }

    await this.processWaitQueue();
  }

  private async processWaitQueue(): Promise<void> {
    if (this.scheduleLock) return;
    this.scheduleLock = true;
    try {
      while (this.waitQueue.length > 0) {
        const running = this.getRunningCount();
        if (running >= this.resourceManager.getMaxConcurrent()) break;

        const nextConfig = this.waitQueue.shift()!;
        this.taskBoard.update(nextConfig.id, { status: 'running', progress: 'Starting...' });
        this.startAgentInBackground(nextConfig);
      }
    } finally {
      this.scheduleLock = false;
    }
  }

  async halt(agentId: string): Promise<boolean> {
    const agent = this.activeAgents.get(agentId);
    if (!agent) {
      logger.warn({ agentId }, 'Cannot halt — agent not found');
      return false;
    }

    agent.abort();

    this.waitQueue = this.waitQueue.filter(c => c.id !== agentId);

    const entry = this.taskBoard.get(agentId);
    if (entry && entry.status === 'pending') {
      this.taskBoard.update(agentId, {
        status: 'halted',
        completedAt: Date.now(),
        progress: 'Halted while queued',
      });
    }

    return true;
  }

  async haltAll(): Promise<void> {
    for (const [agentId, agent] of this.activeAgents.entries()) {
      agent.abort();
    }

    for (const config of this.waitQueue) {
      this.taskBoard.update(config.id, {
        status: 'halted',
        completedAt: Date.now(),
        progress: 'Halted while queued',
      });
    }
    this.waitQueue = [];
  }

  async pause(agentId: string): Promise<boolean> {
    const agent = this.activeAgents.get(agentId);
    if (!agent) return false;

    this.pausedAgents.add(agentId);
    this.taskBoard.update(agentId, { status: 'paused', progress: 'Paused — waiting to resume' });

    logger.info({ agentId }, 'Sub-agent paused (will stop after current step)');
    return true;
  }

  async resume(agentId: string): Promise<boolean> {
    if (!this.pausedAgents.has(agentId)) return false;

    this.pausedAgents.delete(agentId);
    this.taskBoard.update(agentId, { status: 'running', progress: 'Resumed' });

    const resolve = this.pauseResolvers.get(agentId);
    if (resolve) {
      resolve();
      this.pauseResolvers.delete(agentId);
    }

    logger.info({ agentId }, 'Sub-agent resumed');
    return true;
  }

  clearTaskBoard(): void {
    this.fileLockManager.clearAll();
    this.taskBoard.clear();
  }

  getResourceUsage(): ResourceUsage {
    return this.resourceManager.getResourceUsage(
      this.getRunningCount(),
      this.waitQueue.length,
      this.tokenBudget.getRemaining(),
    );
  }

  getActiveAgents(): Array<{ id: string; task: string; status: SubAgentStatus; progress?: string }> {
    const agents: Array<{ id: string; task: string; status: SubAgentStatus; progress?: string }> = [];

    for (const [id, agent] of this.activeAgents.entries()) {
      const entry = this.taskBoard.get(id);
      agents.push({
        id,
        task: agent.config.task,
        status: entry?.status || agent.getStatus(),
        progress: entry?.progress,
      });
    }

    for (const config of this.waitQueue) {
      agents.push({
        id: config.id,
        task: config.task,
        status: 'pending',
        progress: 'Queued',
      });
    }

    return agents;
  }

  getTaskBoard(): TaskBoard {
    return this.taskBoard;
  }

  getFileLockManager(): FileLockManager {
    return this.fileLockManager;
  }

  getResourceManager(): ResourceManager {
    return this.resourceManager;
  }

  setMaxConcurrent(n: number): void {
    this.resourceManager.setMaxConcurrent(n);
  }

  clearMaxConcurrentOverride(): void {
    this.resourceManager.clearOverride();
  }

  private getRunningCount(): number {
    let count = 0;
    for (const agent of this.activeAgents.values()) {
      const status = agent.getStatus();
      if (status === 'running' || status === 'paused') count++;
    }
    return count;
  }
}