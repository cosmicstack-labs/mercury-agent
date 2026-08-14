import { generateText, streamText, stepCountIs } from 'ai';
import path from 'node:path';
import { existsSync } from 'node:fs';
import type { ChannelMessage, ChannelType } from '../types/channel.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { Identity } from '../soul/identity.js';
import type { ShortTermMemory, LongTermMemory, EpisodicMemory } from '../memory/store.js';
import type { UserMemoryStore } from '../memory/user-memory.js';
import type { ChannelRegistry } from '../channels/registry.js';
import type { MercuryConfig, ProviderName } from '../utils/config.js';
import type { TokenBudget } from '../utils/tokens.js';
import type { CapabilityRegistry } from '../capabilities/registry.js';
import type { ScheduledTaskManifest } from './scheduler.js';
import { DeepSeekProvider } from '../providers/deepseek.js';
import { createProvider, ProviderRegistry as ProviderRegistryImpl } from '../providers/registry.js';
import type { BaseProvider } from '../providers/base.js';
import { Lifecycle } from './lifecycle.js';
import { Scheduler } from './scheduler.js';
import { ProgrammingMode } from './programming-mode.js';
import { ResearchMode } from './research-mode.js';
import { SaverMode, NORMAL_HISTORY_WINDOW } from './saver-mode.js';
import { BackgroundTaskManager } from './background-tasks.js';
import { SkillBatcher } from '../skills/batcher.js';
import type { SkillLoader } from '../skills/loader.js';
import { logger } from '../utils/logger.js';
import { CLIChannel } from '../channels/cli.js';
import { TelegramChannel } from '../channels/telegram.js';
import { SignalChannel } from '../channels/signal.js';
import { DiscordChannel } from '../channels/discord.js';
import { SlackChannel } from '../channels/slack.js';
import { formatToolStep, formatNarrative, type NarrativeStep } from '../utils/tool-label.js';
import { getTelegramHelp, getDiscordHelp, getSlackHelp } from '../utils/manual.js';
import { WebChannel } from '../channels/web.js';
import type { ArrowSelectOption } from '../utils/arrow-select.js';
import { setAskUserHandler } from '../capabilities/interaction/ask-user.js';
import type { SpotifyClient } from '../spotify/client.js';
import { normalizeGeneratedSessionTitle, SessionResolutionError, type SessionRepository } from '../sessions/index.js';
import { PLAYER_CONTROLS, handlePlayerAction, formatNowPlaying } from '../spotify/ui.js';
import { getCloudTokenStore } from '../cloud/token-store.js';
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
  loadConfig,
  getActiveProviders,
  getDiscordAccessSummary,
  hasDiscordAdmins,
  findDiscordPendingRequest,
  approveDiscordPendingRequest,
  approveDiscordPendingRequestByPairingCode,
  rejectDiscordPendingRequest as rejectDiscordPendingRequestConfig,
  removeDiscordUser,
  clearDiscordAccess,
  getSlackAccessSummary,
  hasSlackAdmins,
  findSlackPendingRequest,
  approveSlackPendingRequest,
  approveSlackPendingRequestByPairingCode,
  rejectSlackPendingRequest as rejectSlackPendingRequestConfig,
  removeSlackUser,
  clearSlackAccess,
} from '../utils/config.js';
import { fetchProviderModelCatalog, getPreferredModelsForProvider } from '../utils/provider-models.js';
import { WorkLedger, type WorkEntry } from './work-ledger.js';
import { MAX_PROVIDER_ATTEMPT_MS, needsContinuationApproval, needsRetryApproval, withAbortDeadline } from './execution-limits.js';
import { requiresFinalSend } from './response-delivery.js';
import { updateCliProviderStatus } from './provider-status.js';

class ToolCallLoopDetector {
  private recentCalls: Array<{ tool: string; params: string; failed: boolean; timestamp: number }> = [];
  private totalCalls = 0;
  private hardAborted = false;
  private recentStepTexts: Array<string> = [];
  private consecutiveNoActionSteps = 0;

  // --- Limits ---
  private static readonly ABSOLUTE_MAX = 75;
  private static readonly FAILED_ABSOLUTE_MAX = 20;
  private static readonly NO_ACTION_MAX = 6;

  // Tools that naturally repeat in productive work
  private static readonly HIGH_TOLERANCE_TOOLS = new Set([
    'fetch_url', 'read_file', 'list_dir', 'web_search', 'github_api',
    'run_command', 'edit_file', 'write_file', 'create_file',
    'git_status', 'git_diff', 'git_log',
  ]);

  // --- Thresholds ---
  // Identical = same tool + same params (always a true loop)
  private static readonly IDENTICAL_THRESHOLD = 4;
  // Similar = same tool, all failing
  private static readonly SIMILAR_THRESHOLD = 6;
  // Text repetition in model output
  private static readonly TEXT_REPEAT_THRESHOLD = 4;
  private static readonly MAX_STEP_TEXTS = 15;

