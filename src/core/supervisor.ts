import type { MercuryConfig } from '../utils/config.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { Identity } from '../soul/identity.js';
import type { ShortTermMemory, LongTermMemory, EpisodicMemory } from '../memory/store.js';
import type { UserMemoryStore } from '../memory/user-memory.js';
import type { TokenBudget } from '../utils/tokens.js';
import type { CapabilityRegistry } from '../capabilities/registry.js';
import type { SubAgentConfig, SubAgentResult, SubAgentStatus, ResourceUsage } from '../types/agent.js';
import type { ChannelRegistry } from '../channels/registry.js';
import { SubAgent, type CommentCheckCallback, type PostCommentCallback } from './sub-agent.js';
import { FileLockManager } from './file-lock.js';
import { TaskBoard } from './task-board.js';
import { ResourceManager } from './resource-manager.js';
import { logger } from '../utils/logger.js';
import { deriveChildContext, type PermissionContext } from '../capabilities/permission-context.js';
import type { PermissionManager } from '../capabilities/permissions.js';

/** Bounded auto-resumes after a step-budget pause before reporting honestly. */
const MAX_SUBAGENT_STEP_RESUMES = 3;

export type NotifyCallback = (channelType: string, channelId: string, message: string) => Promise<void>;
export type AgentLifecycleCallback = (event: { type: 'progress' | 'complete'; agentId: string; progress?: string; result?: SubAgentResult }) => void;

export class SubAgentSupervisor {
  private activeAgents: Map<string, SubAgent> = new Map();
  private waitQueue: SubAgentConfig[] = [];
  private fileLockManager: FileLockManager;
  private taskBoard: TaskBoard;
  private resourceManager: ResourceManager;

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
  private saverMode?: import('./saver-mode.js').SaverMode;

  private notifyCallback?: NotifyCallback;
  private lifecycleCallbacks: AgentLifecycleCallback[] = [];
  private commentCheckCallback?: CommentCheckCallback;
  private postCommentCallback?: PostCommentCallback;
  private pausedAgents: Set<string> = new Set();
  /** Original configs by agent id — enables step-budget auto-resume. */
  private agentConfigs: Map<string, SubAgentConfig> = new Map();
  /** Bounded auto-resume counter for step-budget pauses, per agent. */
  private stepResumeCounts: Map<string, number> = new Map();
  private pauseResolvers: Map<string, () => void> = new Map();
  /**
   * Lineage: agent id → id of the sub-agent that delegated it (undefined for
   * agents spawned by the main agent or a user command). Kept after an agent
   * finishes so a grandchild's chain still resolves once its parent is gone.
   */
  private parents: Map<string, string | undefined> = new Map();

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

  /** Inject SaverMode so spawned sub-agents inherit the user's saver preferences. */
  setSaverMode(saver: import('./saver-mode.js').SaverMode): void {
    this.saverMode = saver;
  }

  setLifecycleCallback(cb: AgentLifecycleCallback): void {
    // Additive — don't overwrite previous callbacks
    this.lifecycleCallbacks.push(cb);
  }

  private fireLifecycleEvent(event: Parameters<AgentLifecycleCallback>[0]): void {
    for (const cb of this.lifecycleCallbacks) {
      try { cb(event); } catch (err) { logger.warn({ err }, 'supervisor lifecycle callback threw'); }
    }
  }

  setCommentCheckCallback(cb: CommentCheckCallback): void {
    this.commentCheckCallback = cb;
  }

  setPostCommentCallback(cb: PostCommentCallback): void {
    this.postCommentCallback = cb;
  }

  private async notify(channelType: string, channelId: string, message: string): Promise<void> {
    if (this.notifyCallback) {
      await this.notifyCallback(channelType, channelId, message);
    }
  }

  async spawn(config: Omit<SubAgentConfig, 'id'>): Promise<string> {
    const id = this.taskBoard.nextId();
    // Snapshot the spawning agent's permission context NOW (spawn runs inside
    // the caller's async context): a queued agent that starts later must not
    // pick up whatever the main agent's context is at that moment.
    const fullConfig: SubAgentConfig = {
      ...config,
      id,
      permissionContext: config.permissionContext ?? this.childPermissionContext(config),
    };
    this.parents.set(id, config.parentId);

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

  private childPermissionContext(config: Omit<SubAgentConfig, 'id'>): PermissionContext | undefined {
    const permissions = this.capabilities.permissions as Partial<PermissionManager> | undefined;
    if (typeof permissions?.currentContext !== 'function') return undefined;
    return deriveChildContext(permissions.currentContext(), {
      channelType: config.sourceChannelType,
      channelId: config.sourceChannelId,
      allowedTools: config.allowedTools,
    });
  }

  private startAgentInBackground(config: SubAgentConfig): void {
    this.agentConfigs.set(config.id, config);
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
      saverMode: this.saverMode,
      supervisor: this,
    });

    this.activeAgents.set(config.id, subAgent);

    subAgent.setProgressCallback((agentId, progress) => {
      this.taskBoard.update(agentId, { progress });
      this.fireLifecycleEvent({ type: 'progress', agentId, progress });

      const entry = this.taskBoard.get(agentId);
      if (entry) {
        const channelType = entry.sourceChannelType || 'cli';
        const channelId = entry.sourceChannelId || 'cli';
        this.notify(channelType, channelId, `🔄 Agent ${agentId}: ${progress}`).catch((e) => logger.warn({ e, agentId }, 'supervisor progress notify failed'));
      }
    });

    // Wire comment check so sub-agent can receive user feedback during execution
    if (this.commentCheckCallback) {
      subAgent.setCommentCheckCallback(this.commentCheckCallback);
    }
    if (this.postCommentCallback) {
      subAgent.setPostCommentCallback(this.postCommentCallback);
    }

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
      // Notify the user — they should never have to discover a crashed
      // sub-agent by re-prompting.
      const entry = this.taskBoard.get(config.id);
      if (entry) {
        const channelType = entry.sourceChannelType || 'cli';
        const channelId = entry.sourceChannelId || 'cli';
        const errMsg = err instanceof Error ? err.message : String(err);
        await this.notify(channelType, channelId,
          `❌ **Agent ${config.id}** crashed unexpectedly: "${entry.task.slice(0, 40)}"\nError: ${errMsg.slice(0, 150)}`,
        ).catch((e) => logger.warn({ e, agentId: config.id }, 'Failed to notify user of sub-agent crash'));
      }
      await this.processWaitQueue();
    });
  }

  private async onAgentComplete(agentId: string, result: SubAgentResult): Promise<void> {
    this.activeAgents.delete(agentId);
    this.fileLockManager.releaseAll(agentId);
    this.pausedAgents.delete(agentId);

    logger.info({ agentId, status: result.status, duration: result.duration }, 'Sub-agent completed');

    // Persist final token usage on the task board entry
    const totalTokens = (result.tokenUsage?.input ?? 0) + (result.tokenUsage?.output ?? 0);
    this.taskBoard.update(agentId, {
      tokenUsage: {
        input: result.tokenUsage?.input ?? 0,
        output: result.tokenUsage?.output ?? 0,
        total: totalTokens,
      },
    });

    this.fireLifecycleEvent({ type: 'complete', agentId, result });

    // Completion contract: a step-budget pause is resumable. Auto-resume once
    // with a fresh budget and a continuation prompt; past the bound, report
    // honestly instead of looping forever.
    if (result.status === 'paused') {
      const config = this.agentConfigs.get(agentId);
      const resumes = this.stepResumeCounts.get(agentId) ?? 0;
      if (config && resumes < MAX_SUBAGENT_STEP_RESUMES) {
        this.stepResumeCounts.set(agentId, resumes + 1);
        const entry = this.taskBoard.get(agentId);
        if (entry) {
          const channelType = entry.sourceChannelType || 'cli';
          const channelId = entry.sourceChannelId || 'cli';
          await this.notify(
            channelType,
            channelId,
            `⏳ **Agent ${agentId}** reached its step budget with work pending — resuming with a fresh budget (${resumes + 1}/${MAX_SUBAGENT_STEP_RESUMES})...`,
          ).catch((e) => logger.warn({ e, agentId }, 'Step-budget resume notify failed'));
          this.taskBoard.update(agentId, {
            status: 'running',
            progress: 'Resuming after step budget',
            completedAt: undefined,
          });
        }
        // Fresh SubAgent instance re-reads the preserved state from disk; the
        // continuation preamble points it at the remaining work.
        const resumedConfig: SubAgentConfig = {
          ...config,
          task: `${config.task}\n\n[SYSTEM: STEP-BUDGET RESUME] Your previous attempt reached its step budget. Work completed so far is preserved on disk. Resume the remaining work — inspect current state first, do not redo completed steps, and finish the task.`,
        };
        logger.info({ agentId, resumes: resumes + 1 }, 'Auto-resuming sub-agent after step-budget pause');
        this.startAgentInBackground(resumedConfig);
        return;
      }
      const entry = this.taskBoard.get(agentId);
      if (entry) {
        const channelType = entry.sourceChannelType || 'cli';
        const channelId = entry.sourceChannelId || 'cli';
        await this.notify(
          channelType,
          channelId,
          `⏸ **Agent ${agentId}** paused: "${entry.task.slice(0, 40)}" — step budget reached past the resume bound. Its partial work is preserved.`,
        ).catch((e) => logger.warn({ e, agentId }, 'Step-budget bound notify failed'));
      }
      await this.processWaitQueue();
      return;
    }

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
    while (this.waitQueue.length > 0) {
      const running = this.getRunningCount();
      if (running >= this.resourceManager.getMaxConcurrent()) break;

      const nextConfig = this.waitQueue.shift()!;
      this.taskBoard.update(nextConfig.id, { status: 'running', progress: 'Starting...' });
      this.startAgentInBackground(nextConfig);
    }
  }

  /** Id of the sub-agent that delegated `agentId`, if any. */
  getParentId(agentId: string): string | undefined {
    return this.parents.get(agentId);
  }

  /**
   * True when `agentId` sits strictly below `ancestorId` in the delegation
   * tree. The main agent is not an id, so callers representing it pass no
   * ancestor and own everything.
   */
  isDescendant(agentId: string, ancestorId: string): boolean {
    let current = this.parents.get(agentId);
    for (let depth = 0; current !== undefined && depth < 1000; depth++) {
      if (current === ancestorId) return true;
      current = this.parents.get(current);
    }
    return false;
  }

  /**
   * Halt one agent (running or queued). When `callerId` is given, the target
   * must be one of the caller's descendants — a sub-agent can never halt a
   * sibling or an ancestor (#74).
   */
  async halt(agentId: string, callerId?: string): Promise<boolean> {
    if (callerId !== undefined && !this.isDescendant(agentId, callerId)) {
      logger.warn({ agentId, callerId }, 'Cannot halt — agent is not a descendant of the caller');
      return false;
    }

    const agent = this.activeAgents.get(agentId);
    const queued = this.waitQueue.some(c => c.id === agentId);
    if (!agent && !queued) {
      logger.warn({ agentId }, 'Cannot halt — agent not found');
      return false;
    }

    agent?.abort();

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

  /**
   * Halt every agent, or — with `callerId` — only the caller's descendants.
   * Returns the ids that were signalled.
   */
  async haltAll(callerId?: string): Promise<string[]> {
    const owned = (id: string) => callerId === undefined || this.isDescendant(id, callerId);
    const halted: string[] = [];

    for (const [agentId, agent] of this.activeAgents.entries()) {
      if (!owned(agentId)) continue;
      agent.abort();
      halted.push(agentId);
    }

    const remaining: SubAgentConfig[] = [];
    for (const config of this.waitQueue) {
      if (!owned(config.id)) {
        remaining.push(config);
        continue;
      }
      this.taskBoard.update(config.id, {
        status: 'halted',
        completedAt: Date.now(),
        progress: 'Halted while queued',
      });
      halted.push(config.id);
    }
    this.waitQueue = remaining;
    return halted;
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
    // Only forget lineage for agents that are gone; a live subtree keeps its
    // chain so its stop_agent/list_agents stay confined.
    for (const id of [...this.parents.keys()]) {
      if (!this.activeAgents.has(id) && !this.waitQueue.some(c => c.id === id)) this.parents.delete(id);
    }
  }

  getResourceUsage(): ResourceUsage {
    return this.resourceManager.getResourceUsage(
      this.getRunningCount(),
      this.waitQueue.length,
      this.tokenBudget.getRemaining(),
    );
  }

  /**
   * Active and queued agents. With `ownerId`, only that sub-agent's
   * descendants are listed — a child never learns about its siblings.
   */
  getActiveAgents(ownerId?: string): Array<{ id: string; task: string; status: SubAgentStatus; progress?: string }> {
    const agents: Array<{ id: string; task: string; status: SubAgentStatus; progress?: string }> = [];
    const owned = (id: string) => ownerId === undefined || this.isDescendant(id, ownerId);

    for (const [id, agent] of this.activeAgents.entries()) {
      if (!owned(id)) continue;
      const entry = this.taskBoard.get(id);
      agents.push({
        id,
        task: agent.config.task,
        status: entry?.status || agent.getStatus(),
        progress: entry?.progress,
      });
    }

    for (const config of this.waitQueue) {
      if (!owned(config.id)) continue;
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