  record(toolName: string, params: Record<string, any>, failed: boolean = false): void {
    const paramsKey = JSON.stringify(params).slice(0, 300);
    this.recentCalls.push({ tool: toolName, params: paramsKey, failed, timestamp: Date.now() });
    this.totalCalls++;
    this.consecutiveNoActionSteps = 0;
    if (this.recentCalls.length > 40) {
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

  /**
   * Identical loop: same tool + exact same params repeated.
   * This is always a true stuck loop — no productive work produces identical calls.
   */
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
        message: `Identical call detected: "${last.tool}" called ${identicalCount}x with the exact same parameters.`,
      };
    }
    return null;
  }

  /**
   * Failing loop: same tool called repeatedly, all calls failing.
   * Different params but consistently failing = stuck on a broken approach.
   */
  detectSimilarLoop(): { tool: string; count: number; message: string } | null {
    if (this.recentCalls.length < 4) return null;
    const last = this.recentCalls[this.recentCalls.length - 1];
    let failCount = 0;
    for (let i = this.recentCalls.length - 1; i >= 0; i--) {
      const call = this.recentCalls[i];
      if (call.tool !== last.tool) break;
      if (call.failed) failCount++;
      else break;
    }
    if (failCount >= ToolCallLoopDetector.SIMILAR_THRESHOLD) {
      this.hardAborted = true;
      return {
        tool: last.tool,
        count: failCount,
        message: `Failing loop: "${last.tool}" called ${failCount}x, all failing.`,
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
      if (this.textSimilarity(last, texts[i]) >= 0.7) repeatCount++;
      else break;
    }
    if (repeatCount >= ToolCallLoopDetector.TEXT_REPEAT_THRESHOLD) {
      return { pattern: last.slice(0, 60), count: repeatCount };
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

  /**
   * Smart repetition analysis: detects same-tool runs but evaluates whether
   * the work is productive based on parameter diversity and success rate.
   *
   * Returns null if no concern, or an analysis object with:
   * - tool, count: what's repeating
   * - paramDiversity: 0-1, how varied the parameters are (1 = all unique)
   * - successRate: 0-1, fraction of calls that succeeded
   * - verdict: 'productive' | 'suspicious' | 'stuck'
   */
  analyzeRepetition(): {
    tool: string;
    count: number;
    paramDiversity: number;
    successRate: number;
    verdict: 'productive' | 'suspicious' | 'stuck';
  } | null {
    if (this.recentCalls.length < 5) return null;

    // Find the consecutive run of the same tool
    const last = this.recentCalls[this.recentCalls.length - 1];
    const run: typeof this.recentCalls = [];
    for (let i = this.recentCalls.length - 1; i >= 0; i--) {
      if (this.recentCalls[i].tool === last.tool) run.unshift(this.recentCalls[i]);
      else break;
    }

    // Need a meaningful run length to analyze
    const isHigh = ToolCallLoopDetector.HIGH_TOLERANCE_TOOLS.has(last.tool);
    const minRun = isHigh ? 10 : 6;
    if (run.length < minRun) return null;

    // Parameter diversity: how many unique param sets vs total calls
    const uniqueParams = new Set(run.map(c => c.params));
    const paramDiversity = uniqueParams.size / run.length;

    // Success rate
    const successes = run.filter(c => !c.failed).length;
    const successRate = successes / run.length;

    // Verdict logic
    let verdict: 'productive' | 'suspicious' | 'stuck';
    if (paramDiversity >= 0.6 && successRate >= 0.7) {
      // High diversity + mostly succeeding = productive iteration
      // e.g., fetching 20 different URLs, reading 15 different files
      verdict = 'productive';
    } else if (successRate < 0.3) {
      // Mostly failing = stuck
      verdict = 'stuck';
    } else if (paramDiversity < 0.2 && successRate < 0.5) {
      // Low diversity + mediocre success = suspicious
      verdict = 'stuck';
    } else if (paramDiversity < 0.3) {
      // Low diversity but succeeding — suspicious (might be retrying similar things)
      verdict = 'suspicious';
    } else {
      // Moderate diversity, moderate success — let it run but flag
      verdict = 'suspicious';
    }

    return {
      tool: last.tool,
      count: run.length,
      paramDiversity,
      successRate,
      verdict,
    };
  }

  isHardAborted(): boolean {
    return this.hardAborted;
  }

  /** Return human-readable summaries of recent calls for AI self-check */
  getRecentCallSummaries(): string[] {
    return this.recentCalls.slice(-10).map(c => {
      const params = c.params.length > 100 ? c.params.slice(0, 97) + '...' : c.params;
      return `${c.tool}(${params})${c.failed ? ' [FAILED]' : ' [OK]'}`;
    });
  }

  /** Reset all loop detection state */
  reset(): void {
    this.recentCalls = [];
    this.totalCalls = 0;
    this.hardAborted = false;
    this.recentStepTexts = [];
    this.consecutiveNoActionSteps = 0;
  }
}

const MAX_STEPS = 75;
const MAX_RESPONSE_TOKENS = 4096;
const HEARTBEAT_INITIAL_MS = 20000;
const HEARTBEAT_MAX_MS = 60000;
const LONG_TASK_HANDOFF_SUGGEST_MS = 45000;
const MAX_STALL_MS = 4 * 60 * 1000;
const MAX_SELF_CHECKS = 3; // max AI self-checks per request before hard-aborting

/**
 * Heuristic: does this message look like a deep-research request that would
 * benefit from full research mode? Conservative — false negatives just fall
 * through to a normal answer, so we prefer specificity over recall.
 */
function looksResearchy(text: string): boolean {
  const t = text.toLowerCase();
  if (t.length < 24) return false; // too short to be a research question
  if (t.startsWith('/')) return false;

  // Temporal / event research signals
  const temporal = /\b(happened|occurr?ed|took place|what (did|do) .* (say|report|find)|recent|last (week|month|year|few)|(\d+)\s*(days?|weeks?|months?|years?) (ago|back|earlier)|today'?s news|this week|this month|this year)\b/;
  // Deep / comparative / explain signals
  const deep = /\b(research|investigate|deep dive|in[- ]depth|explain in detail|comprehensive (guide|overview|analysis)|compare (and )?contrast|state of|history of|causes? of|impact of|effects? of|timeline of|breakdown of|everything about)\b/;
  // Factual lookup signals
  const factual = /\b(latest|current state|what is .* (situation|status)|what are the (options|alternatives|risks|benefits))\b/;

  return temporal.test(t) || deep.test(t) || factual.test(t);
}

export class Agent {
  readonly lifecycle: Lifecycle;
  readonly scheduler: Scheduler;
  readonly capabilities: CapabilityRegistry;
  private running = false;
  private messageQueue: Array<{ message: ChannelMessage; workKey?: string }> = [];
  private queuedWorkKeys = new Set<string>();
  private processing = false;
  private telegramStreaming: boolean;
  private currentMessage: ChannelMessage | null = null;
  private currentAbort: AbortController | null = null;
  private currentAbortReason: 'stalled' | 'time-limit' | 'backgrounded' | 'stopped' | 'halted' | null = null;
  private lastProgressAt = 0;
  private currentActivity = '';
  private completedStepCount = 0;
  private stepNarrative: import('../utils/tool-label.js').NarrativeStep[] = [];
  private supervisor?: import('../core/supervisor.js').SubAgentSupervisor;
  readonly programmingMode: ProgrammingMode;
  readonly researchMode: ResearchMode;
  readonly saverMode: SaverMode;
  private spotifyClient?: SpotifyClient;
  private skillBatcher: SkillBatcher | null = null;
  private skillLoader?: SkillLoader;
  readonly backgroundTasks: BackgroundTaskManager;
  private titleGenerationInFlight = new Set<string>();
  private sessionSyncEnabled = false;
  private readonly workLedger: WorkLedger;
  private currentWorkKey: string | null = null;
  private outboxRetryTimer: ReturnType<typeof setInterval> | null = null;
  private replayingOutbox = false;

  constructor(
    private config: MercuryConfig,
    private providers: ProviderRegistry,
    private identity: Identity,
    private shortTerm: ShortTermMemory,
    private longTerm: LongTermMemory,
    private episodic: EpisodicMemory,
    private userMemory: UserMemoryStore | null,
    private channels: ChannelRegistry,
    private tokenBudget: TokenBudget,
    capabilities: CapabilityRegistry,
    scheduler: Scheduler,
    private sessions: SessionRepository,
    private generateTitle?: (input: { userMessage: string; assistantMessage: string; providerName: string }) => Promise<string>,
  ) {
    this.lifecycle = new Lifecycle();
    this.scheduler = scheduler;
    this.capabilities = capabilities;
    this.telegramStreaming = config.channels.telegram.streaming ?? true;
    this.programmingMode = new ProgrammingMode();
    this.researchMode = new ResearchMode();
    this.saverMode = new SaverMode(config);
    this.wireResearchModeToCapabilities();
    this.backgroundTasks = new BackgroundTaskManager();
    this.workLedger = new WorkLedger();

    this.backgroundTasks.onGlobalComplete((task) => {
      this.notifyBackgroundTaskComplete(task);
    });

    this.scheduler.setOnScheduledTask(async (manifest) => this.handleScheduledTask(manifest));

    this.channels.onIncomingMessage((msg) => this.enqueueMessage(msg));

    this.scheduler.onHeartbeat(async () => {
      await this.heartbeat();
    });

    setAskUserHandler(async (question, choices, channelId, channelType) => {
      return this.presentChoice(question, choices, channelId, channelType);
    });
  }

  setSkillLoader(skillLoader: SkillLoader): void {
    this.skillLoader = skillLoader;
    if (this.supervisor) {
      this.skillBatcher = new SkillBatcher(this.supervisor, this.backgroundTasks);
    }
  }

  setSessionSyncEnabled(enabled: boolean): void {
    this.sessionSyncEnabled = enabled;
  }

  isSessionSyncEnabled(): boolean {
    return this.sessionSyncEnabled;
  }

  acknowledgeCloudDelivery(requestId: string): void {
    const key = `request:${requestId}`;
    if (this.workLedger.get(key)) this.workLedger.markDelivered(key);
  }

  private wireResearchModeToCapabilities(): void {
    this.capabilities.setResearchModeGetter(() => this.researchMode.isActive());
  }

  setSupervisor(supervisor: import('../core/supervisor.js').SubAgentSupervisor): void {
    this.supervisor = supervisor;
    if (this.skillLoader) {
      this.skillBatcher = new SkillBatcher(supervisor, this.backgroundTasks);
    }
    supervisor.setSaverMode(this.saverMode);
    supervisor.setNotifyCallback(async (channelType, channelId, message) => {
      const channel = this.channels.get(channelType as any);
      if (channel) {
        await channel.send(message, channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
      }
    });
    supervisor.setLifecycleCallback((event) => {
      const bgTask = this.backgroundTasks.getByAgentId(event.agentId);
      if (!bgTask) return;

      if (event.type === 'progress' && event.progress) {
        this.backgroundTasks.updateAgentProgress(bgTask.id, event.progress);
        this.syncBgTasksToTui();
        return;
      }

      if (event.type === 'complete' && event.result) {
        const result = event.result;
        const status = result.status === 'completed' ? 'completed' : result.status === 'halted' ? 'cancelled' : 'failed';
        this.backgroundTasks.completeAgentTask(bgTask.id, status === 'completed' ? 0 : 1, status, result.output);
        this.syncBgTasksToTui();
      }
    });
  }

  private enqueueMessage(msg: ChannelMessage): void {
    logger.info({ from: msg.channelType, content: msg.content.slice(0, 50) }, 'Message enqueued');

    const trimmed = msg.content.trim();

    if (this.processing && trimmed.startsWith('/')) {
      this.handleFastPathCommand(msg).catch((err) => {
        logger.error({ err, content: trimmed.slice(0, 50) }, 'Fast-path command failed');
      });
      return;
    }

    let workKey: string | undefined;
    if (!trimmed.startsWith('/')) {
      msg.metadata = {
        ...msg.metadata,
        workCwd: typeof msg.metadata?.workCwd === 'string' ? msg.metadata.workCwd : this.capabilities.getCwd(),
      };
      const accepted = this.workLedger.accept(msg);
      workKey = accepted.entry.key;
      if (!accepted.accepted) {
        void this.handleDuplicateWork(accepted.entry);
        return;
      }
    }

    // Research-y message prompt: when research mode is off and the message looks
    // like a deep-research request, ask whether to run a full research pass.
    const isUserMessage = msg.channelType !== 'internal' && msg.senderId !== 'system' && !trimmed.startsWith('/');
    if (isUserMessage && !this.researchMode.isActive() && looksResearchy(trimmed)) {
      this.promptResearchMode(msg, workKey).catch((err) => {
        logger.warn({ err: err.message }, 'Research-mode prompt failed — proceeding with normal message');
        this.queueMessage(msg, workKey);
        this.processQueue();
      });
      return;
    }

    this.queueMessage(msg, workKey);
    this.processQueue();
  }

  private queueMessage(message: ChannelMessage, workKey?: string): void {
    if (workKey && this.queuedWorkKeys.has(workKey)) return;
    this.messageQueue.push({ message, workKey });
    if (workKey) this.queuedWorkKeys.add(workKey);
  }

  private async handleDuplicateWork(entry: WorkEntry): Promise<void> {
    if (entry.status === 'completed' && !entry.delivered && entry.finalResponse) {
      await this.deliverLedgerEntry(entry);
      return;
    }
    const channel = this.channels.getChannelForMessage(entry.message);
    if (!channel || entry.message.channelType === 'internal') return;
    // For the web (Cloud chat) channel, don't send duplicate-status messages
    // to the user. The Cloud dashboard already handles dedup on its end, and
    // sending "This request is already running" creates a bad UX — the user
    // sees a confusing system message instead of silence.
    if (entry.message.channelType === 'web') return;
    const status = entry.status === 'completed'
      ? 'This request already completed and its result was delivered.'
      : entry.status === 'failed'
        ? `This request previously failed: ${entry.error || 'unknown error'}`
        : `This request is already ${entry.status}${entry.attempts > 0 ? ` (attempt ${entry.attempts})` : ''}.`;
    await channel.send(status, entry.message.channelId).catch((error) => {
      logger.warn({ error, workKey: entry.key }, 'Unable to send duplicate work status');
    });
  }

  private async promptResearchMode(msg: ChannelMessage, workKey?: string): Promise<void> {
    const channel = this.channels.getChannelForMessage(msg);
    if (!channel) {
      this.queueMessage(msg, workKey);
      this.processQueue();
      return;
    }

    const explanation =
      'Research mode will search the web, cross-check multiple sources, gather images, and produce a full research article as rich markdown. It runs longer than a quick answer and will not be killed early.';

    const choice = await this.presentChoice(
      `This looks like a research question. ${explanation}\n\nHow do you want to proceed?`,
      ['Full research mode (deep, multi-source article)', 'Quick answer (normal conversation)'],
      msg.channelId,
      msg.channelType,
    );

    if (choice.toLowerCase().startsWith('full')) {
      this.researchMode.setOn(msg.content.trim().slice(0, 120));
      if (channel instanceof WebChannel) {
        channel.sendHeartbeat('Research mode: On. Gathering sources and building the article now — this may take a while.', msg.channelId);
      } else {
        await channel.send('Research mode: **On**. Gathering sources and building the article now — this may take a while.', msg.channelId).catch(() => {});
      }
    }
    this.queueMessage(msg, workKey);
    this.processQueue();
  }

  private async handleFastPathCommand(msg: ChannelMessage): Promise<void> {
    const trimmed = msg.content.trim();
    const channel = this.channels.getChannelForMessage(msg);
    if (!channel) return;

    const activeAgents = this.supervisor ? this.supervisor.getActiveAgents() : [];
    const hasActiveAgents = activeAgents.length > 0;
    const busyPrefix = hasActiveAgents ? '' : '';

    if (trimmed === '/sessions' || trimmed.startsWith('/session')) {
      await this.handleSessionCommand(trimmed, msg.channelType, msg.channelId);
      return;
    }

    if (trimmed === '/agents' || trimmed === '/status') {
      if (this.supervisor) {
        const agents = this.supervisor.getActiveAgents();
        if (agents.length === 0) {
          await channel.send('No active sub-agents.', msg.channelId);
        } else {
          let text = '**Sub-Agents:**\n\n';
          for (const a of agents) {
            const icon = a.status === 'running' ? '🔄' : a.status === 'pending' ? '⏳' : a.status === 'completed' ? '✅' : '❌';
            text += `${icon} **${a.id}**: ${a.task.slice(0, 60)}${a.task.length > 60 ? '...' : ''} — ${a.status}${a.progress ? ` (${a.progress})` : ''}\n`;
          }
          await channel.send(text, msg.channelId);
        }
      } else {
        await channel.send('Sub-agents not enabled.', msg.channelId);
      }
      return;
    }

    if (trimmed === '/halt' || trimmed === '/stop') {
      if (this.currentAbort && !this.currentAbort.signal.aborted) {
        this.currentAbortReason = trimmed === '/stop' ? 'stopped' : 'halted';
        this.currentAbort.abort();
      }
      if (this.supervisor) {
        await this.supervisor.haltAll();
        if (trimmed === '/stop') {
          this.supervisor.clearTaskBoard();
        }
        await channel.send(trimmed === '/halt' ? 'All sub-agents halted.' : 'All agents stopped, locks released, task board cleared.', msg.channelId);
      } else {
        await channel.send(trimmed === '/halt' ? 'Foreground task halted.' : 'Foreground task stopped, locks released, task board cleared.', msg.channelId);
      }
      return;
    }

    if (trimmed.startsWith('/bg')) {
      await this.handleBgCommand(trimmed, msg, channel);
      return;
    }

    if (trimmed === '/progress' || trimmed === '/still') {
      if (!this.processing || !this.currentMessage) {
        await channel.send('No active foreground task.', msg.channelId);
        return;
      }
      const elapsedSec = Math.round((Date.now() - this.currentMessage.timestamp) / 1000);
      const stepInfo = this.completedStepCount > 0 ? ` · step ${this.completedStepCount}/${MAX_STEPS}` : '';
      const narrative = formatNarrative(this.stepNarrative, this.currentActivity, 10);
      const narrativeBlock = narrative ? `\n${narrative}` : '';
      await channel.send(
        `⏳ Task in progress (${elapsedSec}s${stepInfo})${narrativeBlock}\nUse /bg current to move it to background.`,
        msg.channelId,
      );
      return;
    }

    if (trimmed === '/help') {
      await channel.send('Agent is busy. Available: /sessions, /session, /agents, /halt, /stop, /progress, /spotify, /code, /research, /memory, /bg', msg.channelId);
      return;
    }

    if (trimmed.startsWith('/spotify')) {
      await this.handleFastPathSpotify(trimmed, msg, channel);
      return;
    }

    if (trimmed.startsWith('/code')) {
      await this.handleFastPathCode(trimmed, msg, channel);
      return;
    }

    if (trimmed === '/memory') {
      await channel.send('Agent is busy. Memory management will be available after current task completes.', msg.channelId);
      return;
    }

    if (hasActiveAgents) {
      const agentList = activeAgents.map(a => `**${a.id}**: ${a.task.slice(0, 40)}`).join(', ');
      await channel.send(`I'm busy working on sub-agent tasks (${agentList}). Your message has been queued — I'll respond once I'm free. Use /agents to check status.`, msg.channelId);
    } else {
      const elapsedSec = this.currentMessage ? Math.round((Date.now() - this.currentMessage.timestamp) / 1000) : 0;
      await channel.send(`I'm busy processing${elapsedSec > 0 ? ` (${elapsedSec}s elapsed)` : ''}. Use /progress for live status or /bg current to move this task to the background.`, msg.channelId);
    }

    this.queueMessage(msg);
  }

  private async handleFastPathSpotify(trimmed: string, msg: ChannelMessage, channel: any): Promise<void> {
    if (!this.spotifyClient) {
      await channel.send('Spotify is not connected.', msg.channelId);
      return;
    }
    const rawArgs = trimmed.slice('/spotify'.length).trim().toLowerCase();
    if (!rawArgs || rawArgs === 'status') {
      const auth = this.spotifyClient.isAuthenticated() ? 'Connected' : 'Not connected';
      const accountName = this.spotifyClient.getAccountName();
      const product = this.spotifyClient.getProduct();
      let status = `Spotify: **${auth}**`;
      if (accountName) status += `\nAccount: **${accountName}**`;
      if (product) status += `\nPlan: ${product}`;
      status += `\nDevice: ${this.spotifyClient.getDeviceId() || 'none selected'}`;
      await channel.send(status, msg.channelId);
      return;
    }
    if (rawArgs === 'logout') {
      this.spotifyClient.logout();
      await channel.send('Spotify disconnected. Run `/spotify auth` to reconnect.', msg.channelId);
      return;
    }
    if (rawArgs === 'now' || rawArgs === 'playing' || rawArgs === 'np') {
      try {
        const text = await this.spotifyClient.getNowPlayingText();
        await channel.send(text, msg.channelId);
      } catch (err: any) {
        await channel.send(`Failed: ${err.message}`, msg.channelId);
      }
      return;
    }
    await channel.send('Agent is busy. Full Spotify controls will be available after current task completes.', msg.channelId);
  }

  private async handleFastPathCode(trimmed: string, msg: ChannelMessage, channel: any): Promise<void> {
    const rawArgs = trimmed.slice('/code'.length).trim().toLowerCase();
    if (rawArgs === 'status') {
      await channel.send(this.programmingMode.getStatusText(), msg.channelId);
      return;
    }
    await channel.send('Agent is busy. Programming mode changes will be available after current task completes.', msg.channelId);
  }

  private async handleBgCommand(trimmed: string, msg: ChannelMessage, channel: any): Promise<void> {
    const parts = trimmed.trim().split(/\s+/);
    const sub = parts.length > 1 ? parts[1] : '';
    const args = parts.slice(1).join(' ');

    if (sub === 'current') {
      if (!this.processing || !this.currentMessage) {
        await channel.send('No active task to background.', msg.channelId);
        return;
      }
      const taskDescription = this.currentMessage.content.trim();
      const sourceChannelId = this.currentMessage.channelId;
      const sourceChannelType = this.currentMessage.channelType as any;

      if (this.currentAbort) {
        this.currentAbortReason = 'backgrounded';
        this.currentAbort.abort();
      }

      if (this.supervisor) {
        const agentId = await this.supervisor.spawn({
          task: taskDescription,
          sourceChannelId,
          sourceChannelType,
        });
        const bgId = this.backgroundTasks.spawnAgent(taskDescription, this.capabilities.getCwd(), agentId);
        await channel.send(`📋 Active task moved to background as ${bgId}. I'll notify you when it completes.`, msg.channelId);
      } else {
        await channel.send('Cannot background: sub-agents not available. The active task has been aborted.', msg.channelId);
      }

      this.syncBgTasksToTui();
      return;
    }

    if (sub === 'list' || sub === '' || sub === 'ls') {
      const tasks = this.backgroundTasks.getAllSummaries();
      if (tasks.length === 0) {
        await channel.send('No background tasks.', msg.channelId);
        return;
      }
      const lines = tasks.map((t) => {
        const icon = t.status === 'running' ? '⏳' : t.status === 'completed' ? '✅' : t.status === 'failed' ? '❌' : t.status === 'timed_out' ? '⏱' : '⛔';
        const label = t.command || t.task || t.id;
        const elapsed = t.runningMs ? ` (${Math.round(t.runningMs / 1000)}s)` : t.completedAt ? ` (${((t.completedAt - t.startedAt) / 1000).toFixed(1)}s)` : '';
        const short = label.length > 60 ? label.slice(0, 57) + '...' : label;
        return `${icon} ${t.id}: ${short}${elapsed} — ${t.status}`;
      });
      await channel.send(`**Background Tasks:**\n${lines.join('\n')}\n\nUse /bg <id> for details, /bg cancel <id> to cancel, /bg clear to prune completed tasks.`, msg.channelId);
      return;
    }

    if (sub === 'clear') {
      const cleared = this.backgroundTasks.clearCompleted();
      await channel.send(`Cleared ${cleared} completed task(s).`, msg.channelId);
      this.syncBgTasksToTui();
      return;
    }

    if (sub === 'cancel' || sub === 'stop' || sub === 'kill') {
      const taskId = parts[2];
      if (!taskId) {
        await channel.send(`Usage: /bg ${sub} <id>`, msg.channelId);
        return;
      }
      const cancelled = this.backgroundTasks.cancel(taskId);
      if (cancelled) {
        await channel.send(`⛔ Stopped background task ${taskId}.`, msg.channelId);
      } else {
        await channel.send(`Task "${taskId}" not found or not running.`, msg.channelId);
      }
      this.syncBgTasksToTui();
      return;
    }

    if (sub === 'killall' || sub === 'stopall') {
      const count = this.backgroundTasks.cancelAll();
      if (count === 0) {
        await channel.send('No running background tasks to stop.', msg.channelId);
      } else {
        await channel.send(`⛔ Stopped ${count} background task${count === 1 ? '' : 's'}.`, msg.channelId);
      }
      this.syncBgTasksToTui();
      return;
    }

    const specificTask = this.backgroundTasks.getSummary(sub);
    if (specificTask) {
      const task = this.backgroundTasks.get(sub)!;
      const label = task.command || task.task || task.id;
      const elapsed = task.status === 'running'
        ? `Running for ${Math.round((Date.now() - task.startedAt) / 1000)}s`
        : task.completedAt
          ? `Completed in ${((task.completedAt - task.startedAt) / 1000).toFixed(1)}s`
          : task.status;
      const output = (task.stdout + '\n' + task.stderr).trim();
      const preview = output.length > 2000 ? output.slice(-2000) : output;
      await channel.send(`**${specificTask.id}**: ${label}\nStatus: ${elapsed}\nExit code: ${task.exitCode ?? 'N/A'}\n\n${preview || '(no output)'}`, msg.channelId);
      return;
    }

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx !== -1 && trimmed[colonIdx + 1] === ' ') {
      const taskDescription = trimmed.slice(colonIdx + 1).trim();
      if (!taskDescription) {
        await channel.send('Usage: /bg: <natural language task> or /bg <shell command>', msg.channelId);
        return;
      }
      if (!this.supervisor) {
        await channel.send('Sub-agents are not available. Use /bg <command> for shell commands.', msg.channelId);
        return;
      }
      const agentId = await this.supervisor.spawn({
        task: taskDescription,
        sourceChannelId: msg.channelId,
        sourceChannelType: msg.channelType as any,
      });
      const bgId = this.backgroundTasks.spawnAgent(taskDescription, this.capabilities.getCwd(), agentId);
      this.backgroundTasks.registerComplete(bgId, (task) => {
        if (task.status === 'running') return;
      });
      await channel.send(`📋 Background agent ${bgId} started: "${taskDescription.slice(0, 50)}${taskDescription.length > 50 ? '...' : ''}"`, msg.channelId);
      this.syncBgTasksToTui();
      return;
    }

    const command = args || '';
    if (!command) {
      await channel.send('Usage:\n• /bg <command> — run a shell command in the background\n• /bg: <task> — delegate an LLM task to the background\n• /bg current — move the active task to the background\n• /bg list — show all background tasks\n• /bg <id> — show task details\n• /bg stop <id> — stop a running task\n• /bg killall — stop all running tasks\n• /bg clear — prune completed tasks', msg.channelId);
      return;
    }

    const cwd = this.capabilities.getCwd();
    const bgId = this.backgroundTasks.spawnShell(command, cwd);
    await channel.send(`📋 Background task ${bgId} started: "${command.slice(0, 50)}${command.length > 50 ? '...' : ''}"`, msg.channelId);
    this.syncBgTasksToTui();
  }

  private syncBgTasksToTui(): void {
    const cliChannel = this.channels.get('cli');
    if (cliChannel && cliChannel instanceof CLIChannel) {
      (cliChannel as CLIChannel).updateBackgroundTasks(this.backgroundTasks.getAllSummaries());
    }
  }

  private markProgress(activity?: string): void {
    this.lastProgressAt = Date.now();
    if (activity) {
      this.currentActivity = activity;
    }
  }

  private withProgressStream(content: AsyncIterable<string>): AsyncIterable<string> {
    const self = this;
    return (async function* () {
      for await (const chunk of content) {
        self.markProgress('Streaming response...');
        yield chunk;
      }
    })();
  }

  private withProviderDeadline<T>(operation: PromiseLike<T>, controller: AbortController, deadlineAt: number): Promise<T> {
    return withAbortDeadline(operation, controller, deadlineAt - Date.now(), () => {
      this.currentAbortReason = 'time-limit';
    });
  }

  private startForegroundHeartbeat(msg: ChannelMessage): () => void {
    if (msg.channelType === 'internal') return () => {};

    let heartbeatCount = 0;
    let currentIntervalMs = HEARTBEAT_INITIAL_MS;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = () => {
      if (!this.processing || !this.currentMessage || this.currentMessage.id !== msg.id) return;
      const channel = this.channels.getChannelForMessage(msg);

      const elapsedMs = Date.now() - this.currentMessage.timestamp;
      const stallMs = Date.now() - this.lastProgressAt;
      const elapsedSec = Math.round(elapsedMs / 1000);
      const stallSec = Math.round(stallMs / 1000);

      if (stallMs >= MAX_STALL_MS * this.researchMode.getStallMsMultiplier() && this.currentAbort && !this.currentAbort.signal.aborted) {
        logger.warn({ elapsedSec, stallSec, msgId: msg.id }, 'Foreground task stalled — aborting');
        this.currentAbortReason = 'stalled';
        this.currentAbort.abort();
        if (channel) {
          void channel.send(
            `Mercury detected a stalled provider after ${stallSec}s without progress. Reconnecting and retrying automatically.`,
            msg.channelId,
          ).catch((e) => logger.warn({ e }, 'channel send failed'));
        }
        timer = setTimeout(tick, HEARTBEAT_MAX_MS);
        return;
      }

      heartbeatCount++;
      const handoffHint = elapsedMs >= LONG_TASK_HANDOFF_SUGGEST_MS
        ? '\nUse /bg current to move to background.'
        : '';
      const stepInfo = this.completedStepCount > 0
        ? ` · step ${this.completedStepCount}/${MAX_STEPS}`
        : '';
      const narrative = formatNarrative(this.stepNarrative, this.currentActivity, 3);
      const narrativeBlock = narrative ? `\n${narrative}` : '';
      const heartbeatText = `⏳ Working... ${elapsedSec}s elapsed${stepInfo}.${narrativeBlock}${handoffHint}`;

      // CLI: update one message in place instead of stacking new ones.
      // Web/cloud: send a non-terminal heartbeat so the cloud response handler stays alive.
      // Other channels (Telegram): still send as separate messages.
      if (channel instanceof CLIChannel) {
        (channel as CLIChannel).sendHeartbeat(heartbeatText);
      } else if (channel instanceof WebChannel) {
        (channel as WebChannel).sendHeartbeat(heartbeatText, msg.channelId);
      } else if (channel) {
        void channel.send(heartbeatText, msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
      }

      // Escalate: 20s → 30s → 45s → 60s (cap)
      if (heartbeatCount <= 2) {
        currentIntervalMs = 30000;
      } else if (heartbeatCount <= 4) {
        currentIntervalMs = 45000;
      } else {
        currentIntervalMs = HEARTBEAT_MAX_MS;
      }
      timer = setTimeout(tick, currentIntervalMs);
    };

    timer = setTimeout(tick, HEARTBEAT_INITIAL_MS);

    return () => {
      if (timer) clearTimeout(timer);
    };
  }

  private notifyBackgroundTaskComplete(task: import('./background-tasks.js').BackgroundTask): void {
    const label = task.command || task.task || task.id;
    const duration = task.completedAt ? ` in ${((task.completedAt - task.startedAt) / 1000).toFixed(1)}s` : '';
    let message: string;

    if (task.status === 'completed') {
      message = `✅ Background task ${task.id} completed${duration}: "${label}"`;
    } else if (task.status === 'failed') {
      message = `❌ Background task ${task.id} failed${duration}: "${label}" (exit code ${task.exitCode ?? 'unknown'})`;
    } else if (task.status === 'timed_out') {
      message = `⏱ Background task ${task.id} timed out: "${label}"`;
    } else if (task.status === 'cancelled') {
      message = `⛔ Background task ${task.id} cancelled: "${label}"`;
    } else {
      message = `Background task ${task.id}: ${task.status} — "${label}"`;
    }

    const output = (task.stdout + '\n' + task.stderr).trim();
    if (output) {
      const preview = output.length > 500 ? '\n' + output.slice(-500) : '\n' + output;
      message += preview;
    }

    const cliCh = this.channels.get('cli');
    if (cliCh) {
      (cliCh as CLIChannel).send(message).catch((e) => logger.warn({ e }, 'channel send failed'));
    }
    const tgCh = this.channels.get('telegram');
    if (tgCh) {
      tgCh.send(message).catch((e) => logger.warn({ e }, 'channel send failed'));
    }
    const dcCh = this.channels.get('discord');
    if (dcCh) {
      dcCh.send(message).catch((e) => logger.warn({ e }, 'channel send failed'));
    }
    const slCh = this.channels.get('slack');
    if (slCh) {
      slCh.send(message).catch((e) => logger.warn({ e }, 'channel send failed'));
    }

    this.syncBgTasksToTui();
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    if (this.messageQueue.length === 0) return;
    if (!this.running) return;
    if (!this.lifecycle.is('idle')) return;

    this.processing = true;

    try {
      while (this.messageQueue.length > 0) {
        const item = this.messageQueue.shift()!;
        const msg = item.message;
        if (item.workKey) this.queuedWorkKeys.delete(item.workKey);
        this.currentWorkKey = item.workKey ?? null;
        try {
          if (item.workKey) this.workLedger.markRunning(item.workKey);
          await this.handleMessage(msg);
          if (item.workKey && this.workLedger.get(item.workKey)?.status === 'running') {
            this.workLedger.markFailed(item.workKey, 'Work ended without producing a durable final response');
          }
        } catch (err) {
          if (item.workKey) {
            const entry = this.workLedger.get(item.workKey);
            if (entry?.status === 'completed') this.workLedger.markDeliveryError(item.workKey, err);
            else this.workLedger.markFailed(item.workKey, err);
          }
          logger.error({ err, msg: msg.content.slice(0, 50) }, 'Failed to handle message');
        } finally {
          this.currentWorkKey = null;
          if (!this.lifecycle.is('idle') && this.lifecycle.canTransitionTo('idle')) {
            this.lifecycle.transition('idle');
          }
        }
      }
    } finally {
      this.processing = false;
      if (this.messageQueue.length > 0) void this.processQueue();
    }
  }

  private scheduleDurableRetry(msg: ChannelMessage, workKey: string, error: unknown, continuation = false): number {
    const attempts = this.workLedger.get(workKey)?.attempts ?? 1;
    const delayMs = continuation
      ? Math.min(2_000 * 2 ** Math.min(attempts - 1, 5), 60_000)
      : Math.min(5_000 * 2 ** Math.min(attempts - 1, 6), 5 * 60_000);
    this.workLedger.markRetry(workKey, error, Date.now() + delayMs, {
      continuation,
      workCwd: this.capabilities.getCwd(),
      activity: this.currentActivity,
      summary: formatNarrative(this.stepNarrative, this.currentActivity, 8),
    });
    const timer = setTimeout(() => {
      const entry = this.workLedger.get(workKey);
      if (!entry || entry.status !== 'queued') return;
      this.queueMessage(entry.message, workKey);
      void this.processQueue();
    }, delayMs);
    timer.unref?.();
    return delayMs;
  }

  private isRetryableProviderError(error: unknown): boolean {
    const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
    return /timeout|timed out|network|socket|connection|temporar|unavailable|overloaded|rate.?limit|\b429\b|\b5\d\d\b|econn|fetch failed|stalled/.test(message);
  }

  private async sendProgressNotice(msg: ChannelMessage, message: string): Promise<void> {
    const channel = this.channels.getChannelForMessage(msg);
    if (!channel || msg.channelType === 'internal') return;
    if (channel instanceof WebChannel) {
      channel.sendHeartbeat(message, msg.channelId);
      return;
    }
    if (channel instanceof CLIChannel) {
      channel.sendHeartbeat(message);
      return;
    }
    await channel.send(message, msg.channelId);
  }

  private channelProviderOverrides = new Map<string, { providerName: string; modelName: string; provider: BaseProvider }>();

  async listChatModelOptions(): Promise<Array<{ provider: string; label: string; model: string; models: string[]; selected: boolean }>> {
    const active = getActiveProviders(this.config);
    const current = this.getCurrentProvider();
    return Promise.all(active.map(async (provider) => {
      let models = [provider.model].filter(Boolean);
      try {
        const catalog = await fetchProviderModelCatalog(provider.name as any, provider.name === 'mercuryCloud'
          ? {
            ...provider,
            apiKey: this.config.cloud.jwt || provider.apiKey,
            baseUrl: this.config.cloud.apiUrl || provider.baseUrl,
          }
          : provider);
        models = [...new Set([provider.model, catalog.recommendedModel, ...catalog.models].filter(Boolean))];
      } catch (err) {
        logger.debug({ provider: provider.name, err }, 'Unable to fetch provider model catalog; using configured model');
        models = [...new Set([provider.model, ...getPreferredModelsForProvider(provider.name as any)].filter(Boolean))];
      }

      return {
        provider: provider.name,
        label: provider.name,
        model: provider.model,
        models,
        selected: provider.name === current.name,
      };
    }));
  }

  async setChannelProviderOverride(
    channelId: string,
    providerName: string,
    modelName?: string,
    options: { persist?: boolean } = {},
  ): Promise<{ ok: boolean; message: string; provider?: string; model?: string }> {
    const active = getActiveProviders(this.config);
    const config = active.find((provider) => provider.name === providerName);
    if (!config) {
      return { ok: false, message: `Provider \`${providerName}\` is not configured for this local agent.` };
    }

    const provider = await createProvider(
      { ...config, model: modelName || config.model },
      providerName === 'mercuryCloud' ? getCloudTokenStore() : undefined,
    );
    if (!provider) {
      return { ok: false, message: `Provider \`${providerName}\` is not available in the running registry.` };
    }

    const previousOverride = this.channelProviderOverrides.get(channelId)?.provider as (BaseProvider & { destroy?: () => void }) | undefined;
    if (previousOverride !== provider && this.providers.get(previousOverride?.name) !== previousOverride) {
      previousOverride?.destroy?.();
    }
    this.channelProviderOverrides.set(channelId, { providerName, modelName: provider.getModel(), provider });

    if (options.persist && providerName in this.config.providers) {
      const providerKey = providerName as ProviderName;
      const providerConfig = this.config.providers[providerKey];
      providerConfig.model = provider.getModel();
      providerConfig.enabled = true;
      this.config.providers.default = providerName as ProviderName;
      this.providers.set(providerName, provider);
      this.providers.setDefault(providerName);
      saveConfig(this.config);
      updateCliProviderStatus(this.channels.get('cli'), providerName, provider.getModel());
    }

    const saved = options.persist ? ' Saved as the default for future sessions.' : '';
    return { ok: true, message: `This chat will use **${providerName}** · **${provider.getModel()}**.${saved}`, provider: providerName, model: provider.getModel() };
  }

  private async switchSessionProvider(providerName: string): Promise<{ ok: boolean; message: string }> {
    const active = getActiveProviders(this.config).map((p) => p.name);
    if (!active.includes(providerName)) {
      return { ok: false, message: `Provider \`${providerName}\` is not configured. Run \`mercury doctor\` to add/configure models.` };
    }

    this.config.providers.default = providerName as any;
    const previousProviders = this.providers;
    this.providers = await ProviderRegistryImpl.create(this.config, getCloudTokenStore());
    previousProviders.destroy();
    const selected = this.providers.getDefault();
    const model = selected.getModel();

    updateCliProviderStatus(this.channels.get('cli'), providerName, model);

    return { ok: true, message: `Session model switched to **${providerName}** · **${model}**.` };
  }

  /** Returns the currently active provider name and model. */
  getCurrentProvider(): { name: string; model: string } {
    try {
      const p = this.providers.getDefault();
      return { name: this.config.providers.default as string || p.name, model: p.getModel() };
    } catch {
      return { name: this.config.providers.default as string || 'unknown', model: '' };
    }
  }

  /** Public wrapper for web API model switching. */
  async switchProvider(providerName: string): Promise<{ ok: boolean; message: string }> {
    return this.switchSessionProvider(providerName);
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

    const recovered = this.workLedger.recoverInterrupted();
    for (const entry of recovered) this.queueMessage(entry.message, entry.key);
    await this.replayUndeliveredResponses();
    this.startOutboxRetry();
    void this.processQueue();

    const activeChannels = this.channels.getActiveChannels();
    const toolNames = this.capabilities.getToolNames();
    logger.info({ channels: activeChannels, tools: toolNames }, 'Mercury is awake');
  }

  async sleep(): Promise<void> {
    this.running = false;
    if (this.outboxRetryTimer) {
      clearInterval(this.outboxRetryTimer);
      this.outboxRetryTimer = null;
    }
    this.scheduler.stopAll();
    await this.channels.stopAll();
    this.lifecycle.transition('sleeping');
    logger.info('Mercury is sleeping');
  }

  private async replayUndeliveredResponses(): Promise<void> {
    if (this.replayingOutbox) return;
    this.replayingOutbox = true;
    try {
      for (const entry of this.workLedger.getUndeliveredResponses()) {
        await this.deliverLedgerEntry(entry);
      }
    } finally {
      this.replayingOutbox = false;
    }
  }

  private startOutboxRetry(): void {
    if (this.outboxRetryTimer) return;
    this.outboxRetryTimer = setInterval(() => {
      if (this.running) void this.replayUndeliveredResponses();
    }, 30_000);
    this.outboxRetryTimer.unref?.();
  }

  private async deliverLedgerEntry(entry: WorkEntry): Promise<void> {
    const channel = this.channels.getChannelForMessage(entry.message);
    if (!channel || !entry.finalResponse) return;
    const requestId = typeof entry.message.metadata?.requestId === 'string' ? entry.message.metadata.requestId : undefined;
    const isCloudRequest = channel instanceof WebChannel
      && typeof entry.message.metadata?.externalConversationId === 'string'
      && requestId;
    if (isCloudRequest && !channel.hasCloudEventHandler(requestId)) return;
    try {
      if (entry.status === 'failed' && channel instanceof WebChannel) {
        if (!channel.sendError(entry.finalResponse, entry.message.channelId)) throw new Error('Cloud WebSocket could not accept the terminal error');
      } else {
        await channel.send(entry.finalResponse, entry.message.channelId);
      }
      if (!isCloudRequest) this.workLedger.markDelivered(entry.key);
    } catch (error) {
      this.workLedger.markDeliveryError(entry.key, error);
      logger.warn({ error, workKey: entry.key }, 'Durable response replay failed');
    }
  }

  private finalizeChannelTask(msg: ChannelMessage): void {
    const channel = this.channels.getChannelForMessage(msg);
    if (channel instanceof TelegramChannel || channel instanceof SignalChannel || channel instanceof DiscordChannel || channel instanceof SlackChannel) {
      channel.endTask(msg.channelId);
      channel.resetStepCounter(msg.channelId);
    }
  }

  private async handleMessage(msg: ChannelMessage): Promise<void> {
    this.lifecycle.transition('thinking');
    const startTime = Date.now();
    let loopAbortController = new AbortController();
    this.currentMessage = msg;
    this.currentAbort = loopAbortController;
    this.currentAbortReason = null;
    const durableCwd = typeof msg.metadata?.workCwd === 'string' ? msg.metadata.workCwd : undefined;
    if (durableCwd && existsSync(durableCwd)) {
      this.capabilities.setCwd(durableCwd);
      this.capabilities.permissions.addTempScope(durableCwd, true, true);
    }
    this.currentActivity = '';
    this.completedStepCount = 0;
    this.stepNarrative = [];
    this.markProgress('Starting...');
    const stopHeartbeat = this.startForegroundHeartbeat(msg);
    let canonicalSessionId: string | undefined;

    if (this.supervisor && msg.channelType !== 'internal') {
      const activeAgents = this.supervisor.getActiveAgents();
      const runningAgents = activeAgents.filter(a => a.status === 'running');
      if (runningAgents.length > 0) {
        const channel = this.channels.getChannelForMessage(msg);
        if (channel) {
          const agentLines = runningAgents.map(a => `  🔄 ${a.id}: ${a.task.slice(0, 45)}${a.task.length > 45 ? '...' : ''}`);
          await channel.send(`**Multi-agent mode** — ${runningAgents.length} agent${runningAgents.length > 1 ? 's' : ''} active:\n${agentLines.join('\n')}`, msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
        }
      }
    }

      const isInternal = msg.channelType === 'internal';
      if (isInternal) {
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
        const streamingLabel = msg.channelType === 'discord' ? 'Discord' : msg.channelType === 'slack' ? 'Slack' : 'Telegram';
        if (ch) await ch.send(
          this.telegramStreaming
            ? `${streamingLabel} streaming enabled. Responses will appear progressively.`
            : `${streamingLabel} streaming disabled. Responses will arrive as a single message.`,
          msg.channelId,
        );
        this.lifecycle.transition('idle');
        return;
      }

      if (await this.handleChatCommand(trimmed, msg.channelType, msg.channelId)) {
        this.lifecycle.transition('idle');
        return;
      }

      if (await this.handleWorkspaceNaturalLanguage(trimmed, msg.channelType, msg.channelId)) {
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

      // Token Saver Mode auto-engagement check. When usage crosses the
      // configured threshold (default 75%), saver activates and the user
      // is notified once so they understand response style may change.
      {
        const transition = this.saverMode.evaluateAuto(this.tokenBudget.getUsagePercentage());
        if (transition.activated) {
          const notice = this.saverMode.consumeAutoActivationNotice();
          if (notice && msg.channelType !== 'internal') {
            const ch = this.channels.get(msg.channelType as any);
            if (ch) await ch.send(notice, msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
          }
          this.syncSaverToCli();
        } else if (transition.deactivated && msg.channelType !== 'internal') {
          const ch = this.channels.get(msg.channelType as any);
          if (ch) await ch.send('⚡ Token Saver Mode auto-disengaged (usage dropped). Normal response settings restored.', msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
          this.syncSaverToCli();
        }
      }

      let systemPrompt = this.buildSystemPrompt();
      if (msg.metadata?.workContinuation === true) {
        const attempt = typeof msg.metadata.continuationAttempt === 'number' ? msg.metadata.continuationAttempt : 1;
        const reason = typeof msg.metadata.continuationReason === 'string' ? msg.metadata.continuationReason : 'The prior execution was interrupted.';
        const activity = typeof msg.metadata.continuationActivity === 'string' ? msg.metadata.continuationActivity : 'unknown';
        const summary = typeof msg.metadata.continuationSummary === 'string' ? msg.metadata.continuationSummary : 'No structured progress summary is available.';
        const cwd = typeof msg.metadata.workCwd === 'string' ? msg.metadata.workCwd : this.capabilities.getCwd();
        systemPrompt += `\n\n[SYSTEM: DURABLE CONTINUATION ${attempt}] Do not restart this task. Continue from the artifacts and side effects already present. First inspect the current filesystem and relevant external state, especially ${cwd}. Prior interruption: ${reason}. Last activity: ${activity}. Recorded progress: ${summary}. Do not repeat the failed strategy. If a file or tool payload was too large, use a different bounded approach: inspect what exists, generate smaller components, append or patch in small verified chunks, or generate repetitive content programmatically. Verify each existing artifact before changing it. Keep working until there is a usable final deliverable, then clearly report its location and validation result.`;
      } else if (msg.metadata?.workRecovered === true) {
        systemPrompt += '\n\n[SYSTEM: RECOVERED WORK] This request was recovered after the agent restarted or its prior run was interrupted. Inspect the current filesystem, external state, and conversation before acting. Do not repeat side effects that may already have completed. Continue from observed state, and explicitly report any ambiguity you cannot safely resolve.';
      }
      const suppliedSessionId = msg.sessionId ?? (typeof msg.metadata?.sessionId === 'string' ? msg.metadata.sessionId : undefined);
      const externalConversationId = msg.channelType === 'cli'
        ? 'current'
        : typeof msg.metadata?.externalConversationId === 'string' ? msg.metadata.externalConversationId : msg.channelId;
      const canonicalSession = this.sessions.getOrCreateBound(msg.channelType, externalConversationId, suppliedSessionId);
      canonicalSessionId = canonicalSession.id;
      const canonicalMessageId = typeof msg.metadata?.canonicalMessageId === 'string' ? msg.metadata.canonicalMessageId : undefined;
      const requestId = typeof msg.metadata?.requestId === 'string' ? msg.metadata.requestId : undefined;
      this.sessions.appendMessage(canonicalSession.id, {
        id: canonicalMessageId,
        role: 'user',
        content: msg.content,
        timestamp: msg.timestamp,
        externalMessageId: msg.id,
        metadata: { channelType: msg.channelType, channelId: msg.channelId, ...(requestId ? { requestId } : {}) },
      });
      if (msg.channelType === 'cli') {
        const activeSession = this.sessions.get(canonicalSession.id);
        const cliChannel = this.channels.get('cli');
        if (cliChannel instanceof CLIChannel) cliChannel.setCurrentSession(activeSession);
      }
      const recentMemory = this.sessions.get(canonicalSession.id).messages
        .filter((entry) => entry.kind === 'message' && entry.role !== 'tool')
        .slice(-this.saverMode.adjustHistoryWindow(10));

      const messages: any[] = [];

      const recentSteps = recentMemory.slice(-6);
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
            content: `[Second Brain — auto-retrieved context]\n${memoryContext.context}\n[End auto-retrieved context]`,
          });
          messages.push({ role: 'assistant', content: 'Noted. I\'ll keep this in mind.' });
        }

        // Local-first, then pool: query the cloud SharedMemoryPool for additional
        // context the second brain didn't surface. Gated by config, fails open
        // (any error → proceed with local-only context). 5-min cache per query.
        const ck = this.config.memory.collaborativeKnowledge;
        const cloud = this.config.cloud;
        const tokenStore = getCloudTokenStore();
        if (ck?.poolSearch !== false && cloud?.enabled && cloud?.jwt && cloud?.apiUrl) {
          try {
            const { searchPool, formatPoolContextBlock, dedupeAgainstLocal } = await import('../cloud/pool-search.js');
            const localSummaries = memoryContext.records.map((r) => r.summary);
            const poolHits = await searchPool(
              cloud.apiUrl,
              cloud.jwt,
              cloud.refreshToken,
              msg.content,
              { limit: 10 },
              (newJwt, newRefresh) => {
                // Route every rotation through the shared store so all
                // consumers see the new tokens. Fallback to direct config
                // mutation if the store isn't initialized (older code path).
                if (tokenStore) {
                  tokenStore.setTokensAndPersist(newJwt, newRefresh);
                } else {
                  cloud.jwt = newJwt;
                  cloud.refreshToken = newRefresh;
                  this.config.providers.mercuryCloud.apiKey = newJwt;
                  saveConfig(this.config);
                }
              },
            );
            const deduped = dedupeAgainstLocal(poolHits, localSummaries);
            const poolBlock = formatPoolContextBlock(deduped, 1500);
            if (poolBlock) {
              messages.push({ role: 'user', content: poolBlock });
              messages.push({ role: 'assistant', content: 'Noted. I\'ll use this shared context.' });
            }
          } catch (err) {
            logger.debug({ err: (err as Error).message }, 'pool search failed (fail-open)');
          }
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
            role: m.role,
            content: m.content,
          });
        }
      }

      if (!canonicalSessionId) messages.push({ role: 'user', content: msg.content });

      // ── Skill Intent Routing & Batch Execution ──
      //
      // Routing strategy:
      //   1. Explicit pick via `#skill-name` prefix → run that skill directly,
      //      no ambiguity resolution needed.
      //   2. Otherwise consult the intent router:
      //      - Clear winner (high confidence + clear gap) → let the LLM invoke
      //        it normally via use_skill (single skill) OR batch-execute when
      //        the top batch is multi-skill in the same category.
      //      - Ambiguous (multiple contenders bunched near the top) → ask the
      //        user to disambiguate before doing anything.
      //      - No usable match → fall through to the normal LLM loop.
      if (this.skillBatcher && this.skillLoader && msg.channelType !== 'internal') {
        try {
          const intentRouter = this.skillLoader.intentRouter;

          // (1) Explicit `#skill-name <rest>` shortcut from the # picker.
          const hashMatch = trimmed.match(/^#([a-z0-9_:.-]+)\b\s*(.*)$/i);
          if (intentRouter && intentRouter.isInitialized() && hashMatch) {
            const skillName = hashMatch[1];
            const rest = hashMatch[2].trim();
            const knownSkills = this.skillLoader.getDiscovered?.() || [];
            const known = knownSkills.some((s: any) => s.name === skillName);
            if (known) {
              messages[messages.length - 1] = {
                role: 'user',
                content: rest || trimmed,
              };
              messages.push({
                role: 'user',
                content: `[Routing] The user explicitly selected the \`${skillName}\` skill via #-prefix. Invoke it via \`use_skill\` with name="${skillName}" before doing anything else, then act on the result.`,
              });
              // Skip the rest of routing — explicit pick wins.
            } else {
              // Unknown #tag: just strip it and let routing proceed on the rest.
              const stripped = rest || trimmed.replace(/^#\S+\s*/, '');
              if (stripped) {
                messages[messages.length - 1] = { role: 'user', content: stripped };
              }
            }
          }

          if (intentRouter && intentRouter.isInitialized() && !hashMatch) {
            const analysis = intentRouter.analyzeMatch(trimmed, { clearThreshold: 0.85, gap: 0.15 });

            // (2a) Ambiguous → ask the user to pick before executing anything.
            if (analysis.ambiguous && analysis.closeContenders.length >= 2) {
              const contenders = analysis.closeContenders.slice(0, 5);
              const choices = [
                ...contenders.map(c => {
                  const desc = intentRouter.getSkillDescription?.(c.name) || '';
                  return desc ? `${c.name} — ${desc}` : c.name;
                }),
                'None of these — answer normally',
              ];
              const channel = this.channels.getChannelForMessage(msg);
              let picked: string | null = null;
              try {
                picked = await this.presentChoice(
                  `I matched several skills for that request and I'm not sure which you meant. Pick one:`,
                  choices,
                  msg.channelId,
                  msg.channelType,
                );
              } catch {
                picked = null;
              }
              if (picked && !picked.startsWith('None of these')) {
                const chosenName = picked.split(' — ')[0].trim();
                messages.push({
                  role: 'user',
                  content: `[Routing] User clarified: use the \`${chosenName}\` skill. Invoke it via \`use_skill\` with name="${chosenName}" before doing anything else.`,
                });
                if (channel) {
                  await channel.send(`Routing to **${chosenName}**.`, msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
                }
              }
              // If the user picked "None of these" we just fall through silently.
            } else {
              // (2b) Clear-enough match → use the existing batch path, but
              //      only when the *top batch alone* has 2+ skills (genuine
              //      multi-step request like "download and notify"). Cross-
              //      category fan-out is what caused the 10-skill explosion.
              const batches = intentRouter.matchToBatches(trimmed, 0.6);
              const totalMatchedSkills = batches.reduce((sum, b) => sum + b.skills.length, 0);

              if (batches.length > 0 && totalMatchedSkills >= 1) {
                const topBatch = batches[0];
                const matchedSkillNames = topBatch.skills.map(s => s.name);
                this.markProgress(`Matched intents: ${matchedSkillNames.join(', ')}...`);

                if (topBatch.skills.length >= 2 && analysis.clearWinner) {
                  const plan = this.skillBatcher.planExecution([topBatch]);
                  if (plan.batches.length > 0) {
                    const channel = this.channels.getChannelForMessage(msg);
                    if (channel) {
                      await channel.send(`🧠 Routing to ${topBatch.skills.length} skills in **${topBatch.categoryLabel}**: ${matchedSkillNames.join(', ')}.`, msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
                    }

                    const batchResults = await this.skillBatcher.execute(plan, trimmed, msg.channelId, msg.channelType);
                    const summary = this.skillBatcher.summarizeResults(batchResults);

                    if (summary) {
                      messages.push({
                        role: 'user',
                        content: `[Skill Batch Execution Results]\n${summary}\n\nSynthesize a coherent response based on these results. Mention what was done, any failures, and key findings.`,
                      });
                      messages.push({
                        role: 'assistant',
                        content: 'Acknowledged. I will synthesize the batch execution results into a coherent response.',
                      });
                    }
                  }
                }
                // Single clear-winner skill: let the LLM call use_skill itself.
              }
            }
          }
        } catch (err) {
          logger.warn({ err }, 'Intent routing / batch execution failed — continuing without it');
        }
      }

      this.lifecycle.transition('responding');

      const channel = this.channels.getChannelForMessage(msg);
      if (channel) {
        await channel.typing(msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
        this.markProgress();
      }

      this.capabilities.setChannelContext(msg.channelId, msg.channelType);
      this.capabilities.permissions.setCurrentChannelType(msg.channelType);

      const providerContextId = msg.sessionId ?? (typeof msg.metadata?.sessionId === 'string' ? msg.metadata.sessionId : msg.channelId);
      const channelOverride = this.channelProviderOverrides.get(providerContextId);
      const fallbackIterator = channelOverride
        ? [channelOverride.provider, ...this.providers.getFallbackIterator(channelOverride.providerName)]
          .filter((provider, index, list) => list.findIndex((item) => item.name === provider.name && item.getModel() === provider.getModel()) === index)
          [Symbol.iterator]()
        : this.providers.getFallbackIterator();
      let result: any = null;
      let usedProvider: { name: string; model: string } | null = null;
      let lastError: any = null;
      let hasCompletedTool = false;
      let hasStreamedOutput = false;
      let cliResponseStreamed = false;
      let requiresContinuationApproval = false;
      const loopDetector = new ToolCallLoopDetector();
      let loopWarningSent = false;
      let selfCheckCount = 0;

      const canStream = msg.channelType === 'cli' || msg.channelType === 'web' || (msg.channelType === 'telegram' && this.telegramStreaming) || msg.channelType === 'signal' || (msg.channelType === 'discord' && this.config.channels.discord.streaming) || (msg.channelType === 'slack' && this.config.channels.slack.streaming);

      const tgChannel = this.channels.get('telegram');
      if (msg.channelType === 'telegram' && tgChannel) {
        (tgChannel as TelegramChannel).resetStepCounter(msg.channelId);
        (tgChannel as TelegramChannel).beginTask(msg.channelId);
      }

      const sigChannel = this.channels.get('signal');
      if (msg.channelType === 'signal' && sigChannel) {
        (sigChannel as SignalChannel).resetStepCounter(msg.channelId);
        (sigChannel as SignalChannel).beginTask(msg.channelId);
      }

      const dcChannel = this.channels.get('discord');
      if (msg.channelType === 'discord' && dcChannel) {
        (dcChannel as DiscordChannel).beginTask(msg.channelId);
      }

      const slChannel = this.channels.get('slack');
      if (msg.channelType === 'slack' && slChannel) {
        (slChannel as SlackChannel).beginTask(msg.channelId);
      }

      // Saver-mode-aware request limits. When saver is off these resolve to
      // the original constants (byte-identical to pre-saver behavior).
      const effectiveMaxOutputTokens = this.saverMode.adjustMaxOutputTokens(MAX_RESPONSE_TOKENS);
      const effectiveMaxSteps = this.saverMode.adjustMaxSteps(MAX_STEPS) * this.researchMode.getMaxStepsMultiplier();
      const saverWasActive = this.saverMode.isActive();

      const providersForAttempt = [...fallbackIterator];
      for (const provider of [...providersForAttempt, ...providersForAttempt]) {
        try {
          const providerDeadlineAt = Date.now() + MAX_PROVIDER_ATTEMPT_MS;
          this.markProgress(`Calling ${provider.name}...`);
          updateCliProviderStatus(this.channels.get('cli'), provider.name, provider.getModel());
          const deepseekProviderOptions = provider instanceof DeepSeekProvider && provider.isReasoner
            ? { deepseek: { thinking: { type: 'enabled' as const } } }
            : undefined;

          logger.info({ provider: provider.name, model: provider.getModel(), steps: MAX_STEPS, stream: canStream }, 'Generating agentic response');

          // Ensure Mercury Cloud token is fresh before getting model instance
          if ('ensureFreshToken' in provider && typeof (provider as any).ensureFreshToken === 'function') {
            await this.withProviderDeadline((provider as any).ensureFreshToken(), loopAbortController, providerDeadlineAt);
          }

          if (canStream && channel) {
            let streamError: unknown;
            let streamAborted = false;
            const streamResult = streamText({
              model: provider.getModelInstance(),
              system: systemPrompt,
              messages,
              tools: this.programmingMode.isPlan() ? this.capabilities.getPlanTools() : this.capabilities.getTools(),
              maxOutputTokens: effectiveMaxOutputTokens,
              stopWhen: stepCountIs(effectiveMaxSteps),
              abortSignal: loopAbortController.signal,
              onError: ({ error }) => {
                streamError = error;
              },
              onAbort: () => {
                streamAborted = true;
              },
              ...(deepseekProviderOptions ? { providerOptions: deepseekProviderOptions } : {}),
              onStepFinish: async ({ toolCalls, toolResults }) => {
                this.completedStepCount++;
                if (toolCalls && toolCalls.length > 0) {
                  for (const tc of toolCalls as any[]) {
                    this.stepNarrative.push({ tool: tc.toolName, label: formatToolStep(tc.toolName, tc.input as Record<string, any> || {}) });
                  }
                  const labels = toolCalls.map((tc: any) => formatToolStep(tc.toolName, tc.input as Record<string, any> || {}));
                  this.markProgress(labels.join(' → '));
                } else {
                  this.markProgress('Thinking...');
                }
                if (toolCalls && toolResults && toolCalls.length > 0) {
                  if (toolResults.length > 0) hasCompletedTool = true;
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
                      await channel.send('⚠ Tool call limit reached (25 calls). Stopping to prevent runaway loop.', msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
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
                      await channel.send(`☿ **Mercury Autopilot** · Identical call loop — ${hardLoop.tool} called ${hardLoop.count}x with same params. Stopping this path.`, msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
                    }
                    loopAbortController.abort();
                    return;
                  }
                  const similarLoop = loopDetector.detectSimilarLoop();
                  if (similarLoop) {
                    logger.warn({ tool: similarLoop.tool, count: similarLoop.count }, 'Failing loop detected — aborting');
                    if (!loopWarningSent && channel && msg.channelType !== 'internal') {
                      loopWarningSent = true;
                      await channel.send(`☿ **Mercury Autopilot** · Failing loop — ${similarLoop.tool} called ${similarLoop.count}x, all failing. Stopping this path.`, msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
                    }
                    loopAbortController.abort();
                    return;
                  }
                  // ── Mercury Autopilot: intelligent repetition analysis ──
                  const analysis = loopDetector.analyzeRepetition();
                  if (analysis && !loopWarningSent && channel && msg.channelType !== 'internal') {
                    if (analysis.verdict === 'productive') {
                      // Productive iteration — diverse params, high success rate
                      // Let it run, just log for transparency
                      logger.info({
                        tool: analysis.tool,
                        count: analysis.count,
                        diversity: analysis.paramDiversity.toFixed(2),
                        successRate: analysis.successRate.toFixed(2),
                      }, 'Mercury Autopilot: productive iteration detected — continuing');
                    } else if (analysis.verdict === 'suspicious') {
                      // Suspicious but not definitively stuck — observe further
                      if (this.capabilities.permissions.isAutoApproveAll()) {
                        selfCheckCount++;
                        if (selfCheckCount >= MAX_SELF_CHECKS) {
                          // Escalate: ask AI for final verdict
                          const recentCalls = loopDetector.getRecentCallSummaries();
                          const shouldContinue = await this.aiSelfCheck({
                            toolName: analysis.tool,
                            callCount: analysis.count,
                            recentCalls,
                            taskDescription: msg.content.slice(0, 300),
                          });
                          if (!shouldContinue) {
                            logger.warn({ tool: analysis.tool, count: analysis.count }, 'Mercury Autopilot: AI verdict — unproductive, aborting');
                            await channel.send(`☿ **Mercury Autopilot** · ${analysis.tool} repeated ${analysis.count}x with low progress (${Math.round(analysis.paramDiversity * 100)}% diversity, ${Math.round(analysis.successRate * 100)}% success). Stopping this path.`, msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
                            loopAbortController.abort();
                            return;
                          }
                        }
                        // Not yet at check limit — let it continue with a note
                        loopDetector.reset();
                        loopWarningSent = false;
                        await channel.send(`☿ **Mercury Autopilot** · Observing ${analysis.tool} (${analysis.count} calls, ${Math.round(analysis.paramDiversity * 100)}% diversity). Continuing under monitoring.`, msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
                      } else {
                        loopWarningSent = true;
                        const shouldContinue = await channel.askToContinue(
                          `☿ Mercury Autopilot: ${analysis.tool} called ${analysis.count}x (${Math.round(analysis.paramDiversity * 100)}% param diversity, ${Math.round(analysis.successRate * 100)}% success rate). Continue?`,
                          msg.channelId,
                        ).catch(() => false);
                        if (shouldContinue) {
                          loopDetector.reset();
                          loopWarningSent = false;
                        } else {
                          loopAbortController.abort();
                        }
                      }
                    } else {
                      // verdict === 'stuck'
                      if (this.capabilities.permissions.isAutoApproveAll()) {
                        logger.warn({ tool: analysis.tool, count: analysis.count, diversity: analysis.paramDiversity, successRate: analysis.successRate }, 'Mercury Autopilot: stuck loop detected');
                        await channel.send(`☿ **Mercury Autopilot** · ${analysis.tool} is stuck (${analysis.count} calls, ${Math.round(analysis.paramDiversity * 100)}% diversity, ${Math.round(analysis.successRate * 100)}% success). Stopping this path.`, msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
                        loopAbortController.abort();
                        return;
                      } else {
                        loopWarningSent = true;
                        const shouldContinue = await channel.askToContinue(
                          `☿ Mercury Autopilot: ${analysis.tool} appears stuck (${analysis.count} calls, ${Math.round(analysis.successRate * 100)}% success). Continue anyway?`,
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
                  }
                  if (channel && msg.channelType !== 'internal') {
                    if (channel instanceof CLIChannel) {
                      for (const tc of toolCalls) {
                        void (channel as CLIChannel).sendToolFeedback(tc.toolName, tc.input as Record<string, any>).catch((e) => logger.warn({ e }, 'channel send failed'));
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
                        void tgCh.sendToolFeedback(tc.toolName, tc.input as Record<string, any>, msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
                      }
                      if (toolResults) {
                        for (let i = 0; i < toolResults.length; i++) {
                          const tr = toolResults[i] as any;
                          const tcName = toolCalls[i]?.toolName as string | undefined;
                          if (tcName) {
                            await tgCh.sendStepDone(tcName, tr.result ?? tr, msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
                          }
                        }
                      }
                    } else if (channel instanceof SignalChannel) {
                      const sigCh = channel as SignalChannel;
                      for (const tc of toolCalls) {
                        void sigCh.sendToolFeedback(tc.toolName, tc.input as Record<string, any>, msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
                      }
                      if (toolResults) {
                        for (let i = 0; i < toolResults.length; i++) {
                          const tr = toolResults[i] as any;
                          const tcName = toolCalls[i]?.toolName as string | undefined;
                          if (tcName) {
                            await sigCh.sendStepDone(tcName, tr.result ?? tr, msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
                          }
                        }
                      }
                    } else if (channel instanceof WebChannel) {
                      const webCh = channel as WebChannel;
                      for (const tc of toolCalls) {
                        webCh.sendToolFeedback(tc.toolName, tc.input as Record<string, any>, msg.channelId);
                      }
                      if (toolResults) {
                        for (let i = 0; i < toolResults.length; i++) {
                          const tr = toolResults[i] as any;
                          const tcName = toolCalls[i]?.toolName as string | undefined;
                          if (tcName) {
                            webCh.sendStepDone(tcName, tr.result ?? tr, msg.channelId);
                          }
                        }
                      }
                    } else if (channel instanceof DiscordChannel) {
                      const dcCh = channel as DiscordChannel;
                      for (const tc of toolCalls) {
                        void dcCh.sendToolFeedback(tc.toolName, tc.input as Record<string, any>, msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
                      }
                      if (toolResults) {
                        for (let i = 0; i < toolResults.length; i++) {
                          const tr = toolResults[i] as any;
                          const tcName = toolCalls[i]?.toolName as string | undefined;
                          if (tcName) {
                            await dcCh.sendStepDone(tcName, tr.result ?? tr, msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
                          }
                        }
                      }
                    } else if (channel instanceof SlackChannel) {
                      const slCh = channel as SlackChannel;
                      for (const tc of toolCalls) {
                        slCh.sendToolFeedback(tc.toolName, tc.input as Record<string, any>, msg.channelId);
                      }
                      if (toolResults) {
                        for (let i = 0; i < toolResults.length; i++) {
                          const tr = toolResults[i] as any;
                          const tcName = toolCalls[i]?.toolName as string | undefined;
                          if (tcName) {
                            await slCh.sendStepDone(tcName, tr.result ?? tr, msg.channelId);
                          }
                        }
                      }
                    } else {
                      await channel.send(`  [Using: ${names}]`, msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
                    }
                    this.markProgress();
                  }
                } else if (toolResults === undefined || (toolCalls === undefined)) {
                  const stepText_step = (toolResults as any)?.text ?? '';
                  if (stepText_step) {
                    loopDetector.recordStepText(String(stepText_step));
                  }
                  const noActionLoop = loopDetector.recordNoActionResult();
                  if (noActionLoop) {
                    logger.warn('Reasoning loop detected — model keeps thinking without acting, aborting');
                    if (!loopWarningSent && channel && msg.channelType !== 'internal') {
                      loopWarningSent = true;
                      await channel.send('⚠ I\'m stuck in a reasoning loop (thinking without taking action). Stopping.', msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
                    }
                    loopAbortController.abort();
                    return;
                  }
                  const textRepeat = loopDetector.detectTextRepetition();
                  if (textRepeat) {
                    logger.warn({ pattern: textRepeat.pattern, count: textRepeat.count }, 'Text repetition loop detected — aborting');
                    if (!loopWarningSent && channel && msg.channelType !== 'internal') {
                      loopWarningSent = true;
                      await channel.send('⚠ I keep generating the same response. Stopping to prevent repetition.', msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
                    }
                    loopAbortController.abort();
                  }
                }
              },
            });

            const trackedStream = this.withProgressStream((async function* () {
              for await (const chunk of streamResult.textStream) {
                if (chunk) hasStreamedOutput = true;
                yield chunk;
              }
            })());
            const streamedText = await this.withProviderDeadline(
              channel.stream(trackedStream, msg.channelId),
              loopAbortController,
              providerDeadlineAt,
            );
            cliResponseStreamed = channel instanceof CLIChannel;

            const [usage, finishReason, streamReasoning] = await this.withProviderDeadline(
              Promise.all([
                streamResult.usage,
                streamResult.finishReason,
                streamResult.reasoning,
              ]),
              loopAbortController,
              providerDeadlineAt,
            );
            if (streamError) throw streamError;
            if (streamAborted || finishReason === 'error') {
              throw new Error(streamAborted ? 'Model stream was aborted before completion' : 'Model stream ended with an error');
            }
            const fullText = finishReason === 'length'
              ? `${streamedText}\n\n[Response truncated: the model reached its output limit. Ask me to continue from this point.]`
              : streamedText;

            result = { text: fullText, usage, reasoning: streamReasoning };
            loopDetector.recordStepText(fullText);
          } else {
            result = await this.withProviderDeadline(generateText({
              model: provider.getModelInstance(),
              system: systemPrompt,
              messages,
              tools: this.programmingMode.isPlan() ? this.capabilities.getPlanTools() : this.capabilities.getTools(),
              maxOutputTokens: effectiveMaxOutputTokens,
              stopWhen: stepCountIs(effectiveMaxSteps),
              abortSignal: loopAbortController.signal,
              ...(deepseekProviderOptions ? { providerOptions: deepseekProviderOptions } : {}),
              onStepFinish: async ({ toolCalls, toolResults }) => {
                this.completedStepCount++;
                if (toolCalls && toolCalls.length > 0) {
                  for (const tc of toolCalls as any[]) {
                    this.stepNarrative.push({ tool: tc.toolName, label: formatToolStep(tc.toolName, tc.input as Record<string, any> || {}) });
                  }
                  const labels = toolCalls.map((tc: any) => formatToolStep(tc.toolName, tc.input as Record<string, any> || {}));
                  this.markProgress(labels.join(' → '));
                } else {
                  this.markProgress('Thinking...');
                }
                if (toolCalls && toolResults && toolCalls.length > 0) {
                  if (toolResults.length > 0) hasCompletedTool = true;
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
                      await channel.send('⚠ Tool call limit reached (25 calls). Stopping to prevent runaway loop.', msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
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
                      await channel.send(`☿ **Mercury Autopilot** · Identical call loop — ${hardLoop.tool} called ${hardLoop.count}x with same params. Stopping this path.`, msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
                    }
                    loopAbortController.abort();
                    return;
                  }
                  const similarLoop = loopDetector.detectSimilarLoop();
                  if (similarLoop) {
                    logger.warn({ tool: similarLoop.tool, count: similarLoop.count }, 'Failing loop detected — aborting');
                    if (!loopWarningSent && channel && msg.channelType !== 'internal') {
                      loopWarningSent = true;
                      await channel.send(`☿ **Mercury Autopilot** · Failing loop — ${similarLoop.tool} called ${similarLoop.count}x, all failing. Stopping this path.`, msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
                    }
                    loopAbortController.abort();
                    return;
                  }
                  // ── Mercury Autopilot: intelligent repetition analysis ──
                  const analysis = loopDetector.analyzeRepetition();
                  if (analysis && !loopWarningSent && channel && msg.channelType !== 'internal') {
                    if (analysis.verdict === 'productive') {
                      // Productive iteration — diverse params, high success rate
                      // Let it run, just log for transparency
                      logger.info({
                        tool: analysis.tool,
                        count: analysis.count,
                        diversity: analysis.paramDiversity.toFixed(2),
                        successRate: analysis.successRate.toFixed(2),
                      }, 'Mercury Autopilot: productive iteration detected — continuing');
                    } else if (analysis.verdict === 'suspicious') {
                      // Suspicious but not definitively stuck — observe further
                      if (this.capabilities.permissions.isAutoApproveAll()) {
                        selfCheckCount++;
                        if (selfCheckCount >= MAX_SELF_CHECKS) {
                          // Escalate: ask AI for final verdict
                          const recentCalls = loopDetector.getRecentCallSummaries();
                          const shouldContinue = await this.aiSelfCheck({
                            toolName: analysis.tool,
                            callCount: analysis.count,
                            recentCalls,
                            taskDescription: msg.content.slice(0, 300),
                          });
                          if (!shouldContinue) {
                            logger.warn({ tool: analysis.tool, count: analysis.count }, 'Mercury Autopilot: AI verdict — unproductive, aborting');
                            await channel.send(`☿ **Mercury Autopilot** · ${analysis.tool} repeated ${analysis.count}x with low progress (${Math.round(analysis.paramDiversity * 100)}% diversity, ${Math.round(analysis.successRate * 100)}% success). Stopping this path.`, msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
                            loopAbortController.abort();
                            return;
                          }
                        }
                        // Not yet at check limit — let it continue with a note
                        loopDetector.reset();
                        loopWarningSent = false;
                        await channel.send(`☿ **Mercury Autopilot** · Observing ${analysis.tool} (${analysis.count} calls, ${Math.round(analysis.paramDiversity * 100)}% diversity). Continuing under monitoring.`, msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
                      } else {
                        loopWarningSent = true;
                        const shouldContinue = await channel.askToContinue(
                          `☿ Mercury Autopilot: ${analysis.tool} called ${analysis.count}x (${Math.round(analysis.paramDiversity * 100)}% param diversity, ${Math.round(analysis.successRate * 100)}% success rate). Continue?`,
                          msg.channelId,
                        ).catch(() => false);
                        if (shouldContinue) {
                          loopDetector.reset();
                          loopWarningSent = false;
                        } else {
                          loopAbortController.abort();
                        }
                      }
                    } else {
                      // verdict === 'stuck'
                      if (this.capabilities.permissions.isAutoApproveAll()) {
                        logger.warn({ tool: analysis.tool, count: analysis.count, diversity: analysis.paramDiversity, successRate: analysis.successRate }, 'Mercury Autopilot: stuck loop detected');
                        await channel.send(`☿ **Mercury Autopilot** · ${analysis.tool} is stuck (${analysis.count} calls, ${Math.round(analysis.paramDiversity * 100)}% diversity, ${Math.round(analysis.successRate * 100)}% success). Stopping this path.`, msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
                        loopAbortController.abort();
                        return;
                      } else {
                        loopWarningSent = true;
                        const shouldContinue = await channel.askToContinue(
                          `☿ Mercury Autopilot: ${analysis.tool} appears stuck (${analysis.count} calls, ${Math.round(analysis.successRate * 100)}% success). Continue anyway?`,
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
                  }
                  if (channel && msg.channelType !== 'internal') {
                    if (channel instanceof CLIChannel) {
                      for (const tc of toolCalls) {
                        void (channel as CLIChannel).sendToolFeedback(tc.toolName, tc.input as Record<string, any>).catch((e) => logger.warn({ e }, 'channel send failed'));
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
                        void tgCh.sendToolFeedback(tc.toolName, tc.input as Record<string, any>, msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
                      }
                      if (toolResults) {
                        for (let i = 0; i < toolResults.length; i++) {
                          const tr = toolResults[i] as any;
                          const tcName = toolCalls[i]?.toolName as string | undefined;
                          if (tcName) {
                            await tgCh.sendStepDone(tcName, tr.result ?? tr, msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
                          }
                        }
                      }
                    } else if (channel instanceof SignalChannel) {
                      const sigCh = channel as SignalChannel;
                      for (const tc of toolCalls) {
                        void sigCh.sendToolFeedback(tc.toolName, tc.input as Record<string, any>, msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
                      }
                      if (toolResults) {
                        for (let i = 0; i < toolResults.length; i++) {
                          const tr = toolResults[i] as any;
                          const tcName = toolCalls[i]?.toolName as string | undefined;
                          if (tcName) {
                            await sigCh.sendStepDone(tcName, tr.result ?? tr, msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
                          }
                        }
                      }
                    } else if (channel instanceof WebChannel) {
                      const webCh = channel as WebChannel;
                      for (const tc of toolCalls) {
                        webCh.sendToolFeedback(tc.toolName, tc.input as Record<string, any>, msg.channelId);
                      }
                      if (toolResults) {
                        for (let i = 0; i < toolResults.length; i++) {
                          const tr = toolResults[i] as any;
                          const tcName = toolCalls[i]?.toolName as string | undefined;
                          if (tcName) {
                            webCh.sendStepDone(tcName, tr.result ?? tr, msg.channelId);
                          }
                        }
                      }
                    } else if (channel instanceof DiscordChannel) {
                      const dcCh = channel as DiscordChannel;
                      for (const tc of toolCalls) {
                        void dcCh.sendToolFeedback(tc.toolName, tc.input as Record<string, any>, msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
                      }
                      if (toolResults) {
                        for (let i = 0; i < toolResults.length; i++) {
                          const tr = toolResults[i] as any;
                          const tcName = toolCalls[i]?.toolName as string | undefined;
                          if (tcName) {
                            await dcCh.sendStepDone(tcName, tr.result ?? tr, msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
                          }
                        }
                      }
                    } else if (channel instanceof SlackChannel) {
                      const slCh = channel as SlackChannel;
                      for (const tc of toolCalls) {
                        slCh.sendToolFeedback(tc.toolName, tc.input as Record<string, any>, msg.channelId);
                      }
                      if (toolResults) {
                        for (let i = 0; i < toolResults.length; i++) {
                          const tr = toolResults[i] as any;
                          const tcName = toolCalls[i]?.toolName as string | undefined;
                          if (tcName) {
                            await slCh.sendStepDone(tcName, tr.result ?? tr, msg.channelId);
                          }
                        }
                      }
                    } else {
                      await channel.send(`  [Using: ${names}]`, msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
                    }
                    this.markProgress();
                  }
                } else if (toolResults === undefined || (toolCalls === undefined)) {
                  const stepText_nostream = (toolResults as any)?.text ?? '';
                  if (stepText_nostream) {
                    loopDetector.recordStepText(String(stepText_nostream));
                  }
                  const noActionLoop = loopDetector.recordNoActionResult();
                  if (noActionLoop) {
                    logger.warn('Reasoning loop detected — model keeps thinking without acting, aborting');
                    if (!loopWarningSent && channel && msg.channelType !== 'internal') {
                      loopWarningSent = true;
                      await channel.send('⚠ I\'m stuck in a reasoning loop (thinking without taking action). Stopping.', msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
                    }
                    loopAbortController.abort();
                    return;
                  }
                  const textRepeat = loopDetector.detectTextRepetition();
                  if (textRepeat) {
                    logger.warn({ pattern: textRepeat.pattern, count: textRepeat.count }, 'Text repetition loop detected — aborting');
                    if (!loopWarningSent && channel && msg.channelType !== 'internal') {
                      loopWarningSent = true;
                      await channel.send('⚠ I keep generating the same response. Stopping to prevent repetition.', msg.channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
                    }
                    loopAbortController.abort();
                  }
                }
              },
            }), loopAbortController, providerDeadlineAt);
            if (result.finishReason === 'error') throw new Error('Model generation ended with an error');
            if (result.finishReason === 'length') {
              result = { ...result, text: `${result.text}\n\n[Response truncated: the model reached its output limit. Ask me to continue from this point.]` };
            }
            if (channel instanceof CLIChannel) {
              await channel.send(result.text, msg.channelId, Date.now() - startTime);
              cliResponseStreamed = true;
            }
          }

          usedProvider = { name: provider.name, model: provider.getModel() };
          if (channel instanceof WebChannel) {
            (channel as WebChannel).sendProviderInfo(usedProvider.name, usedProvider.model, msg.channelId);
          }
          if (!channelOverride) {
            this.providers.markSuccess(provider.name);
          }
          break;
        } catch (err: any) {
          if (this.currentAbortReason === 'time-limit') {
            lastError = new Error(`${provider.name} exceeded the 10-minute provider-attempt limit`);
            requiresContinuationApproval = true;
            this.currentAbortReason = null;
            logger.warn({ provider: provider.name }, 'Provider attempt reached hard deadline; waiting for user decision');
            break;
          }
          if (this.currentAbortReason === 'stalled' && !hasCompletedTool) {
            lastError = new Error(`${provider.name} stalled without progress`);
            this.currentAbortReason = null;
            loopAbortController = new AbortController();
            this.currentAbort = loopAbortController;
            this.markProgress(`Retrying after ${provider.name} stalled...`);
            logger.warn({ provider: provider.name }, 'Provider stalled; retrying with another healthy attempt');
            continue;
          }
          if (this.currentAbortReason === 'backgrounded') {
            result = { text: 'This task was moved to the background and will report back when it finishes.', usage: undefined };
            break;
          }
          if (this.currentAbortReason === 'stopped' || this.currentAbortReason === 'halted') {
            result = { text: `This task was ${this.currentAbortReason} by the user.`, usage: undefined };
            this.currentAbortReason = null;
            break;
          }
          if (loopDetector.isHardAborted() || loopAbortController.signal.aborted) {
            lastError = new Error(hasCompletedTool
              ? 'Generation was interrupted after one or more tools completed. Current side effects may be partial; inspect state before retrying.'
              : 'Generation was aborted by progress or loop safety controls.');
            logger.info({ hasCompletedTool }, 'Generation aborted; recording an explicit failed state');
            break;
          }
          lastError = err;
          if (hasStreamedOutput) {
            lastError = new Error(`Provider stream was interrupted after partial output; refusing fallback to avoid combining two responses. Original error: ${err?.message || String(err)}`);
            logger.error({ provider: provider.name, err }, 'Provider stream interrupted after visible output; fallback suppressed');
            break;
          }
          if (hasCompletedTool) {
            lastError = new Error(`Provider failed after a tool completed; refusing fallback to avoid duplicate side effects. Original error: ${err?.message || String(err)}`);
            logger.error({ provider: provider.name, err }, 'Provider interrupted after tool completion; fallback suppressed');
            break;
          }
          logger.warn({ provider: provider.name, err: err.message }, 'Provider failed, trying fallback');
          await this.sendProgressNotice(msg, `Provider ${provider.name} failed. Trying fallback...`)
            .catch((e) => logger.warn({ e }, 'channel send failed'));
        }
      }

      if (!result) {
        let errMsg = hasCompletedTool
          ? `Work stopped in an interrupted/ambiguous state to avoid repeating completed tool side effects. ${lastError?.message || ''}`.trim()
          : `All LLM providers failed. Last error: ${lastError?.message || 'unknown'}`;
        logger.error({ err: lastError }, errMsg);
        if (this.currentWorkKey && (hasCompletedTool || hasStreamedOutput || requiresContinuationApproval)) {
          const continuationAttempt = typeof msg.metadata?.continuationAttempt === 'number' ? msg.metadata.continuationAttempt : 0;
          const needsApproval = needsContinuationApproval(continuationAttempt, requiresContinuationApproval);
          if (needsApproval) {
            this.markProgress('Waiting for your decision...');
            const reason = requiresContinuationApproval
              ? 'The current provider attempt reached its 10-minute hard limit.'
              : `Mercury has already made ${continuationAttempt} automatic continuation attempts.`;
            const shouldContinue = channel && msg.channelType !== 'internal'
              ? await channel.askToContinue(
                `${reason} Existing files and completed tool work have been preserved. Continue with another inspected attempt?`,
                msg.channelId,
              ).catch(() => false)
              : false;
            if (!shouldContinue) {
              errMsg = `${reason} Work is paused with existing artifacts preserved. Send "continue" when you want Mercury to inspect the current state and resume.`;
            } else {
              const delayMs = this.scheduleDurableRetry(msg, this.currentWorkKey, lastError || errMsg, true);
              await this.sendProgressNotice(
                msg,
                `Progress remains checkpointed. Mercury will inspect the existing artifacts and continue in ${Math.round(delayMs / 1000)} seconds.`,
              ).catch((error) => logger.warn({ error }, 'Unable to send continuation notice'));
              this.lifecycle.transition('idle');
              return;
            }
          } else {
            const delayMs = this.scheduleDurableRetry(msg, this.currentWorkKey, lastError || errMsg, true);
            await this.sendProgressNotice(
              msg,
              `Progress was checkpointed. Mercury will inspect the existing artifacts and continue with a different approach in ${Math.round(delayMs / 1000)} seconds.`,
            ).catch((error) => logger.warn({ error }, 'Unable to send continuation notice'));
            this.lifecycle.transition('idle');
            return;
          }
        }
        if (this.currentWorkKey && !hasCompletedTool && !hasStreamedOutput && this.isRetryableProviderError(lastError)) {
          const attempts = this.workLedger.get(this.currentWorkKey)?.attempts ?? 1;
          const shouldContinue = !needsRetryApproval(attempts) || (
            channel && msg.channelType !== 'internal'
              ? await channel.askToContinue(
                `All providers have failed ${attempts} attempts. No tool side effects were recorded. Retry again?`,
                msg.channelId,
              ).catch(() => false)
              : false
          );
          if (shouldContinue) {
            const delayMs = this.scheduleDurableRetry(msg, this.currentWorkKey, lastError);
            await this.sendProgressNotice(
              msg,
              `All providers are temporarily unavailable. This request is safely queued and will retry in ${Math.round(delayMs / 1000)} seconds.`,
            ).catch((error) => logger.warn({ error }, 'Unable to send durable retry notice'));
            this.lifecycle.transition('idle');
            return;
          }
          errMsg = `All providers failed ${attempts} attempts. Work is paused. Send "continue" when you want Mercury to try again.`;
        }
        if (this.currentWorkKey) this.workLedger.markFailed(this.currentWorkKey, errMsg, errMsg);
        if (channel && msg.channelType !== 'internal') {
          // End task before sending error so it goes through as a normal message
          if (channel instanceof TelegramChannel) {
            (channel as TelegramChannel).endTask(msg.channelId);
            (channel as TelegramChannel).resetStepCounter(msg.channelId);
          } else if (channel instanceof SignalChannel) {
            (channel as SignalChannel).endTask(msg.channelId);
            (channel as SignalChannel).resetStepCounter(msg.channelId);
          } else if (channel instanceof DiscordChannel) {
            (channel as DiscordChannel).endTask(msg.channelId);
            (channel as DiscordChannel).resetStepCounter(msg.channelId);
          } else if (channel instanceof SlackChannel) {
            (channel as SlackChannel).endTask(msg.channelId);
            (channel as SlackChannel).resetStepCounter(msg.channelId);
          }
          const delivered = channel instanceof WebChannel ? channel.sendError(errMsg, msg.channelId) : true;
          if (!(channel instanceof WebChannel)) await channel.send(errMsg, msg.channelId);
          const awaitsCloudAck = msg.channelType === 'web'
            && typeof msg.metadata?.externalConversationId === 'string'
            && typeof msg.metadata?.requestId === 'string';
          if (this.currentWorkKey && delivered && !awaitsCloudAck) this.workLedger.markDelivered(this.currentWorkKey);
          if (this.currentWorkKey && !delivered) this.workLedger.markDeliveryError(this.currentWorkKey, 'Terminal error delivery was not accepted');
        }
        this.lifecycle.transition('idle');
        return;
      }

      const finalText = (result.text || '').trim() || '(no text response)';
      this.markProgress('Finalizing response...');

      // Store plan output when in plan mode for later execution
      if (this.programmingMode.isPlan() && finalText !== '(no text response)') {
        this.programmingMode.storePlan(finalText);
        logger.info({ planLength: finalText.length }, 'Plan captured from plan-mode response');
      }

      this.tokenBudget.recordUsage({
        provider: usedProvider!.name,
        model: usedProvider!.model,
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
        totalTokens: (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
        channelType: msg.channelType,
        agentId: this.config.cloud.agentId || undefined,
      });
      this.syncTokenInfoToCli();

      // Estimate tokens saved by Saver Mode (cap headroom + history trim).
      // Rough: (default_cap - actual_output) when capped, plus history-window delta.
      if (saverWasActive) {
        const actualOutput = result.usage?.outputTokens ?? 0;
        const outputHeadroom = Math.max(0, MAX_RESPONSE_TOKENS - effectiveMaxOutputTokens);
        const outputSaved = Math.max(0, Math.min(outputHeadroom, MAX_RESPONSE_TOKENS - actualOutput));
        // Rough proxy: each trimmed history message ~120 tokens average.
        const historyTrimMessages = Math.max(0, NORMAL_HISTORY_WINDOW - this.saverMode.adjustHistoryWindow(NORMAL_HISTORY_WINDOW));
        const historySaved = historyTrimMessages * 120;
        const estimated = outputSaved + historySaved;
        if (estimated > 0) {
          this.tokenBudget.recordSavings(estimated);
          this.syncSaverToCli();
        }
      }

      if (canonicalSessionId) {
        this.sessions.appendMessage(canonicalSessionId, {
          role: 'assistant',
          content: finalText,
          externalMessageId: `${msg.id}:assistant`,
          tokenCount: (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
          reasoning: typeof result.reasoning === 'string'
            ? result.reasoning
            : result.reasoning
              ? JSON.stringify(result.reasoning)
              : undefined,
          metadata: {
            channelType: msg.channelType,
            channelId: msg.channelId,
            ...(typeof msg.metadata?.requestId === 'string' ? { requestId: msg.metadata.requestId } : {}),
          },
        });
        if (msg.channelType !== 'internal' && msg.senderId !== 'system' && usedProvider) {
          this.scheduleSessionTitleGeneration(canonicalSessionId, usedProvider.name);
        }
      } else {
        this.shortTerm.add(msg.channelId, { id: msg.id, timestamp: msg.timestamp, role: 'user', content: msg.content });
        this.shortTerm.add(msg.channelId, {
          id: Date.now().toString(36), timestamp: Date.now(), role: 'assistant', content: finalText,
          tokenCount: (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0), reasoning: result.reasoning || undefined,
        });
      }

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

      if (this.currentWorkKey) this.workLedger.markCompleted(this.currentWorkKey, finalText);

      if (channel && msg.channelType !== 'internal') {
        const elapsed = Date.now() - startTime;
        const stepCount = this.completedStepCount;

        // Send completion banner only for substantial tasks (3+ steps AND >30s)
        // Simple responses (greetings, quick answers) don't need a banner
        const isSubstantialTask = stepCount >= 3 && elapsed >= 30_000;
        if (isSubstantialTask && channel instanceof TelegramChannel) {
          // For substantial Telegram tasks: sendCompletion handles endTask + deferred flush + cleanup.
          // Always queue the final answer explicitly; streaming normally already
          // defers it, but non-streamed/fallback responses must not be dropped.
          if (finalText && finalText.trim()) {
            (channel as TelegramChannel).deferResponse(msg.channelId, finalText);
          }
          const completionMeta = {
            provider: usedProvider?.name ?? 'unknown',
            model: usedProvider?.model ?? 'unknown',
            inputTokens: result.usage?.inputTokens ?? 0,
            outputTokens: result.usage?.outputTokens ?? 0,
            totalTokens: (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
            budgetUsed: this.tokenBudget.getDailyUsed(),
            budgetTotal: this.tokenBudget.getBudget(),
            budgetPercentage: this.tokenBudget.getUsagePercentage(),
          };
          await (channel as TelegramChannel).sendCompletion(elapsed, stepCount, msg.channelId, completionMeta);
        } else if (channel instanceof TelegramChannel) {
          // For non-substantial Telegram tasks: end task, flush deferred, clean up
          (channel as TelegramChannel).endTask(msg.channelId);
          // Flush deferred response
          const deferred = (channel as TelegramChannel).popDeferredResponse(msg.channelId);
          const responseText = deferred || finalText;
          if (responseText && responseText.trim()) {
            await channel.send(responseText, msg.channelId, elapsed);
          }
          if (stepCount > 0) {
            await (channel as TelegramChannel).cleanupEphemeralMessages(msg.channelId);
            (channel as TelegramChannel).resetStepCounter(msg.channelId);
          }
          this.markProgress();
        } else if (channel instanceof SignalChannel) {
          // For Signal tasks: end task, flush deferred, send completion banner for substantial tasks
          const sigCh = channel as SignalChannel;
          if (isSubstantialTask) {
            await sigCh.stream((async function* () { yield finalText; })(), msg.channelId);
            const completionMeta = {
              provider: usedProvider?.name ?? 'unknown',
              model: usedProvider?.model ?? 'unknown',
              inputTokens: result.usage?.inputTokens ?? 0,
              outputTokens: result.usage?.outputTokens ?? 0,
              totalTokens: (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
              budgetUsed: this.tokenBudget.getDailyUsed(),
              budgetTotal: this.tokenBudget.getBudget(),
              budgetPercentage: this.tokenBudget.getUsagePercentage(),
            };
            await sigCh.sendCompletion(elapsed, stepCount, msg.channelId, completionMeta);
          } else {
            sigCh.endTask(msg.channelId);
            const deferred = sigCh.popDeferredResponse(msg.channelId);
            const responseText = deferred || finalText;
            if (responseText && responseText.trim()) {
              await channel.send(responseText, msg.channelId, elapsed);
            }
            sigCh.resetStepCounter(msg.channelId);
            this.markProgress();
          }
        } else if (channel instanceof DiscordChannel) {
          const dcCh = channel as DiscordChannel;
          if (isSubstantialTask) {
            await dcCh.stream((async function* () { yield finalText; })(), msg.channelId);
            const completionMeta = {
              provider: usedProvider?.name ?? 'unknown',
              model: usedProvider?.model ?? 'unknown',
              inputTokens: result.usage?.inputTokens ?? 0,
              outputTokens: result.usage?.outputTokens ?? 0,
              totalTokens: (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
              budgetUsed: this.tokenBudget.getDailyUsed(),
              budgetTotal: this.tokenBudget.getBudget(),
              budgetPercentage: this.tokenBudget.getUsagePercentage(),
            };
            await dcCh.sendCompletion(elapsed, stepCount, msg.channelId, completionMeta);
          } else {
            dcCh.endTask(msg.channelId);
            const deferred = dcCh.popDeferredResponse(msg.channelId);
            const responseText = deferred || finalText;
            if (responseText && responseText.trim()) {
              await channel.send(responseText, msg.channelId, elapsed);
            }
            dcCh.resetStepCounter(msg.channelId);
            this.markProgress();
          }
        } else if (channel instanceof SlackChannel) {
          const slCh = channel as SlackChannel;
          if (isSubstantialTask) {
            await slCh.stream((async function* () { yield finalText; })(), msg.channelId);
            const completionMeta = {
              provider: usedProvider?.name ?? 'unknown',
              model: usedProvider?.model ?? 'unknown',
              inputTokens: result.usage?.inputTokens ?? 0,
              outputTokens: result.usage?.outputTokens ?? 0,
              totalTokens: (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
              budgetUsed: this.tokenBudget.getDailyUsed(),
              budgetTotal: this.tokenBudget.getBudget(),
              budgetPercentage: this.tokenBudget.getUsagePercentage(),
            };
            await slCh.sendCompletion(elapsed, stepCount, msg.channelId, completionMeta);
          } else {
            slCh.endTask(msg.channelId);
            const deferred = slCh.popDeferredResponse(msg.channelId);
            const responseText = deferred || finalText;
            if (responseText && responseText.trim()) {
              await channel.send(responseText, msg.channelId, elapsed);
            }
            slCh.resetStepCounter(msg.channelId);
            this.markProgress();
          }
        } else {
          // CLI or other channels — original flow
          logger.info({ channelType: msg.channelType, targetId: msg.channelId }, 'Sending durable response');
          if (requiresFinalSend(msg.channelType, cliResponseStreamed)) {
            await channel.send(finalText, msg.channelId, elapsed);
          }
          this.markProgress();
          if (isSubstantialTask && channel instanceof CLIChannel) {
            const completionMeta = {
              provider: usedProvider?.name ?? 'unknown',
              model: usedProvider?.model ?? 'unknown',
              inputTokens: result.usage?.inputTokens ?? 0,
              outputTokens: result.usage?.outputTokens ?? 0,
              totalTokens: (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
              budgetUsed: this.tokenBudget.getDailyUsed(),
              budgetTotal: this.tokenBudget.getBudget(),
              budgetPercentage: this.tokenBudget.getUsagePercentage(),
            };
            (channel as CLIChannel).sendCompletion(elapsed, stepCount, completionMeta);
          }
        }
      } else {
        logger.debug('Internal prompt processed, no channel response needed');
      }

      const awaitsCloudAck = msg.channelType === 'web'
        && typeof msg.metadata?.externalConversationId === 'string'
        && typeof msg.metadata?.requestId === 'string';
      if (this.currentWorkKey && !awaitsCloudAck) this.workLedger.markDelivered(this.currentWorkKey);

      this.lifecycle.transition('idle');
    } catch (err) {
      logger.error({ err }, 'Error handling message');
      const ledgerEntry = this.currentWorkKey ? this.workLedger.get(this.currentWorkKey) : undefined;
      if (this.currentWorkKey) {
        if (ledgerEntry?.status === 'completed') this.workLedger.markDeliveryError(this.currentWorkKey, err);
        else if (ledgerEntry?.status !== 'failed') {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.workLedger.markFailed(
            this.currentWorkKey,
            err,
            `I encountered an unexpected error and couldn't finish: ${errMsg.slice(0, 200)}`,
          );
        }
      }
      if (ledgerEntry?.status === 'completed') {
        logger.warn({ err, workKey: this.currentWorkKey }, 'Final response persisted but delivery did not complete; retaining for replay');
        return;
      }
      // Always notify the user — they should never have to re-prompt
      // to find out their task died.
      const catchChannel = this.channels.getChannelForMessage(msg);
      if (catchChannel && msg.channelType !== 'internal') {
        const errMsg = err instanceof Error ? err.message : String(err);
        try {
          const finalError = `I encountered an unexpected error and couldn't finish: ${errMsg.slice(0, 200)}`;
          const delivered = catchChannel instanceof WebChannel ? catchChannel.sendError(finalError, msg.channelId) : true;
          if (!(catchChannel instanceof WebChannel)) await catchChannel.send(finalError, msg.channelId);
          const awaitsCloudAck = msg.channelType === 'web'
            && typeof msg.metadata?.externalConversationId === 'string'
            && typeof msg.metadata?.requestId === 'string';
          if (this.currentWorkKey && delivered && !awaitsCloudAck) this.workLedger.markDelivered(this.currentWorkKey);
          if (this.currentWorkKey && !delivered) this.workLedger.markDeliveryError(this.currentWorkKey, 'Terminal error delivery was not accepted');
        } catch (sendErr) {
          if (this.currentWorkKey) this.workLedger.markDeliveryError(this.currentWorkKey, sendErr);
          logger.warn({ sendErr }, 'Failed to notify user of handler error');
        }
      }
      // Write crash flag so next startup also reports the failure.
      try {
        const { writeCrashFlag } = await import('./crash-flag.js');
        writeCrashFlag({
          reason: `Unhandled agent error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
          timestamp: Date.now(),
          activeTask: this.currentActivity || undefined,
          channelId: msg.channelId || undefined,
          channelType: msg.channelType || undefined,
        });
      } catch { /* best effort */ }
      this.lifecycle.transition('idle');
    } finally {
      stopHeartbeat();
      this.finalizeChannelTask(msg);
      this.currentMessage = null;
      this.currentAbort = null;
      this.currentAbortReason = null;
      this.currentActivity = '';
      this.completedStepCount = 0;
      this.stepNarrative = [];
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
    const programmingSuffix = this.programmingMode.getSystemPromptSuffix();
    if (programmingSuffix) {
      prompt += programmingSuffix;
    }
    const researchSuffix = this.researchMode.getSystemPromptSuffix();
    if (researchSuffix) {
      prompt += researchSuffix;
    }
    const budgetStatus = this.tokenBudget.getStatusText();
    prompt += '\n\n' + budgetStatus;
    if (this.tokenBudget.getUsagePercentage() > 70) {
      prompt += '\nBe concise to conserve tokens.';
    }
    const saverSuffix = this.saverMode.getSystemPromptSuffix();
    if (saverSuffix) {
      prompt += saverSuffix;
    }

    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    prompt += `\n\nEnvironment:\n- Date: ${dateStr}, ${timeStr} (${timezone})\n- Platform: ${process.platform}\n- Working directory: ${this.capabilities.getCwd()}`;

    prompt += `\n\n**Tool Usage Guidelines:**
- Use write_file, create_file, and edit_file tools DIRECTLY to create and modify files. Do NOT create intermediary scripts (Python, bash, Node.js) whose sole purpose is to generate other files — you have native file tools for this.
- Use run_command for: building, testing, installing dependencies, running the project, git operations, and other system tasks that require a shell.
- Do NOT use run_command with echo/cat/tee/heredoc to write files. Use write_file or create_file instead.
- Do NOT create one-time-use helper scripts. If the user asks you to create a file, create it directly with create_file or write_file.
- When creating multiple files, call create_file or write_file for each one individually. Do not batch them into a script.`;

    if (this.userMemory) {
      const summary = this.userMemory.getSummary();
      prompt += `\n\nSecond Brain (SQLite-backed long-term memory) is ENABLED. You have ${summary.total} persistent memories about this user.`;
      prompt += `\nMemory types: identity, preference, goal, project, habit, decision, constraint, relationship, episode, reflection.`;
      prompt += `\n\nCRITICAL — Memory storage rules:`;
      prompt += `\n- ALL persistent user knowledge lives in the Second Brain SQLite database — this is the single source of truth.`;
      prompt += `\n- NEVER use create_file, write_file, edit_file, or any file tool to store memories, notes, facts, preferences, or brain data. Files are for code and documents, not for knowledge storage.`;
      prompt += `\n- New memories are extracted AUTOMATICALLY after each conversation turn. You do not need to ask the user if they want to save something.`;
      prompt += `\n- When the user explicitly asks you to "save/remember/note/keep this," use the save_memory tool to store it directly — no follow-up questions needed.`;
      prompt += `\n- When you need to actively recall something beyond auto-injected context (e.g. "do you remember...", "what do I know about..."), use the search_memory tool.`;
      prompt += `\n- Relevant memories are auto-injected before each message. You can reference them naturally (e.g. "I remember you prefer TypeScript").`;
      prompt += `\n- Users can manage memory with: /memory (overview, search, pause learning, clear).`;
      if (summary.learningPaused) {
        prompt += `\n\nLearning is currently PAUSED — no new memories will be extracted or saved until resumed.`;
      }
    } else {
      prompt += '\n\nSecond Brain is DISABLED. Basic long-term memory (text search over facts) is still active.';
    }

    // Notification routing guidance for tweet-notifier skill
    const skillNames = this.capabilities.getSkillContext();
    if (skillNames.includes('tweet-notifier')) {
      prompt += `\n\n**Tweet Notification System Available** — The tweet-notifier skill is installed.
When you need to schedule tweets, manage approvals, or notify founders/supporters:
1. Use the \`use_skill\` tool to invoke the \`tweet-notifier\` skill for detailed instructions
2. The skill provides templates for scheduling tweets, notifying founders (via send_message), and alerting supporters (approved Telegram users)
3. Key tools used by this system: schedule_task (for timing), send_message (for notifications to Telegram), save_memory (for tweet state tracking), search_memory (for checking existing tweets)
4. Supporters are all approved Telegram users — send_message will reach them
5. The founder (Optimus Prime) receives notifications via send_message (Telegram)`;
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
        ).catch((e) => logger.warn({ e }, 'channel send failed'));
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
        if (pruning.movedToSubconscious > 0 || pruning.hardDeleted > 0 || pruning.promoted > 0) {
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
        system: `You extract structured memory from conversations. Output a JSON array of 0-3 memory candidates.

Each candidate: { type, categories, summary (concise fact, 12-220 chars), detail (optional explanation), evidenceKind ("direct" if explicitly stated, "inferred" if deduced), confidence (0-1), importance (0-1), durability (0-1) }

TYPE DEFINITIONS (pick the single most specific one):
- identity: who the user IS — their name, role, job title, self-description
- relationship: other people the user knows — MUST include the person's name in summary
- preference: likes, dislikes, style choices, opinions
- goal: aspirations, targets, things they want to achieve
- project: specific ongoing work, initiatives, things being built
- habit: routines, recurring behaviors, schedules
- decision: choices made, commitments, selected approaches
- constraint: limitations, rules they follow, things they avoid
- episode: notable one-time events worth remembering

CATEGORIES (pick 1-3 domain buckets that best fit this memory):
- personal: the user's private life, non-work
- health: medical, physical, mental wellbeing
- family: family members, family relationships
- work: job, professional, career
- finance: money, spending, investments
- technical: programming, tools, engineering
- education: learning, study, courses
- social: friends, social life, community
- travel: trips, places, geography
- general: anything that doesn't fit the above

RULES:
- Each semantic fact must appear EXACTLY ONCE. Never store the same information under multiple types.
- If a fact is about someone else's role/relationship to the user, use "relationship" (not "identity").
- "identity" is ONLY for the user themselves.
- For relationships, always name the person: "Salman is user's co-developer" not "User works with a co-developer".
- Only extract specific, durable, user-specific information.
- Do NOT extract trivial observations, greetings, or assistant behavior.
- "categories" must be an array of 1-3 lowercase strings from the list above. If none fit, suggest a new single-word lowercase category.
- Output pure JSON array, no markdown fences.`,
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
        agentId: this.config.cloud.agentId || undefined,
      });
      this.syncTokenInfoToCli();

      const text = result.text.trim();
      if (!text) return;

      let candidates: Array<{
        type: string;
        categories?: string[];
        summary: string;
        detail?: string;
        evidenceKind?: string;
        confidence: number;
        importance: number;
        durability: number;
      }>;

      try {
        const jsonStr = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
        const parsed = JSON.parse(jsonStr);
        // Handle both single object and array of objects
        candidates = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        const facts = text
          .split('\n')
          .map(l => l.replace(/^-\s*/, '').trim())
          // Skip JSON-like lines (key-value pairs, braces, brackets)
          .filter(f => f.length > 10 && f.length < 200 && !/^["{\[\]}]|":\s*"/.test(f));
        candidates = facts.slice(0, 3).map(f => ({
          type: 'preference',
          categories: ['general'],
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
        .map(c => {
          // Normalise categories: must be array of strings, 1-3, lowercase, trimmed.
          let cats: string[] = ['general'];
          if (Array.isArray(c.categories) && c.categories.length > 0) {
            const cleaned = c.categories
              .map((cat: unknown) => String(cat).trim().toLowerCase())
              .filter((cat: string) => cat.length > 0)
              .slice(0, 3);
            if (cleaned.length > 0) cats = cleaned;
          }
          return {
            type: c.type as any,
            categories: cats,
            summary: c.summary,
            detail: c.detail,
            evidenceKind: (c.evidenceKind === 'direct' ? 'direct' : 'inferred') as 'direct' | 'inferred',
            confidence: Math.min(1, Math.max(0, c.confidence ?? 0.7)),
            importance: Math.min(1, Math.max(0, c.importance ?? 0.7)),
            durability: Math.min(1, Math.max(0, c.durability ?? 0.7)),
          };
        });

      if (typed.length > 0) {
        const remembered = this.userMemory.remember(typed, 'conversation');
        if (remembered.length > 0) {
          logger.info({ count: remembered.length, types: remembered.map(r => r.type) }, 'Second brain memories stored');
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Memory extraction error');
    }
  }

  async shutdown(): Promise<void> {
    if (this.supervisor) {
      await this.supervisor.haltAll();
    }
    this.backgroundTasks.destroy();
    this.providers.destroy();
    await this.sleep();
    logger.info('Mercury has shut down');
  }

  /**
   * Notify all active channels with a message. Used before forced exits
   * (SIGTERM, crash, watchdog kill) so the user is never left wondering
   * what happened to their task.
   */
  async notifyAllChannels(message: string): Promise<void> {
    const active = this.channels.getActiveChannels();
    const sends = active.map((type) => {
      const ch = this.channels.get(type);
      if (!ch) return Promise.resolve();
      return ch.send(message).catch((e) => {
        logger.warn({ e, channel: type }, 'Failed to notify channel before exit');
      });
    });
    await Promise.allSettled(sends);
  }

  /**
   * AI self-check: ask the model itself whether repeated tool usage is productive or a loop.
   * Used in allow-all mode instead of prompting the user.
   * Returns true if the AI thinks it should continue, false if it should stop.
   */
  private async aiSelfCheck(context: {
    toolName: string;
    callCount: number;
    recentCalls: string[];
    taskDescription: string;
  }): Promise<boolean> {
    try {
      const provider = this.providers.getDefault();
      if (!provider) return true; // no provider = let it continue

      const selfCheckResult = await generateText({
        model: provider.getModelInstance(),
        system: `You are Mercury Autopilot, a monitoring system inside an AI coding agent. Your job is to determine whether repeated tool usage is productive iteration or a stuck loop.

Productive patterns (CONTINUE):
- Fetching multiple different URLs (e.g., scraping articles, reading docs)
- Reading multiple different files to understand a codebase
- Editing different sections of code across files
- Running different commands (build, test, lint, deploy)
- Creating multiple files for a project

Stuck patterns (STOP):
- Same exact call repeated with identical parameters
- Retrying the same failing operation with minor variations
- Reading the same file over and over
- Running the same failing command repeatedly

Respond with ONLY "CONTINUE" or "STOP" followed by a one-line reason.`,
        messages: [{
          role: 'user',
          content: `Tool "${context.toolName}" called ${context.callCount} times consecutively.

User's task: ${context.taskDescription}

Recent calls (newest last):
${context.recentCalls.join('\n')}

Is this productive iteration or a stuck loop?`,
        }],
        maxOutputTokens: 80,
      });

      const answer = (selfCheckResult.text || '').trim().toUpperCase();
      const shouldContinue = answer.startsWith('CONTINUE');
      logger.info({
        toolName: context.toolName,
        count: context.callCount,
        decision: shouldContinue ? 'continue' : 'stop',
        reason: selfCheckResult.text?.trim().slice(0, 120),
      }, 'Mercury Autopilot verdict');
      return shouldContinue;
    } catch (err) {
      logger.warn({ err }, 'Mercury Autopilot self-check failed — defaulting to continue');
      return true; // on failure, be permissive
    }
  }

  setSpotifyClient(client: SpotifyClient): void {
    this.spotifyClient = client;
  }

  async presentChoice(question: string, choices: string[], channelId: string, channelType: string): Promise<string> {
    const channel = this.channels.get(channelType as any);

    if (channelType === 'cli' && channel instanceof CLIChannel) {
      const options = choices.map((label, i) => ({
        value: String(i),
        label,
      }));

      const selected = await channel.presentChoicePrompt(question, options);
      const index = parseInt(selected, 10);
      return isNaN(index) ? choices[0] : (choices[index] ?? choices[0]);
    }

    if (channelType === 'web' && channel instanceof WebChannel) {
      const options = choices.map((label, i) => ({
        value: String(i),
        label,
      }));

      const selected = await channel.presentChoicePrompt(question, options, channelId);
      const index = parseInt(selected, 10);
      return isNaN(index) ? choices[0] : (choices[index] ?? choices[0]);
    }

    if (channelType === 'telegram' && channel instanceof TelegramChannel) {
      const options = choices.map((label, i) => ({
        value: String(i),
        label,
      }));

      const selected = await channel.presentChoicePrompt(question, options, channelId);
      const index = parseInt(selected, 10);
      return isNaN(index) ? choices[0] : (choices[index] ?? choices[0]);
    }

    await channel?.send(`${question}\n${choices.map((c, i) => `  ${i + 1}. ${c}`).join('\n')}`, channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
    return choices[0];
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
      this.syncTokenInfoToCli();
      await channel.send(`Usage reset to zero. ${this.tokenBudget.getStatusText()}`, channelId);
    } else if (action === 'set' || action === '3') {
      const newBudget = parseInt(parts[1], 10);
      if (isNaN(newBudget) || newBudget <= 0) {
        await channel.send('Please specify the new budget. Usage: `/budget set 100000` or type e.g. `3 100000`', channelId);
        return;
      }
      this.tokenBudget.setBudget(newBudget);
      this.syncTokenInfoToCli();
      await channel.send(`Daily budget updated to ${newBudget.toLocaleString()} tokens. ${this.tokenBudget.getStatusText()}`, channelId);
    } else if (action === 'cancel' || action === '4') {
      await channel.send(`Cancelled. ${this.tokenBudget.getStatusText()}`, channelId);
    } else if (!action || action === 'status') {
      await channel.send(this.tokenBudget.getStatusText(), channelId);
    } else {
      await channel.send(`Unknown budget command "${action}". Available: /budget, /budget override, /budget reset, /budget set <number>, /budget status`, channelId);
    }
  }

  /**
   * Handle the /saver slash command — Token Saver Mode controls.
   * Subcommands: (empty)|status|on|off|toggle|threshold <n>|auto on|off|routing on|off|stats
   */
  async handleSaverCommand(subcommand: string, channelType: string, channelId: string): Promise<void> {
    const channel = this.channels.get(channelType as any);
    if (!channel) return;

    const parts = subcommand.trim().split(/\s+/).filter(Boolean);
    const action = (parts[0] || '').toLowerCase();
    const arg = (parts[1] || '').toLowerCase();

    const showStatus = async () => {
      const text = this.saverMode.getStatusText(
        this.tokenBudget.getSavedLifetime(),
        this.tokenBudget.getSavedToday(),
      );
      const usagePct = Math.round(this.tokenBudget.getUsagePercentage());
      await channel.send(`${text}\nCurrent daily usage: ${usagePct}%`, channelId);
      this.syncSaverToCli();
    };

    if (!action || action === 'status' || action === 'stats') {
      await showStatus();
      return;
    }

    if (action === 'on' || action === 'enable') {
      this.saverMode.enable();
      await channel.send(
        '⚡ Token Saver Mode enabled. Responses will be terser, step limits lower, and history window shorter to conserve tokens.',
        channelId,
      );
      this.syncSaverToCli();
      return;
    }

    if (action === 'off' || action === 'disable') {
      this.saverMode.disable();
      await channel.send('Token Saver Mode disabled. Normal response settings restored.', channelId);
      this.syncSaverToCli();
      return;
    }

    if (action === 'toggle') {
      const next = this.saverMode.toggle();
      await channel.send(
        next === 'on'
          ? '⚡ Token Saver Mode enabled.'
          : 'Token Saver Mode disabled.',
        channelId,
      );
      this.syncSaverToCli();
      return;
    }

    if (action === 'threshold') {
      const n = parseInt(parts[1], 10);
      if (isNaN(n) || n < 0 || n > 100) {
        await channel.send('Usage: /saver threshold <0-100> — percentage of daily budget at which saver auto-engages. Set 0 to disable.', channelId);
        return;
      }
      this.saverMode.setAutoThreshold(n);
      await channel.send(
        n === 0
          ? 'Saver auto-engage disabled (threshold set to 0).'
          : `Saver auto-engage threshold set to ${n}% of daily budget.`,
        channelId,
      );
      return;
    }

    if (action === 'auto') {
      if (arg === 'on' || arg === 'enable') {
        this.saverMode.setAutoEnabled(true);
        await channel.send(`Saver auto-engage enabled (at ${this.saverMode.getAutoThreshold()}% usage).`, channelId);
      } else if (arg === 'off' || arg === 'disable') {
        this.saverMode.setAutoEnabled(false);
        await channel.send('Saver auto-engage disabled. Saver will only activate when you run /saver on.', channelId);
        this.syncSaverToCli();
      } else {
        await channel.send(
          `Saver auto-engage is currently ${this.saverMode.isAutoEnabled() ? 'ON' : 'OFF'} (threshold: ${this.saverMode.getAutoThreshold()}%).\nUse /saver auto on|off to change.`,
          channelId,
        );
      }
      return;
    }

    if (action === 'routing') {
      if (arg === 'on' || arg === 'enable') {
        this.saverMode.setRoutingEnabled(true);
        await channel.send('Saver cheap-provider routing enabled (when saver is active, cheaper providers will be preferred).', channelId);
      } else if (arg === 'off' || arg === 'disable') {
        this.saverMode.setRoutingEnabled(false);
        await channel.send('Saver cheap-provider routing disabled.', channelId);
      } else {
        await channel.send(`Saver cheap-provider routing is currently ${this.saverMode.isRoutingEnabled() ? 'ON' : 'OFF'}.\nUse /saver routing on|off to change.`, channelId);
      }
      return;
    }

    await channel.send(
      'Unknown saver command. Available:\n' +
      '  /saver — show status and savings\n' +
      '  /saver on — manually enable\n' +
      '  /saver off — disable\n' +
      '  /saver toggle — flip on/off\n' +
      '  /saver threshold <0-100> — auto-engage threshold (default 75)\n' +
      '  /saver auto on|off — enable/disable auto-engagement\n' +
      '  /saver routing on|off — prefer cheap providers while active (opt-in)',
      channelId,
    );
  }

  /** Push the current saver state to the CLI status bar if present. */
  private syncSaverToCli(): void {
    const ch = this.channels.get('cli');
    if (ch && (ch as any).setSaverMode) {
      (ch as any).setSaverMode(
        this.saverMode.getState(),
        this.tokenBudget.getSavedToday(),
        this.tokenBudget.getSavedLifetime(),
      );
    }
  }

  private syncTokenInfoToCli(): void {
    const ch = this.channels.get('cli');
    if (ch && (ch as any).setTokenInfo) {
      (ch as any).setTokenInfo(
        this.tokenBudget.getDailyUsed(),
        this.tokenBudget.getBudget(),
        Math.round(this.tokenBudget.getUsagePercentage()),
      );
    }
  }

  private async handleSkillsSlashCommand(
    trimmed: string,
    channel: any,
    channelId: string,
    ctx: { skillNames: () => string[] },
  ): Promise<void> {
    const parts = trimmed.split(/\s+/).slice(1);
    const sub = (parts[0] || 'list').toLowerCase();
    const args = parts.slice(1);
    const arg = args.join(' ').trim();

    const { RegistryClient, isValidSkillId, searchFeed } = await import('../skills/registry.js');
    const { SkillStore } = await import('../skills/store.js');
    const registry = new RegistryClient();
    const store = new SkillStore({ registry });

    try {
      switch (sub) {
        case 'help':
        case '-h':
        case '--help': {
          await channel.send(
            [
              '**Mercury Skills — in-chat commands**',
              '',
              '`/skills` — list installed skills',
              '`/skills search <query>` — search the registry',
              '`/skills view <id>` — show details + registry URL',
              '`/skills install <id>` — install from the registry',
              '`/skills install <url>` — install raw SKILL.md from a URL',
              '`/skills remove <id>` — uninstall',
              '',
              'Browse the full catalog at https://skills.mercuryagent.sh',
            ].join('\n'),
            channelId,
          );
          return;
        }

        case 'list': {
          const names = ctx.skillNames();
          if (names.length === 0) {
            await channel.send(
              'No skills installed. Try `/skills search <query>` to browse https://skills.mercuryagent.sh.',
              channelId,
            );
            return;
          }
          const lines = [
            `**${names.length} skill${names.length > 1 ? 's' : ''} installed:**`,
            '',
            ...names.map((n) => `• ${n}`),
            '',
            '_Run `/skills search <query>` to find more on the registry._',
          ];
          await channel.send(lines.join('\n'), channelId);
          return;
        }

        case 'search':
        case 'find': {
          if (!arg) {
            await channel.send('Usage: `/skills search <query>`', channelId);
            return;
          }
          await channel.send(`🔍 Searching the registry for "${arg}"…`, channelId);
          const feed = await registry.getFeed();
          const scored = searchFeed(feed, arg, 5);
          if (scored.length === 0) {
            await channel.send(`No matches for "${arg}".`, channelId);
            return;
          }
          const lines = scored.map(({ skill }) =>
            [
              `• \`${skill.id}\` (v${skill.version})`,
              `  ${skill.description}`,
              `  ${registry.webUrl(skill.id)}`,
            ].join('\n'),
          );
          await channel.send(
            [
              `**Top ${scored.length} matches for "${arg}":**`,
              '',
              lines.join('\n\n'),
              '',
              'Inspect one with `/skills view <id>`, install with `/skills install <id>`.',
            ].join('\n'),
            channelId,
          );
          return;
        }

        case 'view':
        case 'show':
        case 'info': {
          if (!arg) {
            await channel.send('Usage: `/skills view <category/slug>`', channelId);
            return;
          }
          if (!isValidSkillId(arg)) {
            await channel.send('Invalid skill id. Expected `<category>/<slug>`.', channelId);
            return;
          }
          const detail = await registry.getSkill(arg);
          const author = detail.author ? `\n**Author:** ${detail.author}` : '';
          const tags = detail.tags?.length ? `\n**Tags:** ${detail.tags.join(', ')}` : '';
          await channel.send(
            [
              `**${detail.title}** (\`${detail.id}\`)`,
              `**Version:** ${detail.version}`,
              `**Category:** ${detail.category}${author}${tags}`,
              '',
              detail.description,
              '',
              `🔗 ${registry.webUrl(detail.id)}`,
              '',
              `Install with \`/skills install ${detail.id}\``,
            ].join('\n'),
            channelId,
          );
          return;
        }

        case 'install':
        case 'add': {
          if (!arg) {
            await channel.send('Usage: `/skills install <category/slug>` or `/skills install <url>`', channelId);
            return;
          }
          // URL install → delegate to the existing capability path
          if (/^https?:\/\//i.test(arg)) {
            const { SkillLoader } = await import('../skills/loader.js');
            const loader = new SkillLoader();
            await channel.send(`📦 Installing from \`${arg}\`…`, channelId);
            const installed = await loader.installFromUrl(arg);
            await channel.send(
              `✅ Installed \`${installed.name}\` from URL.\n${installed.skillDir}`,
              channelId,
            );
            return;
          }
          if (!isValidSkillId(arg)) {
            await channel.send('Invalid skill id. Expected `<category>/<slug>` or a `https://` URL.', channelId);
            return;
          }
          await channel.send(`📦 Installing \`${arg}\` from the registry…`, channelId);
          const result = await store.install(arg);
          const verb =
            result.status === 'already-installed'
              ? 'Already installed'
              : result.status === 'updated'
                ? 'Updated'
                : result.status === 'reinstalled'
                  ? 'Reinstalled'
                  : 'Installed';
          await channel.send(
            `✅ ${verb} \`${result.id}\` (v${result.version})\n🔗 ${registry.webUrl(result.id)}`,
            channelId,
          );
          return;
        }

        case 'remove':
        case 'rm':
        case 'delete':
        case 'uninstall': {
          if (!arg) {
            await channel.send('Usage: `/skills remove <category/slug>`', channelId);
            return;
          }
          if (!isValidSkillId(arg)) {
            await channel.send('Invalid skill id. Expected `<category>/<slug>`.', channelId);
            return;
          }
          const removed = store.remove(arg);
          await channel.send(
            removed ? `🗑 Removed \`${arg}\`.` : `Skill \`${arg}\` is not installed.`,
            channelId,
          );
          return;
        }

        default:
          await channel.send(
            `Unknown subcommand \`${sub}\`. Try \`/skills help\`.`,
            channelId,
          );
      }
    } catch (err: any) {
      const msg = err?.message || 'Skill registry request failed';
      await channel.send(`⚠️ ${msg}`, channelId);
    }
  }

  private async handleChatCommand(content: string, channelType: string, channelId: string): Promise<boolean> {
    const trimmed = content.trim();
    const cmd = trimmed.toLowerCase();
    const channel = this.channels.get(channelType as any);
    if (!channel) return false;

    const ctx = this.capabilities.getChatCommandContext();
    if (!ctx) return false;

    if (cmd === '/sessions' || cmd.startsWith('/session')) {
      await this.handleSessionCommand(trimmed, channelType as ChannelType, channelId);
      return true;
    }

    if (cmd === '/help') {
      const helpText = channelType === 'telegram' ? getTelegramHelp() : channelType === 'discord' ? getDiscordHelp() : channelType === 'slack' ? getSlackHelp() : ctx.manual();
      await channel.send(helpText, channelId);
      return true;
    }

    if (cmd === '/saver' || cmd.startsWith('/saver ')) {
      await this.handleSaverCommand(trimmed.slice('/saver'.length).trim(), channelType, channelId);
      return true;
    }

    if (cmd.startsWith('/bg')) {
      await this.handleBgCommand(trimmed, { content: trimmed, channelId, channelType: channelType as any, id: Date.now().toString(36), senderId: 'user', timestamp: Date.now() }, channel);
      return true;
    }

    if (cmd === '/progress' || cmd === '/still') {
      if (!this.processing || !this.currentMessage) {
        await channel.send('No active foreground task.', channelId);
        return true;
      }
      const elapsedSec = Math.round((Date.now() - this.currentMessage.timestamp) / 1000);
      const stepInfo = this.completedStepCount > 0 ? ` · step ${this.completedStepCount}/${MAX_STEPS}` : '';
      const narrative = formatNarrative(this.stepNarrative, this.currentActivity, 10);
      const narrativeBlock = narrative ? `\n${narrative}` : '';
      await channel.send(
        `⏳ Task in progress (${elapsedSec}s${stepInfo})${narrativeBlock}\nUse /bg current to move it to background.`,
        channelId,
      );
      return true;
    }

    if (cmd === '/exit' || cmd === '/quit') {
      await channel.send('Goodbye! Shutting down Mercury...', channelId);
      this.shutdown();
      return true;
    }

    if (cmd === '/permissions') {
      if (channelType === 'cli' && channel instanceof CLIChannel) {
        const mode = await channel.askPermissionMode?.();
        if (mode === 'allow-all') {
          this.capabilities.permissions.setAutoApproveAll(true);
          this.capabilities.permissions.addTempScope('/', true, true);
          await channel.send('Allow All mode active for this session. All scopes, commands, and loops auto-approved. Resets on restart.', channelId);
        } else {
          this.capabilities.permissions.setAutoApproveAll(false);
          await channel.send('Ask Me mode active. Risky actions will prompt for confirmation.', channelId);
        }
        return true;
      }
      await channel.send('Use /permissions in CLI to switch permission mode. On Telegram, use the /permissions button or command.', channelId);
      return true;
    }

    if (cmd === '/status') {
      const config = ctx.config();
      const budget = ctx.tokenBudget();
      const saver = this.saverMode.getState();
      const saverLine = saver === 'off'
        ? `Saver: off (auto at ${this.saverMode.getAutoThreshold()}%)`
        : `Saver: ${saver.toUpperCase()} · saved today ~${this.tokenBudget.getSavedToday().toLocaleString()} tokens`;
      const lines = [
        `**${config.identity.name}** — Status`,
        `Owner: ${config.identity.owner || '(not set)'}`,
        `Provider: ${config.providers.default}`,
        `Telegram: ${config.channels.telegram.enabled ? 'enabled' : 'disabled'}`,
        `Telegram access: ${getTelegramAccessSummary(config)}`,
        `Discord: ${config.channels.discord.enabled ? 'enabled' : 'disabled'}`,
        `Discord access: ${getDiscordAccessSummary(config)}`,
        `Slack: ${config.channels.slack.enabled ? 'enabled' : 'disabled'}`,
        `Slack access: ${getSlackAccessSummary(config)}`,
        `Budget: ${budget.getStatusText()}`,
        saverLine,
        `Skills: ${ctx.skillNames().length > 0 ? ctx.skillNames().join(', ') : 'none'}`,
      ];
      await channel.send(lines.join('\n'), channelId);
      return true;
    }

    if (cmd === '/models' || cmd === '/model' || cmd.startsWith('/models ') || cmd.startsWith('/model ')) {
      const base = cmd.startsWith('/model ') || cmd === '/model' ? '/model' : '/models';
      const rawArgs = trimmed.slice(base.length).trim();
      const activeProviders = getActiveProviders(this.config);
      const current = this.providers.getDefault();

      if (!rawArgs) {
        const lines = [
          '**Session Models**',
          '',
          ...activeProviders.map((p) => {
            const marker = p.name === current.name ? ' ← current' : '';
            return `• ${p.name} · ${p.model}${marker}`;
          }),
          '',
          'Use `/models use <provider>` to switch for this session.',
          'Use `mercury doctor` to add/configure models.',
        ];
        await channel.send(lines.join('\n'), channelId);

        if (channelType === 'cli' && channel instanceof CLIChannel && activeProviders.length > 1) {
          const choices = [
            ...activeProviders.map((p) => `${p.name} · ${p.model}${p.name === current.name ? ' (current)' : ''}`),
            'Open doctor instructions',
            'Keep current model',
          ];
          const picked = await this.presentChoice('Switch session model?', choices, channelId, channelType);
          if (picked === 'Open doctor instructions') {
            await channel.send('Run `mercury doctor` and update provider/model settings. Then restart Mercury to persist defaults.', channelId);
            return true;
          }
          if (picked === 'Keep current model') return true;
          const providerName = picked.split(' · ')[0].trim();
          if (providerName && providerName !== current.name) {
            const switched = await this.switchSessionProvider(providerName);
            await channel.send(switched.message, channelId);
          }
        }
        return true;
      }

      if (rawArgs === 'doctor' || rawArgs === 'add') {
        await channel.send('Use `mercury doctor` to add/configure models. Then use `/models` to switch active session model.', channelId);
        return true;
      }

      const target = rawArgs.replace(/^use\s+/i, '').trim();
      if (!target) {
        await channel.send('Usage: `/models` or `/models use <provider>`', channelId);
        return true;
      }

      const switched = await this.switchSessionProvider(target);
      await channel.send(switched.message, channelId);
      return true;
    }

    if (cmd === '/cloud' || cmd.startsWith('/cloud ')) {
      const cfg = ctx.config();
      if (!cfg.cloud.enabled || !cfg.cloud.jwt) {
        await channel.send('Mercury Cloud is not connected. Run `mercury cloud connect` to set it up.', channelId);
        return true;
      }

      const sub = trimmed.slice('/cloud'.length).trim();

      const ensureFreshToken = async (): Promise<string> => {
        try {
          const store = getCloudTokenStore();
          if (store) {
            return await store.rotateIfExpired();
          }
          const parts = cfg.cloud.jwt.split('.');
          if (parts.length === 3) {
            const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
            const exp = payload.exp * 1000;
            if (Date.now() > exp - 60_000 && cfg.cloud.refreshToken) {
              const { refreshToken } = await import('../cloud/pairing.js');
              const result = await refreshToken(cfg.cloud.apiUrl, cfg.cloud.refreshToken);
              cfg.cloud.jwt = result.jwt;
              cfg.cloud.refreshToken = result.refreshToken;
              cfg.providers.mercuryCloud.apiKey = result.jwt;
              const { saveConfig } = await import('../utils/config.js');
              saveConfig(cfg);
              this.config = cfg;
              return result.jwt;
            }
          }
        } catch {}
        return cfg.cloud.jwt;
      };

      if (!sub || sub === 'models' || sub === 'model') {
        try {
          const jwt = await ensureFreshToken();
          const res = await fetch(`${cfg.cloud.apiUrl}/v1/models`, {
            headers: { Authorization: `Bearer ${jwt}` },
          });
          if (!res.ok) {
            await channel.send(`Failed to fetch cloud models (HTTP ${res.status}). Your token may have expired — run \`mercury cloud login\`.`, channelId);
            return true;
          }
          const data = await res.json() as { data: Array<{ id: string; label: string; tier_required: string; context_window: number; available: boolean; is_branded?: boolean; discount_percent?: number }> };
          const models = data.data || [];
          if (models.length === 0) {
            await channel.send('No models available.', channelId);
            return true;
          }

          const currentModel = cfg.providers.mercuryCloud?.model || '—';
          const branded = models.filter((m) => m.is_branded);
          const raw = models.filter((m) => !m.is_branded);

          const formatModel = (m: typeof models[0]) => {
            const marker = m.id === currentModel ? ' ← current' : '';
            const lock = m.available ? '' : ' 🔒';
            const discount = m.discount_percent && m.discount_percent > 0 ? ` (${m.discount_percent}% off input)` : '';
            return `• ${m.id} · ${m.label} (${m.tier_required})${discount}${lock}${marker}`;
          };

          const lines = [
            '**Mercury Cloud Models**',
            '',
            '**Mercury Branded**',
            ...branded.map(formatModel),
            '',
            '**Direct Models**',
            ...raw.map(formatModel),
            '',
            'Use `/cloud use <model-id>` to switch.',
          ];
          await channel.send(lines.join('\n'), channelId);

          if (channelType === 'cli' && channel instanceof CLIChannel) {
            const availableModels = models.filter((m) => m.available);
            const choices = [
              ...availableModels.map((m) => `${m.id} · ${m.label}${m.id === currentModel ? ' (current)' : ''}`),
              'Keep current model',
            ];
            if (availableModels.length <= 1) {
              await channel.send('Only one model available for your tier. Upgrade to unlock more.', channelId);
              return true;
            }
            const picked = await this.presentChoice('Switch cloud model?', choices, channelId, channelType);
            if (picked === 'Keep current model') return true;
            const modelId = picked.split(' · ')[0].trim();
            if (modelId) {
              cfg.providers.mercuryCloud.model = modelId;
              cfg.providers.mercuryCloud.enabled = true;
              cfg.providers.default = 'mercuryCloud';
              const { saveConfig } = await import('../utils/config.js');
              saveConfig(cfg);
              this.config = cfg;
              const provider = await createProvider(cfg.providers.mercuryCloud, getCloudTokenStore());
              this.providers.set('mercuryCloud', provider);
              this.providers.setDefault('mercuryCloud');
              updateCliProviderStatus(this.channels.get('cli'), 'mercuryCloud', modelId);
              await channel.send(`✓ Switched to **${modelId}**. Saved to config.`, channelId);
            }
          }
        } catch (err) {
          await channel.send(`Error fetching cloud models: ${(err as Error).message}`, channelId);
        }
        return true;
      }

      if (sub.startsWith('use ')) {
        const modelId = sub.slice(4).trim();
        if (!modelId) {
          await channel.send('Usage: `/cloud use <model-id>`', channelId);
          return true;
        }
        await ensureFreshToken();
        try {
          cfg.providers.mercuryCloud.model = modelId;
          cfg.providers.mercuryCloud.enabled = true;
          if (cfg.providers.default !== 'mercuryCloud') {
            cfg.providers.default = 'mercuryCloud';
          }
          const { saveConfig } = await import('../utils/config.js');
          saveConfig(cfg);
          this.config = cfg;
          const provider = await createProvider(cfg.providers.mercuryCloud, getCloudTokenStore());
          this.providers.set('mercuryCloud', provider);
          this.providers.setDefault('mercuryCloud');
          updateCliProviderStatus(this.channels.get('cli'), 'mercuryCloud', modelId);
          await channel.send(`✓ Switched to **${modelId}**. Saved to config.`, channelId);
        } catch (err) {
          await channel.send(`Error switching model: ${(err as Error).message}`, channelId);
        }
        return true;
      }

      await channel.send('Usage: `/cloud models` to list, `/cloud use <model-id>` to switch', channelId);
      return true;
    }

    if (cmd === '/memory') {
      if (!this.userMemory) {
        const cfg = ctx.config();
        if (cfg.memory.secondBrain?.enabled === false) {
          await channel.send('Second brain is disabled in configuration.', channelId);
        } else {
          await channel.send('Second brain dependency issue: SQLite backend (better-sqlite3) is not available.', channelId);
        }
        return true;
      }

      if (channelType === 'cli' && channel instanceof CLIChannel) {
        await this.openCliMemoryMenu(channel, channelId);
        return true;
      }

      const choiceChannel = channel as typeof channel & { presentChoicePrompt?: (question: string, options: ArrowSelectOption[], targetId?: string) => Promise<string> };
      if (typeof choiceChannel.presentChoicePrompt === 'function') {
        await this.openMemoryChoiceMenu(choiceChannel, channelId);
        return true;
      }

      await this.sendMemoryOverview(channel, channelId);
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

    if (cmd.startsWith('/discord')) {
      if (channelType !== 'cli') {
        await channel.send('`/discord` is only available from the Mercury CLI chat.', channelId);
        return true;
      }

      const config = ctx.config();
      const rawSubcommand = trimmed.slice('/discord'.length).trim();
      const parts = rawSubcommand.split(/\s+/).filter(Boolean);
      const action = parts[0]?.toLowerCase() || 'help';
      const formatDiscordUser = (user: {
        userId: string;
        username?: string;
        displayName?: string;
        pairingCode?: string;
      }) => {
        const username = user.username ? ` (@${user.username})` : '';
        const displayName = user.displayName ? ` ${user.displayName}` : '';
        const pairingCode = user.pairingCode ? ` [code: ${user.pairingCode}]` : '';
        return `${user.userId}${username}${displayName}${pairingCode}`;
      };

      const sendDiscordOverview = async () => {
        const lines = [
          '**Discord Management**',
          '',
          `Access: ${getDiscordAccessSummary(config)}`,
          `Admins: ${config.channels.discord.admins.length > 0 ? config.channels.discord.admins.map(formatDiscordUser).join(', ') : 'none'}`,
          `Members: ${config.channels.discord.members.length > 0 ? config.channels.discord.members.map(formatDiscordUser).join(', ') : 'none'}`,
          `Pending: ${config.channels.discord.pending.length > 0 ? config.channels.discord.pending.map(formatDiscordUser).join(', ') : 'none'}`,
          '',
          'Commands:',
          '\u2022 `/discord pending`',
          '\u2022 `/discord users`',
          '\u2022 `/discord approve <pairing-code|user-id>`',
          '\u2022 `/discord reject <user-id>`',
          '\u2022 `/discord remove <user-id>`',
          '\u2022 `/discord reset`',
        ];
        await channel.send(lines.join('\n'), channelId);
      };

      if (action === 'help' || action === 'status') {
        await sendDiscordOverview();
        return true;
      }

      if (action === 'pending') {
        const pending = config.channels.discord.pending;
        const lines = [
          '**Discord Pending Requests**',
          '',
          pending.length > 0 ? pending.map(formatDiscordUser).join('\n') : 'No pending Discord requests.',
        ];
        await channel.send(lines.join('\n'), channelId);
        return true;
      }

      if (action === 'users') {
        const lines = [
          '**Discord Approved Users**',
          '',
          `Admins: ${config.channels.discord.admins.length > 0 ? config.channels.discord.admins.map(formatDiscordUser).join(', ') : 'none'}`,
          `Members: ${config.channels.discord.members.length > 0 ? config.channels.discord.members.map(formatDiscordUser).join(', ') : 'none'}`,
          '',
          `Total approved: ${config.channels.discord.admins.length + config.channels.discord.members.length}`,
        ];
        await channel.send(lines.join('\n'), channelId);
        return true;
      }

      if (action === 'approve') {
        const value = parts[1];
        if (!value) {
          await channel.send('Usage: `/discord approve <pairing-code|user-id>`', channelId);
          return true;
        }

        let approved = approveDiscordPendingRequestByPairingCode(config, value);
        let resultLabel = value;

        if (!approved) {
          approved = approveDiscordPendingRequest(config, value, 'member');
          resultLabel = value;
        }

        if (!approved) {
          await channel.send(`No pending Discord request found for \`${resultLabel}\`.`, channelId);
          return true;
        }

        saveConfig(config);
        await channel.send(`Approved Discord user ${formatDiscordUser(approved)}.`, channelId);
        return true;
      }

      if (action === 'reject') {
        const value = parts[1];
        if (!value) {
          await channel.send('Usage: `/discord reject <user-id>`', channelId);
          return true;
        }

        const rejected = rejectDiscordPendingRequestConfig(config, value);
        if (!rejected) {
          await channel.send(`No pending Discord request found for \`${value}\`.`, channelId);
          return true;
        }

        saveConfig(config);
        await channel.send(`Rejected Discord request for ${formatDiscordUser(rejected)}.`, channelId);
        return true;
      }

      if (action === 'remove') {
        const value = parts[1];
        if (!value) {
          await channel.send('Usage: `/discord remove <user-id>`', channelId);
          return true;
        }

        const removed = removeDiscordUser(config, value);
        if (!removed) {
          await channel.send(`No approved Discord user found for \`${value}\`.`, channelId);
          return true;
        }

        saveConfig(config);
        await channel.send(`Removed Discord access for ${formatDiscordUser(removed)}.`, channelId);
        return true;
      }

      if (action === 'reset' || action === 'unpair') {
        clearDiscordAccess(config);
        saveConfig(config);
        await channel.send('Discord access reset. New users can send /start in a DM to begin pairing again.', channelId);
        return true;
      }

      await channel.send(
        `Unknown Discord command "${action}". Try \`/discord\`, \`/discord pending\`, or \`/discord users\`.`,
        channelId,
      );
      return true;
    }

    if (cmd.startsWith('/slack')) {
      if (channelType !== 'cli') {
        await channel.send('`/slack` is only available from the Mercury CLI chat.', channelId);
        return true;
      }

      const config = ctx.config();
      const rawSubcommand = trimmed.slice('/slack'.length).trim();
      const parts = rawSubcommand.split(/\s+/).filter(Boolean);
      const action = parts[0]?.toLowerCase() || 'help';
      const formatSlackUser = (user: {
        userId: string;
        userName?: string;
        displayName?: string;
        pairingCode?: string;
      }) => {
        const userName = user.userName ? ` (@${user.userName})` : '';
        const displayName = user.displayName ? ` ${user.displayName}` : '';
        const pairingCode = user.pairingCode ? ` [code: ${user.pairingCode}]` : '';
        return `${user.userId}${userName}${displayName}${pairingCode}`;
      };

      const sendSlackOverview = async () => {
        const lines = [
          '**Slack Management**',
          '',
          `Access: ${getSlackAccessSummary(config)}`,
          `Admins: ${config.channels.slack.admins.length > 0 ? config.channels.slack.admins.map(formatSlackUser).join(', ') : 'none'}`,
          `Members: ${config.channels.slack.members.length > 0 ? config.channels.slack.members.map(formatSlackUser).join(', ') : 'none'}`,
          `Pending: ${config.channels.slack.pending.length > 0 ? config.channels.slack.pending.map(formatSlackUser).join(', ') : 'none'}`,
          '',
          'Commands:',
          '\u2022 `/slack pending`',
          '\u2022 `/slack users`',
          '\u2022 `/slack approve <pairing-code|user-id>`',
          '\u2022 `/slack reject <user-id>`',
          '\u2022 `/slack remove <user-id>`',
          '\u2022 `/slack reset`',
        ];
        await channel.send(lines.join('\n'), channelId);
      };

      if (action === 'help' || action === 'status') {
        await sendSlackOverview();
        return true;
      }

      if (action === 'pending') {
        const pending = config.channels.slack.pending;
        const lines = [
          '**Slack Pending Requests**',
          '',
          pending.length > 0 ? pending.map(formatSlackUser).join('\n') : 'No pending Slack requests.',
        ];
        await channel.send(lines.join('\n'), channelId);
        return true;
      }

      if (action === 'users') {
        const lines = [
          '**Slack Approved Users**',
          '',
          `Admins: ${config.channels.slack.admins.length > 0 ? config.channels.slack.admins.map(formatSlackUser).join(', ') : 'none'}`,
          `Members: ${config.channels.slack.members.length > 0 ? config.channels.slack.members.map(formatSlackUser).join(', ') : 'none'}`,
          '',
          `Total approved: ${config.channels.slack.admins.length + config.channels.slack.members.length}`,
        ];
        await channel.send(lines.join('\n'), channelId);
        return true;
      }

      if (action === 'approve') {
        const value = parts[1];
        if (!value) {
          await channel.send('Usage: `/slack approve <pairing-code|user-id>`', channelId);
          return true;
        }

        let approved = approveSlackPendingRequestByPairingCode(config, value);
        let resultLabel = value;

        if (!approved) {
          approved = approveSlackPendingRequest(config, value, 'member');
          resultLabel = value;
        }

        if (!approved) {
          await channel.send(`No pending Slack request found for \`${resultLabel}\`.`, channelId);
          return true;
        }

        saveConfig(config);
        await channel.send(`Approved Slack user ${formatSlackUser(approved)}.`, channelId);
        return true;
      }

      if (action === 'reject') {
        const value = parts[1];
        if (!value) {
          await channel.send('Usage: `/slack reject <user-id>`', channelId);
          return true;
        }

        const rejected = rejectSlackPendingRequestConfig(config, value);
        if (!rejected) {
          await channel.send(`No pending Slack request found for \`${value}\`.`, channelId);
          return true;
        }

        saveConfig(config);
        await channel.send(`Rejected Slack request for ${formatSlackUser(rejected)}.`, channelId);
        return true;
      }

      if (action === 'remove') {
        const value = parts[1];
        if (!value) {
          await channel.send('Usage: `/slack remove <user-id>`', channelId);
          return true;
        }

        const removed = removeSlackUser(config, value);
        if (!removed) {
          await channel.send(`No approved Slack user found for \`${value}\`.`, channelId);
          return true;
        }

        saveConfig(config);
        await channel.send(`Removed Slack access for ${formatSlackUser(removed)}.`, channelId);
        return true;
      }

      if (action === 'reset' || action === 'unpair') {
        clearSlackAccess(config);
        saveConfig(config);
        await channel.send('Slack access reset. New users can send /mercury start in a DM to begin pairing again.', channelId);
        return true;
      }

      await channel.send(
        `Unknown Slack command "${action}". Try \`/slack\`, \`/slack pending\`, or \`/slack users\`.`,
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

    if (cmd === '/skills' || cmd.startsWith('/skills ')) {
      await this.handleSkillsSlashCommand(trimmed, channel, channelId, ctx);
      return true;
    }

    if (cmd.startsWith('/code')) {
      const rawArgs = trimmed.slice('/code'.length).trim().toLowerCase();
      const cliChannel = channelType === 'cli' && channel instanceof CLIChannel ? channel : null;

      if (!rawArgs) {
        if (cliChannel) {
          const choice = await this.presentChoice(
            'Code mode: open workspace IDE now?',
            ['Yes, open current workspace', 'No, keep classic coding mode'],
            channelId,
            channelType,
          );
          if (choice.toLowerCase().startsWith('yes')) {
            const current = this.capabilities.getCwd();
            const opened = cliChannel.openWorkspace(current);
            if (opened.ok) {
              this.capabilities.permissions.addTempScope(current, true, true);
              this.programmingMode.setExecute();
              this.programmingMode.setProjectContext(current);
              cliChannel.setProgrammingStatus(this.programmingMode.getState(), this.programmingMode.getProjectContext());
              await channel.send(`${opened.message}\nWorkspace IDE mode enabled.`, channelId);
              return true;
            }
            await channel.send(opened.message, channelId);
            return true;
          }
        }
        await channel.send(this.programmingMode.getStatusText(), channelId);
        return true;
      }

      if (rawArgs === 'status') {
        await channel.send(this.programmingMode.getStatusText(), channelId);
        return true;
      }

      if (rawArgs === 'workspace' || rawArgs === 'ws') {
        if (!cliChannel) {
          await channel.send('Workspace IDE mode is currently available in CLI only.', channelId);
          return true;
        }
        const current = this.capabilities.getCwd();
        const opened = cliChannel.openWorkspace(current);
        if (opened.ok) {
          this.programmingMode.setExecute();
          cliChannel.setProgrammingStatus(this.programmingMode.getState(), this.programmingMode.getProjectContext());
          await channel.send(`${opened.message}\nWorkspace IDE mode enabled.`, channelId);
        } else {
          await channel.send(opened.message, channelId);
        }
        return true;
      }

      if (rawArgs === 'plan') {
        this.programmingMode.setPlan();
        if (cliChannel) cliChannel.setProgrammingStatus(this.programmingMode.getState(), this.programmingMode.getProjectContext());
        await channel.send('Programming mode: **Plan**\nI will explore, analyze, and present a plan before writing any code. Use `/code execute` to switch to execution.', channelId);
        return true;
      }

      if (rawArgs === 'execute' || rawArgs === 'exec') {
        this.programmingMode.setExecute();
        if (cliChannel) cliChannel.setProgrammingStatus(this.programmingMode.getState(), this.programmingMode.getProjectContext());
        await channel.send('Programming mode: **Execute**\nI will implement the plan step by step, verifying with builds/tests. Use `/code off` to exit.', channelId);
        return true;
      }

      if (rawArgs === 'build') {
        this.programmingMode.setExecute();
        if (cliChannel) cliChannel.setProgrammingStatus(this.programmingMode.getState(), this.programmingMode.getProjectContext());
        await channel.send('Programming mode: **Build**\nExecution mode is active for implementation/build tasks.', channelId);
        return true;
      }

      if (rawArgs.startsWith('agent ') || rawArgs.startsWith('delegate ')) {
        if (!this.supervisor) {
          await channel.send('Sub-agents are not enabled in this environment.', channelId);
          return true;
        }
        const taskDescription = rawArgs.replace(/^(agent|delegate)\s+/, '').trim();
        if (!taskDescription) {
          await channel.send('Usage: `/code agent <task>`', channelId);
          return true;
        }
        const cwd = this.capabilities.getCwd();
        const agentId = await this.supervisor.spawn({
          task: taskDescription,
          sourceChannelId: channelId,
          sourceChannelType: channelType as any,
          workingDirectory: cwd,
        });
        const bgId = this.backgroundTasks.spawnAgent(taskDescription, cwd, agentId);
        this.syncBgTasksToTui();
        await channel.send(`Started coding sub-agent ${agentId} in background task ${bgId}. Use /bg ${bgId} for progress.`, channelId);
        return true;
      }

      if (rawArgs === 'off' || rawArgs === 'exit') {
        this.programmingMode.setOff();
        if (cliChannel) cliChannel.setProgrammingStatus(this.programmingMode.getState(), this.programmingMode.getProjectContext());
        await channel.send('Programming mode: **Off**\nBack to normal conversation mode.', channelId);
        return true;
      }

      if (rawArgs === 'toggle') {
        const newState = this.programmingMode.toggle();
        const labels: Record<string, string> = { off: 'Off', plan: 'Plan', execute: 'Execute' };
        if (cliChannel) cliChannel.setProgrammingStatus(this.programmingMode.getState(), this.programmingMode.getProjectContext());
        await channel.send(`Programming mode: **${labels[newState]}**`, channelId);
        return true;
      }

      await channel.send('Unknown /code command. Available: /code, /code plan, /code execute, /code build, /code workspace, /code agent <task>, /code off, /code toggle', channelId);
      return true;
    }

    if (cmd.startsWith('/research')) {
      const rawArgs = trimmed.slice('/research'.length).trim();

      if (!rawArgs || rawArgs.toLowerCase() === 'status') {
        await channel.send(this.researchMode.getStatusText(), channelId);
        return true;
      }

      if (rawArgs.toLowerCase() === 'on') {
        this.researchMode.setOn();
        await channel.send(
          'Research mode: **On**\nI will perform deep, multi-source web research and produce a full markdown research article. Long tasks are expected. Use `/research off` to exit.',
          channelId,
        );
        return true;
      }

      if (rawArgs.toLowerCase() === 'off') {
        this.researchMode.setOff();
        await channel.send('Research mode: **Off**\nBack to normal conversation mode.', channelId);
        return true;
      }

      if (rawArgs.toLowerCase() === 'toggle') {
        const newState = this.researchMode.toggle();
        await channel.send(`Research mode: **${newState === 'on' ? 'On' : 'Off'}**`, channelId);
        return true;
      }

      // Treat remaining args as a topic + enable research mode
      this.researchMode.setOn(rawArgs);
      if (channel instanceof WebChannel) {
        channel.sendHeartbeat(`Research mode: On. Topic: ${rawArgs}. I will gather live sources and produce a full research article.`, channelId);
      } else {
        await channel.send(
          `Research mode: **On**\nTopic: ${rawArgs}\nI will gather live sources and produce a full research article. Use \`/research off\` to exit.`,
          channelId,
        );
      }
      // Enqueue the topic as a real user message so the agent immediately
      // begins researching it, rather than only setting mode + topic and
      // waiting for the user to repeat themselves.
      const researchTopicMsg: ChannelMessage = {
        id: `research-${Date.now().toString(36)}`,
        channelId,
        channelType: channelType as ChannelType,
        senderId: 'user',
        senderName: 'You',
        content: rawArgs,
        timestamp: Date.now(),
      };
      this.enqueueMessage(researchTopicMsg);
      return true;
    }

    if (cmd.startsWith('/ws') || cmd.startsWith('/workspace')) {
      const cliChannel = channelType === 'cli' && channel instanceof CLIChannel ? channel : null;
      if (!cliChannel) {
        await channel.send('Workspace IDE mode is currently available in CLI only.', channelId);
        return true;
      }

      const base = cmd.startsWith('/workspace') ? '/workspace' : '/ws';
      const rawArgs = trimmed.slice(base.length).trim();
      const rawLower = rawArgs.toLowerCase();

      if (!rawArgs || rawLower === 'status') {
        const ws = cliChannel.getWorkspace();
        await channel.send(ws?.active ? `Workspace active: ${ws.rootPath}` : 'No active workspace. Use `/ws open <path>`.', channelId);
        return true;
      }

      if (rawLower.startsWith('open ')) {
        const target = rawArgs.slice(5).trim();
        const opened = cliChannel.openWorkspace(target);
        if (opened.ok) {
          this.capabilities.setCwd(path.resolve(target.replace(/^~(?=$|\/)/, process.env.HOME || '~')));
          this.capabilities.permissions.addTempScope(this.capabilities.getCwd(), true, true);
          this.programmingMode.setExecute();
          this.programmingMode.setProjectContext(this.capabilities.getCwd());
          cliChannel.setProgrammingStatus(this.programmingMode.getState(), this.programmingMode.getProjectContext());
          await channel.send(`${opened.message}\nWorkspace IDE is ready.`, channelId);
        } else {
          await channel.send(opened.message, channelId);
        }
        return true;
      }

      if (rawLower === 'refresh') {
        cliChannel.refreshWorkspace();
        await channel.send('Workspace refreshed.', channelId);
        return true;
      }

      if (rawLower.startsWith('stage ')) {
        const fileArg = rawArgs.slice(6).trim();
        const result = cliChannel.stageWorkspaceFile(fileArg || 'all');
        await channel.send(result.message, channelId);
        return true;
      }

      if (rawLower.startsWith('commit ')) {
        const message = rawArgs.slice(7).trim();
        const result = cliChannel.commitWorkspace(message);
        await channel.send(result.message, channelId);
        return true;
      }

      if (rawLower.startsWith('undo ')) {
        const fileArg = rawArgs.slice(5).trim();
        const result = cliChannel.undoWorkspaceFile(fileArg);
        await channel.send(result.message, channelId);
        return true;
      }

      if (rawLower === 'help') {
        await channel.send('Workspace commands:\n`/ws open <path>`\n`/ws refresh`\n`/ws stage <file|all>`\n`/ws commit <message>`\n`/ws undo <file>`\n`/ws status`', channelId);
        return true;
      }

      await channel.send('Unknown workspace command. Use `/ws help`.', channelId);
      return true;
    }

    if (cmd.startsWith('/spotify')) {
      if (!this.spotifyClient) {
        await channel.send('Spotify is not connected. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in your config, then run /spotify auth.', channelId);
        return true;
      }
      const rawArgs = trimmed.slice('/spotify'.length).trim().toLowerCase();

      if (!rawArgs || rawArgs === 'status') {
        const auth = this.spotifyClient.isAuthenticated() ? 'Connected' : 'Not connected';
        const device = this.spotifyClient.getDeviceId() || 'none';

        let accountName = this.spotifyClient.getAccountName();
        let accountId = this.spotifyClient.getAccountId();
        let product = this.spotifyClient.getProduct();
        let accountError = '';

        if (!accountName) {
          try {
            await this.spotifyClient.saveAccountInfo();
            accountName = this.spotifyClient.getAccountName();
            accountId = this.spotifyClient.getAccountId();
            product = this.spotifyClient.getProduct();
          } catch (err: any) {
            accountError = err.message;
            logger.warn({ err: err.message }, 'Failed to fetch Spotify account info');
          }
        }

        let premium = this.spotifyClient.getPremiumStatus();
        if (premium === null) {
          premium = await this.spotifyClient.checkPremium();
        }

        let status = `Spotify: **${auth}**`;
        if (accountName) status += `\nAccount: **${accountName}**`;
        if (accountId) status += `\nUser ID: ${accountId}`;
        if (product) status += `\nPlan: ${product}`;
        if (premium === true) {
          status += ' — all features available';
        } else if (premium === false) {
          status += ' — playback control requires Premium';
        }
        if (accountError) status += `\n⚠ Could not verify account: ${accountError}`;
        status += `\nDevice: ${device !== 'none' ? device : 'none selected'}`;
        await channel.send(status, channelId);
        return true;
      }

      if (rawArgs === 'auth') {
        if (channelType === 'cli' && channel instanceof CLIChannel) {
          try {
            const choice = await channel.withMenu(async (select) => {
              return select('Spotify Authorization', [
                { value: 'browser', label: 'Open browser (recommended)' },
                { value: 'manual', label: 'Paste authorization code manually' },
                { value: 'cancel', label: 'Cancel' },
              ]);
            });
            if (!choice || choice === 'cancel') {
              await channel.send('Spotify auth cancelled.', channelId);
              return true;
            }
            if (choice === 'manual') {
              const authUrl = this.spotifyClient.getAuthUrl();
              await channel.send('1. Open this URL in your browser:\n' + authUrl + '\n\n2. After authorizing, you will be redirected to localhost — it may show an error page, that is OK.\n3. Copy the `code` parameter from the URL in your browser address bar.\n4. Paste it below:', channelId);
              const code = await channel.prompt('Authorization code: ');
              if (!code || !code.trim()) {
                await channel.send('No code provided. Auth cancelled.', channelId);
                return true;
              }
              await this.spotifyClient.authenticateWithCode(code.trim());
              await channel.send('Spotify connected successfully! Try: play some music', channelId);
            } else {
              await channel.send('Opening browser for Spotify authorization...', channelId);
              await this.spotifyClient.authenticate();
              await channel.send('Spotify connected successfully! Try: play some music', channelId);
            }
          } catch (err: any) {
            await channel.send(`Spotify auth failed: ${err.message}`, channelId);
          }
        } else {
          const authUrl = this.spotifyClient.getAuthUrl();
          await channel.send(
            '**Connect Spotify**\n\n1. Open this URL on any device with a browser:\n' + authUrl + '\n\n2. After authorizing, you will be redirected to localhost — that page may show an error, that is OK.\n3. Copy the `code` from the URL, then type:\n`/spotify code <paste-code-here>`',
            channelId
          );
        }
        return true;
      }

      if (rawArgs.startsWith('code ')) {
        const code = rawArgs.slice('code '.length).trim();
        if (!code) {
          await channel.send('Usage: /spotify code <authorization-code>', channelId);
          return true;
        }
        try {
          await this.spotifyClient.authenticateWithCode(code);
          await channel.send('Spotify connected successfully! Try: play some music', channelId);
        } catch (err: any) {
          await channel.send(`Spotify auth failed: ${err.message}`, channelId);
        }
        return true;
      }

      if (rawArgs === 'devices') {
        try {
          const data = await this.spotifyClient.getDevices();
          if (!data?.devices?.length) { await channel.send('No active devices. Open Spotify on a device first.', channelId); return true; }
          const lines = ['**Spotify Devices:**\n'];
          for (const d of data.devices) {
            lines.push(`${d.is_active ? '▶' : '○'} **${d.name}** (${d.type}) — \`${d.id}\`${d.is_active ? ' [active]' : ''}`);
          }
          await channel.send(lines.join('\n'), channelId);
        } catch (err: any) { await channel.send(`Failed: ${err.message}`, channelId); }
        return true;
      }

      if (rawArgs.startsWith('device ')) {
        const id = rawArgs.slice('device '.length).trim();
        this.spotifyClient.setDevice(id);
        await channel.send(`Active device set to: ${id}`, channelId);
        return true;
      }

      if (rawArgs === 'player' && channelType === 'cli' && channel instanceof CLIChannel) {
        await channel.withMenu(async (select) => {
          while (true) {
            try {
              const np = await this.spotifyClient!.getCurrentlyPlaying();
              if (np) {
                await channel.send(formatNowPlaying(np), channelId);
              }
            } catch {}
            const action = await select('Spotify Player', PLAYER_CONTROLS);
            if (action === 'exit' || !action) return;
            if (action === 'search') {
              const query = await channel.prompt('Search: ');
              if (!query) continue;
              try {
                const results = await this.spotifyClient!.search(query, 'track', 5);
                const tracks = results?.tracks?.items || [];
                if (tracks.length === 0) { await channel.send('No results found.', channelId); continue; }
                const trackOptions = tracks.map((t: any, i: number) => ({
                  value: t.uri,
                  label: `${t.artists?.map((a: any) => a.name).join(', ')} — ${t.name}`,
                }));
                const picked = await select('Play which track?', [...trackOptions, { value: 'back', label: 'Back' }]);
                if (picked && picked !== 'back') {
                  await this.spotifyClient!.play([picked]);
                }
              } catch (err: any) { await channel.send(`Search failed: ${err.message}`, channelId); }
              continue;
            }
            if (action === 'volume') {
              const vol = await channel.prompt('Volume (0-100): ');
              const n = parseInt(vol, 10);
              if (!isNaN(n) && n >= 0 && n <= 100) {
                await this.spotifyClient!.setVolume(n);
                await channel.send(`Volume: ${n}%`, channelId);
              }
              continue;
            }
            if (action === 'queue') {
              const query = await channel.prompt('Search track to queue: ');
              if (!query) continue;
              try {
                const results = await this.spotifyClient!.search(query, 'track', 5);
                const tracks = results?.tracks?.items || [];
                if (tracks.length === 0) { await channel.send('No results.', channelId); continue; }
                const trackOptions = tracks.map((t: any) => ({
                  value: t.uri,
                  label: `${t.artists?.map((a: any) => a.name).join(', ')} — ${t.name}`,
                }));
                const picked = await select('Queue which track?', [...trackOptions, { value: 'back', label: 'Back' }]);
                if (picked && picked !== 'back') {
                  await this.spotifyClient!.addToQueue(picked);
                  await channel.send('Added to queue.', channelId);
                }
              } catch (err: any) { await channel.send(`Failed: ${err.message}`, channelId); }
              continue;
            }
            try {
              const result = await handlePlayerAction(action, this.spotifyClient!);
              await channel.send(result, channelId);
            } catch (err: any) {
              await channel.send(`Failed: ${err.message}`, channelId);
            }
          }
        });
        return true;
      }

      if (rawArgs === 'now' || rawArgs === 'playing' || rawArgs === 'np') {
        try {
          const text = await this.spotifyClient.getNowPlayingText();
          await channel.send(text, channelId);
        } catch (err: any) { await channel.send(`Failed: ${err.message}`, channelId); }
        return true;
      }

      if (rawArgs === 'logout') {
        this.spotifyClient.logout();
        await channel.send('Spotify disconnected. Run `/spotify auth` to reconnect.', channelId);
        return true;
      }

      await channel.send('Unknown /spotify command. Available: /spotify, /spotify auth, /spotify code <code>, /spotify logout, /spotify player, /spotify devices, /spotify device <id>, /spotify now', channelId);
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

    if (cmd.startsWith('/agents')) {
      if (!this.supervisor) {
        await channel.send('Sub-agents are not available.', channelId);
        return true;
      }
      const rawArgs = trimmed.slice('/agents'.length).trim();

      if (!rawArgs) {
        const agents = this.supervisor.getActiveAgents();
        const resourceInfo = this.supervisor.getResourceUsage();
        if (agents.length === 0) {
          await channel.send(`No active sub-agents.\nMax concurrent: ${resourceInfo.maxConcurrentAgents} (auto) | CPU: ${resourceInfo.cpuCores} cores`, channelId);
          return true;
        }
        const statusIcons: Record<string, string> = { pending: '🔵', running: '🟢', paused: '🟡', completed: '✅', failed: '❌', halted: '⛔' };
        const lines = [`**Sub-Agents** (${agents.length})`, ''];
        for (const agent of agents) {
          const icon = statusIcons[agent.status] || '❓';
          const taskPreview = agent.task.length > 40 ? agent.task.slice(0, 40) + '...' : agent.task;
          lines.push(`${icon} **${agent.id}**  ${taskPreview}`);
          if (agent.progress) lines.push(`   ${agent.progress}`);
        }
        lines.push('');
        lines.push(`Max concurrent: ${resourceInfo.maxConcurrentAgents} (auto) | CPU: ${resourceInfo.cpuCores} cores`);
        lines.push(`Active: ${resourceInfo.activeAgents} | Queued: ${resourceInfo.queuedAgents}`);
        await channel.send(lines.join('\n'), channelId);
        return true;
      }

      const parts = rawArgs.split(/\s+/);
      const action = parts[0]?.toLowerCase();

      if (action === 'stop') {
        const target = parts[1]?.toLowerCase();
        if (!target) {
          await channel.send('Usage: /agents stop <id> or /agents stop all', channelId);
          return true;
        }
        if (target === 'all') {
          await this.supervisor.haltAll();
          await channel.send('All sub-agents halted. They will finish their current tool step before stopping.', channelId);
        } else {
          const halted = await this.supervisor.halt(target);
          if (!halted) {
            await channel.send(`No active agent found with ID "${target}".`, channelId);
          } else {
            await channel.send(`Agent ${target} halt signal sent. It will finish its current step then stop.`, channelId);
          }
        }
        return true;
      }

      if (action === 'pause') {
        const target = parts[1]?.toLowerCase();
        if (!target) {
          await channel.send('Usage: /agents pause <id>', channelId);
          return true;
        }
        const paused = await this.supervisor.pause(target);
        await channel.send(paused ? `Agent ${target} paused. Use /agents resume ${target} to continue.` : `No running agent found with ID "${target}".`, channelId);
        return true;
      }

      if (action === 'resume') {
        const target = parts[1]?.toLowerCase();
        if (!target) {
          await channel.send('Usage: /agents resume <id>', channelId);
          return true;
        }
        const resumed = await this.supervisor.resume(target);
        await channel.send(resumed ? `Agent ${target} resumed.` : `No paused agent found with ID "${target}".`, channelId);
        return true;
      }

      if (action === 'config') {
        const info = this.supervisor.getResourceUsage();
        const lines = [
          '**Sub-Agent Configuration**',
          `CPU cores: ${info.cpuCores}`,
          `System RAM: ${info.systemMemoryMB}MB`,
          `Available RAM: ${info.availableMemoryMB}MB`,
          `Max concurrent: ${info.maxConcurrentAgents}`,
          `Active agents: ${info.activeAgents}`,
          `Queued agents: ${info.queuedAgents}`,
          `Token budget remaining: ${info.tokenBudgetRemaining.toLocaleString()}`,
        ];
        await channel.send(lines.join('\n'), channelId);
        return true;
      }

      if (action === 'set' && parts[1]?.toLowerCase() === 'max') {
        const n = parseInt(parts[2], 10);
        if (isNaN(n) || n < 1) {
          await channel.send('Usage: /agents set max <number>', channelId);
          return true;
        }
        this.supervisor.setMaxConcurrent(n);
        await channel.send(`Max concurrent sub-agents set to ${n}.`, channelId);
        return true;
      }

      await channel.send(`Unknown /agents command "${action}". Available: /agents, /agents stop <id|all>, /agents pause <id>, /agents resume <id>, /agents config, /agents set max <n>`, channelId);
      return true;
    }

    if (cmd === '/halt') {
      if (!this.supervisor) {
        await channel.send('Sub-agents are not available.', channelId);
        return true;
      }
      await this.supervisor.haltAll();
      await channel.send('All sub-agents halted and queue cleared.', channelId);
      return true;
    }

    if (cmd === '/stop') {
      if (!this.supervisor) {
        await channel.send('Sub-agents are not available.', channelId);
        return true;
      }
      await this.supervisor.haltAll();
      this.supervisor.clearTaskBoard();
      this.lifecycle.transition('idle');
      await channel.send('All sub-agents stopped, queue cleared, locks released, task board cleared. Short-term memory preserved.', channelId);
      return true;
    }

    if (cmd === '/reset') {
      if (channelType === 'cli' && channel instanceof CLIChannel) {
        const confirmed = await channel.askToContinue(
          '⚠ /reset will halt ALL agents, clear queues, release locks, clear task board, and wipe conversation context. Continue? (y/n)',
          channelId,
        ).catch(() => false);
        if (!confirmed) {
          await channel.send('Reset cancelled.', channelId);
          return true;
        }
      }
      if (this.supervisor) {
        await this.supervisor.haltAll();
        this.supervisor.clearTaskBoard();
      }
      this.shortTerm.clearAll();
      this.lifecycle.transition('idle');
      await channel.send('Mercury reset. All agents stopped, all state cleared. Long-term memory preserved. Ready for a fresh start.', channelId);
      return true;
    }

    return false;
  }

  private async handleSessionCommand(content: string, channelType: ChannelType, channelId: string): Promise<void> {
    const channel = this.channels.get(channelType);
    if (!channel) return;
    const bindingId = channelType === 'cli' ? 'current' : channelId;
    const format = (session: { alias: string; shortId: string; title: string }) => `${session.alias}  [${session.shortId}]  ${session.title}`;
    const transcript = (session: ReturnType<SessionRepository['get']>) => {
      const recent = session.messages
        .filter((message) => message.kind === 'message' && (message.role === 'user' || message.role === 'assistant'))
        .slice(-8);
      if (recent.length === 0) return 'No messages yet.';
      return recent.map((message) => {
        const label = message.role === 'user' ? 'You' : 'Mercury';
        const text = message.content.replace(/\s+/g, ' ').trim();
        return `${label}: ${text.length > 280 ? `${text.slice(0, 277)}...` : text}`;
      }).join('\n');
    };
    const syncCliSession = (session: ReturnType<SessionRepository['get']>) => {
      if (channelType === 'cli' && channel instanceof CLIChannel) channel.setCurrentSession(session);
    };
    try {
      if (content.trim().toLowerCase() === '/sessions') {
        const current = this.sessions.getByBinding(channelType, bindingId);
        const sessions = this.sessions.list();
        await channel.send(sessions.length
          ? sessions.map((session) => `${session.id === current?.id ? '*' : ' '} ${format(session)}`).join('\n')
          : 'No active sessions. Use /session new.', channelId);
        return;
      }
      const argument = content.trim().slice('/session'.length).trim();
      if (argument.toLowerCase() === 'new') {
        const session = this.sessions.create();
        this.sessions.bind(session.id, channelType, bindingId);
        syncCliSession(session);
        await channel.send(`New session: ${format(session)}`, channelId);
        return;
      }
      if (!argument || argument.toLowerCase() === 'current') {
        const current = this.sessions.getByBinding(channelType, bindingId);
        await channel.send(current ? `Current session: ${format(current)}\n\n${transcript(current)}` : 'No current session. Use /session new.', channelId);
        return;
      }
      if (argument.toLowerCase().startsWith('delete ')) {
        const session = this.sessions.resolve(argument.slice('delete '.length).trim());
        const wasCurrent = this.sessions.getByBinding(channelType, bindingId)?.id === session.id;
        const confirmed = await channel.askToContinue(
          `Permanently delete ${format(session)} and all ${session.messages.length} messages everywhere? This cannot be undone.`,
          channelId,
        );
        if (!confirmed) {
          await channel.send('Session deletion cancelled.', channelId);
          return;
        }
        if (this.sessionSyncEnabled) this.sessions.markDeleted(session.id);
        else this.sessions.deletePermanently(session.id);
        const replacement = wasCurrent ? this.sessions.create({ binding: { channelType, externalConversationId: bindingId } }) : null;
        if (replacement) syncCliSession(replacement);
        await channel.send(
          `Deleted session ${session.alias} [${session.shortId}].${this.sessionSyncEnabled ? ' Cloud deletion is queued.' : ''}${replacement ? ` New session: ${format(replacement)}` : ''}`,
          channelId,
        );
        return;
      }
      if (argument.toLowerCase().startsWith('archive ')) {
        const session = this.sessions.archive(argument.slice('archive '.length).trim());
        await channel.send(`Archived: ${format(session)}`, channelId);
        return;
      }
      let session;
      try {
        session = this.sessions.resolve(argument);
      } catch (error) {
        if (channelType !== 'web' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(argument)) throw error;
        session = this.sessions.create({ id: argument });
      }
      this.sessions.bind(session.id, channelType, bindingId);
      syncCliSession(session);
      await channel.send(`Switched session: ${format(session)}\n\n${transcript(session)}`, channelId);
    } catch (error) {
      const message = error instanceof SessionResolutionError ? error.message : error instanceof Error ? error.message : String(error);
      await channel.send(message, channelId);
    }
  }

  private scheduleSessionTitleGeneration(sessionId: string, providerName: string): void {
    if (!this.generateTitle || this.titleGenerationInFlight.has(sessionId)) return;
    const session = this.sessions.get(sessionId);
    const exchange = session.messages.filter((message) => message.kind === 'message' && (message.role === 'user' || message.role === 'assistant'));
    if (session.titleSource !== 'fallback' || exchange.length !== 2 || exchange[0].role !== 'user' || exchange[1].role !== 'assistant') return;
    this.titleGenerationInFlight.add(sessionId);
    const timer = setTimeout(() => {
      void this.generateSessionTitle(sessionId, exchange[0].content, exchange[1].content, providerName).finally(() => {
        this.titleGenerationInFlight.delete(sessionId);
      });
    }, 0);
    timer.unref?.();
  }

  private async generateSessionTitle(sessionId: string, userMessage: string, assistantMessage: string, providerName: string): Promise<void> {
    try {
      const rawTitle = await this.generateTitle!({ userMessage, assistantMessage, providerName });
      const title = normalizeGeneratedSessionTitle(rawTitle);
      if (!title) {
        logger.debug({ sessionId }, 'Session title generator returned an unusable title');
        return;
      }
      if (this.sessions.get(sessionId).titleSource !== 'fallback') return;
      const session = this.sessions.updateTitle(sessionId, title, 'generated');
      const currentCliSession = this.sessions.getByBinding('cli', 'current');
      const cliChannel = this.channels.get('cli');
      if (currentCliSession?.id === session.id && cliChannel instanceof CLIChannel) cliChannel.setCurrentSession(session);
      logger.info({ sessionId, title }, 'Generated canonical session title');
    } catch (error) {
      logger.debug({ sessionId, err: error instanceof Error ? error.message : String(error) }, 'Background session title generation failed');
    }
  }

  private async handleWorkspaceNaturalLanguage(content: string, channelType: string, channelId: string): Promise<boolean> {
    const channel = this.channels.get(channelType as any);
    if (!channel || channelType !== 'cli' || !(channel instanceof CLIChannel)) return false;

    const trimmed = content.trim();
    const commandMatch = trimmed.match(/^(?:open|use|enter)\s+workspace(?:\s+(.+))?$/i);
    if (!commandMatch) return false;

    const targetRaw = (commandMatch[1] || '').trim();
    const target = targetRaw || this.capabilities.getCwd();
    const opened = channel.openWorkspace(target);
    if (!opened.ok) {
      await channel.send(opened.message, channelId);
      return true;
    }

    const resolved = path.resolve(target.replace(/^~(?=$|\/)/, process.env.HOME || '~'));
    this.capabilities.setCwd(resolved);
    this.capabilities.permissions.addTempScope(resolved, true, true);
    this.programmingMode.setExecute();
    this.programmingMode.setProjectContext(resolved);
    channel.setProgrammingStatus(this.programmingMode.getState(), this.programmingMode.getProjectContext());
    await channel.send(`Workspace opened from conversation intent: ${resolved}`, channelId);
    return true;
  }

  private async openCliCommandMenu(channel: CLIChannel, channelId: string): Promise<void> {
    const ctx = this.capabilities.getChatCommandContext();
    if (!ctx) return;

    await channel.withMenu(async (select) => {
      while (true) {
        const streamLabel = this.telegramStreaming ? 'Disable Telegram Streaming' : 'Enable Telegram Streaming';
        const permLabel = this.capabilities.permissions.isAutoApproveAll() ? 'Switch to Ask Me' : 'Switch to Allow All';
        const action = await select('Mercury Commands', [
          { value: 'status', label: 'Status' },
          { value: 'memory', label: 'Memory' },
          { value: 'permissions', label: permLabel },
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
            const cfg = ctx.config();
            if (cfg.memory.secondBrain?.enabled === false) {
              await channel.send('Second brain is disabled in configuration.', channelId);
            } else {
              await channel.send('Second brain dependency issue: SQLite backend (better-sqlite3) is not available.', channelId);
            }
          }
          continue;
        }

        if (action === 'permissions') {
          await this.handleChatCommand('/permissions', 'cli', channelId);
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
    const shareableCount = this.userMemory.countShareable();
    const shareLearning = this.userMemory.isShareLearning();
    const lines = [
      `**Memory Overview**`,
      `Total memories: ${summary.total}`,
      `Learning: ${summary.learningPaused ? 'PAUSED' : 'ACTIVE'}`,
      `Shared learning: ${shareLearning ? 'ON' : 'OFF'} (${shareableCount} shareable)`,
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
    await channel.send(lines.join('\n'), channelId);
  }

  private async openCliMemoryMenu(channel: CLIChannel, channelId: string, select?: (title: string, options: ArrowSelectOption[]) => Promise<string>): Promise<void> {
    if (!this.userMemory) return;

    const runMenu = async (sel: (title: string, options: ArrowSelectOption[]) => Promise<string>) => {
      while (true) {
        const learningLabel = this.userMemory!.isLearningPaused() ? 'Resume Learning' : 'Pause Learning';
        const shareLabel = this.userMemory!.isShareLearning() ? 'Shared Learning: ON' : 'Shared Learning: OFF';
        const action = await sel('Memory', [
          { value: 'overview', label: 'Overview' },
          { value: 'recent', label: 'Recent Memories' },
          { value: 'shared', label: 'Shared Memories' },
          { value: 'search', label: 'Search' },
          { value: 'toggle', label: learningLabel },
          { value: 'share', label: shareLabel },
          { value: 'clear', label: 'Clear All Memories' },
          { value: 'back', label: 'Back' },
        ]);

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

        if (action === 'shared') {
          const shared = this.userMemory!.getShareable(20);
          if (shared.length === 0) {
            await channel.send('No shared memories yet. Enable shared learning to mark new memories as shareable for cloud fetch.', channelId);
            continue;
          }
          const lines = [`**Shared Memories (${shared.length}):**`, ''];
          for (const r of shared) {
            const scope = r.scope === 'active' ? '⏳' : '📌';
            const cats = r.categories.length > 0 ? ` {${r.categories.join(', ')}}` : '';
            lines.push(`${scope} [${r.type}]${cats} ${r.summary}`);
            lines.push(`   Confidence: ${r.confidence.toFixed(2)} | Evidence: ${r.evidenceKind} | Seen: ${r.evidenceCount}x`);
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

        if (action === 'share') {
          const currently = this.userMemory!.isShareLearning();
          this.userMemory!.setShareLearning(!currently);
          const cfg = loadConfig();
          if (!cfg.memory.collaborativeKnowledge) cfg.memory.collaborativeKnowledge = {};
          cfg.memory.collaborativeKnowledge.shareLearning = !currently;
          saveConfig(cfg);
          const count = this.userMemory!.countShareable();
          await channel.send(
            currently
              ? `Shared learning disabled. New memories will stay private. (${count} memories already shareable are unchanged.)`
              : `Shared learning enabled. New memories will be marked shareable for cloud fetch. (${count} memories currently shareable.)`,
            channelId,
          );
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

  private async openMemoryChoiceMenu(channel: any, channelId: string): Promise<void> {
    if (!this.userMemory) return;

    const learningLabel = this.userMemory.isLearningPaused() ? 'Resume Learning' : 'Pause Learning';
    const shareLabel = this.userMemory.isShareLearning() ? 'Shared Learning: ON' : 'Shared Learning: OFF';
    const action = await channel.presentChoicePrompt('Memory', [
      { value: 'overview', label: 'Overview' },
      { value: 'recent', label: 'Recent Memories' },
      { value: 'shared', label: 'Shared Memories' },
      { value: 'toggle', label: learningLabel },
      { value: 'share', label: shareLabel },
      { value: 'clear', label: 'Clear All Memories' },
      { value: 'cancel', label: 'Cancel' },
    ], channelId);

    if (action === 'cancel') return;

    if (action === 'overview') {
      await this.sendMemoryOverview(channel, channelId);
      return;
    }

    if (action === 'recent') {
      const recent = this.userMemory.getRecent(10);
      if (recent.length === 0) {
        await channel.send('No memories yet.', channelId);
        return;
      }
      const lines = ['**Recent Memories:**', ''];
      for (const r of recent) {
        const scope = r.scope === 'active' ? '⏳' : '📌';
        const kind = r.evidenceKind === 'direct' ? 'direct' : r.evidenceKind === 'inferred' ? 'inferred' : r.evidenceKind;
        lines.push(`${scope} [${r.type}] ${r.summary}`);
        lines.push(`   Confidence: ${r.confidence.toFixed(2)} | Evidence: ${kind} | Seen: ${r.evidenceCount}x`);
      }
      await channel.send(lines.join('\n'), channelId);
      return;
    }

    if (action === 'shared') {
      const shared = this.userMemory.getShareable(20);
      if (shared.length === 0) {
        await channel.send('No shared memories yet. Enable shared learning to mark new memories as shareable for cloud fetch.', channelId);
        return;
      }
      const lines = [`**Shared Memories (${shared.length}):**`, ''];
      for (const r of shared) {
        const scope = r.scope === 'active' ? '⏳' : '📌';
        const cats = r.categories.length > 0 ? ` {${r.categories.join(', ')}}` : '';
        lines.push(`${scope} [${r.type}]${cats} ${r.summary}`);
        lines.push(`   Confidence: ${r.confidence.toFixed(2)} | Evidence: ${r.evidenceKind} | Seen: ${r.evidenceCount}x`);
      }
      await channel.send(lines.join('\n'), channelId);
      return;
    }

    if (action === 'toggle') {
      const currentlyPaused = this.userMemory.isLearningPaused();
      this.userMemory.setLearningPaused(!currentlyPaused);
      await channel.send(currentlyPaused ? 'Learning resumed. Mercury will remember new things from conversations.' : 'Learning paused. Mercury will not store new memories until resumed.', channelId);
      return;
    }

    if (action === 'share') {
      const currently = this.userMemory.isShareLearning();
      this.userMemory.setShareLearning(!currently);
      const cfg = loadConfig();
      if (!cfg.memory.collaborativeKnowledge) cfg.memory.collaborativeKnowledge = {};
      cfg.memory.collaborativeKnowledge.shareLearning = !currently;
      saveConfig(cfg);
      const count = this.userMemory.countShareable();
      await channel.send(
        currently
          ? `Shared learning disabled. New memories will stay private. (${count} memories already shareable are unchanged.)`
          : `Shared learning enabled. New memories will be marked shareable for cloud fetch. (${count} memories currently shareable.)`,
        channelId,
      );
      return;
    }

    if (action === 'clear') {
      const confirm = await channel.presentChoicePrompt('Clear all memories?', [
        { value: 'cancel', label: 'Cancel' },
        { value: 'confirm', label: 'Clear everything' },
      ], channelId);
      if (confirm === 'confirm') {
        const cleared = this.userMemory.clear();
        await channel.send(`Cleared ${cleared} memories.`, channelId);
      }
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
