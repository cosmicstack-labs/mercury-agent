import { generateText, streamText, stepCountIs } from 'ai';
import path from 'node:path';
import type { ChannelMessage, ChannelType } from '../types/channel.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { Identity } from '../soul/identity.js';
import type { ShortTermMemory, LongTermMemory, EpisodicMemory } from '../memory/store.js';
import type { UserMemoryStore } from '../memory/user-memory.js';
import type { ChannelRegistry } from '../channels/registry.js';
import type { MercuryConfig } from '../utils/config.js';
import type { TokenBudget } from '../utils/tokens.js';
import type { CapabilityRegistry } from '../capabilities/registry.js';
import type { ScheduledTaskManifest } from './scheduler.js';
import { DeepSeekProvider } from '../providers/deepseek.js';
import { ProviderRegistry as ProviderRegistryImpl } from '../providers/registry.js';
import { Lifecycle } from './lifecycle.js';
import { Scheduler } from './scheduler.js';
import { ProgrammingMode } from './programming-mode.js';
import { BackgroundTaskManager } from './background-tasks.js';
import { logger } from '../utils/logger.js';
import { CLIChannel } from '../channels/cli.js';
import { TelegramChannel } from '../channels/telegram.js';
import { formatToolStep, formatNarrative, type NarrativeStep } from '../utils/tool-label.js';
import { getTelegramHelp } from '../utils/manual.js';
import type { ArrowSelectOption } from '../utils/arrow-select.js';
import { setAskUserHandler } from '../capabilities/interaction/ask-user.js';
import type { SpotifyClient } from '../spotify/client.js';
import { PLAYER_CONTROLS, handlePlayerAction, formatNowPlaying } from '../spotify/ui.js';
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
  getActiveProviders,
} from '../utils/config.js';

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

const MAX_STEPS = 25;
const MAX_RESPONSE_TOKENS = 4096;
const HEARTBEAT_INITIAL_MS = 20000;
const HEARTBEAT_MAX_MS = 60000;
const LONG_TASK_HANDOFF_SUGGEST_MS = 45000;
const MAX_FOREGROUND_WALL_MS = 10 * 60 * 1000;
const MAX_STALL_MS = 4 * 60 * 1000;
const MAX_SELF_CHECKS = 3; // max AI self-checks per request before hard-aborting

export class Agent {
  readonly lifecycle: Lifecycle;
  readonly scheduler: Scheduler;
  readonly capabilities: CapabilityRegistry;
  private running = false;
  private messageQueue: ChannelMessage[] = [];
  private processing = false;
  private telegramStreaming: boolean;
  private currentMessage: ChannelMessage | null = null;
  private currentAbort: AbortController | null = null;
  private lastProgressAt = 0;
  private currentActivity = '';
  private completedStepCount = 0;
  private stepNarrative: import('../utils/tool-label.js').NarrativeStep[] = [];
  private supervisor?: import('../core/supervisor.js').SubAgentSupervisor;
  readonly programmingMode: ProgrammingMode;
  private spotifyClient?: SpotifyClient;
  readonly backgroundTasks: BackgroundTaskManager;

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
  ) {
    this.lifecycle = new Lifecycle();
    this.scheduler = scheduler;
    this.capabilities = capabilities;
    this.telegramStreaming = config.channels.telegram.streaming ?? true;
    this.programmingMode = new ProgrammingMode();
    this.backgroundTasks = new BackgroundTaskManager();

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

  setSupervisor(supervisor: import('../core/supervisor.js').SubAgentSupervisor): void {
    this.supervisor = supervisor;
    supervisor.setNotifyCallback(async (channelType, channelId, message) => {
      const channel = this.channels.get(channelType as any);
      if (channel) {
        await channel.send(message, channelId).catch(() => {});
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

    this.messageQueue.push(msg);
    this.processQueue();
  }

  private async handleFastPathCommand(msg: ChannelMessage): Promise<void> {
    const trimmed = msg.content.trim();
    const channel = this.channels.getChannelForMessage(msg);
    if (!channel) return;

    const activeAgents = this.supervisor ? this.supervisor.getActiveAgents() : [];
    const hasActiveAgents = activeAgents.length > 0;
    const busyPrefix = hasActiveAgents ? '' : '';

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
      if (this.supervisor) {
        await this.supervisor.haltAll();
        if (trimmed === '/stop') {
          this.supervisor.clearTaskBoard();
        }
        await channel.send(trimmed === '/halt' ? 'All sub-agents halted.' : 'All agents stopped, locks released, task board cleared.', msg.channelId);
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
      await channel.send('Agent is busy. Available: /agents, /halt, /stop, /progress, /spotify, /code, /memory, /bg', msg.channelId);
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

    this.messageQueue.push(msg);
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

  private startForegroundHeartbeat(msg: ChannelMessage): () => void {
    if (msg.channelType === 'internal') return () => {};

    let heartbeatCount = 0;
    let currentIntervalMs = HEARTBEAT_INITIAL_MS;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = () => {
      if (!this.processing || !this.currentMessage || this.currentMessage.id !== msg.id) return;
      const channel = this.channels.getChannelForMessage(msg);
      if (!channel) return;

      const elapsedMs = Date.now() - this.currentMessage.timestamp;
      const stallMs = Date.now() - this.lastProgressAt;
      const elapsedSec = Math.round(elapsedMs / 1000);
      const stallSec = Math.round(stallMs / 1000);

      if (stallMs >= MAX_STALL_MS && this.currentAbort && !this.currentAbort.signal.aborted) {
        logger.warn({ elapsedSec, stallSec, msgId: msg.id }, 'Foreground task stalled — aborting');
        this.currentAbort.abort();
        void channel.send(
          `⚠ Task stalled (no progress for ${stallSec}s). Stopped to avoid hanging. You can retry or use /bg current sooner for long tasks.`,
          msg.channelId,
        ).catch(() => {});
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
      void channel.send(
        `⏳ Working... ${elapsedSec}s elapsed${stepInfo}.${narrativeBlock}${handoffHint}`,
        msg.channelId,
      ).catch(() => {});

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
      (cliCh as CLIChannel).send(message).catch(() => {});
    }
    const tgCh = this.channels.get('telegram');
    if (tgCh) {
      tgCh.send(message).catch(() => {});
    }

    this.syncBgTasksToTui();
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

  private async switchSessionProvider(providerName: string): Promise<{ ok: boolean; message: string }> {
    const active = getActiveProviders(this.config).map((p) => p.name);
    if (!active.includes(providerName)) {
      return { ok: false, message: `Provider \`${providerName}\` is not configured. Run \`mercury doctor\` to add/configure models.` };
    }

    this.config.providers.default = providerName as any;
    this.providers = await ProviderRegistryImpl.create(this.config);
    const selected = this.providers.getDefault();
    const model = selected.getModel();

    const cliChannel = this.channels.get('cli');
    if (cliChannel && cliChannel instanceof CLIChannel) {
      cliChannel.setProvider(providerName, model);
    }

    return { ok: true, message: `Session model switched to **${providerName}** · **${model}**.` };
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
    this.currentActivity = '';
    this.completedStepCount = 0;
    this.stepNarrative = [];
    const stopHeartbeat = this.startForegroundHeartbeat(msg);
    this.markProgress('Starting...');
    let wallTimeout: ReturnType<typeof setTimeout> | null = null;

    if (this.supervisor && msg.channelType !== 'internal') {
      const activeAgents = this.supervisor.getActiveAgents();
      const runningAgents = activeAgents.filter(a => a.status === 'running');
      if (runningAgents.length > 0) {
        const channel = this.channels.getChannelForMessage(msg);
        if (channel) {
          const agentLines = runningAgents.map(a => `  🔄 ${a.id}: ${a.task.slice(0, 45)}${a.task.length > 45 ? '...' : ''}`);
          await channel.send(`**Multi-agent mode** — ${runningAgents.length} agent${runningAgents.length > 1 ? 's' : ''} active:\n${agentLines.join('\n')}`, msg.channelId).catch(() => {});
        }
      }
    }

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
        this.markProgress();
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
      let selfCheckCount = 0;

      this.currentMessage = msg;
      this.currentAbort = loopAbortController;
      wallTimeout = setTimeout(() => {
        if (!loopAbortController.signal.aborted) {
          loopAbortController.abort();
        }
      }, MAX_FOREGROUND_WALL_MS);

      const canStream = msg.channelType === 'cli' || (msg.channelType === 'telegram' && this.telegramStreaming);

      const tgChannel = this.channels.get('telegram');
      if (msg.channelType === 'telegram' && tgChannel) {
        (tgChannel as TelegramChannel).resetStepCounter(msg.channelId);
        (tgChannel as TelegramChannel).beginTask(msg.channelId);
      }

      for (const provider of fallbackIterator) {
        try {
          this.markProgress(`Calling ${provider.name}...`);
          const deepseekProviderOptions = provider instanceof DeepSeekProvider && provider.isReasoner
            ? { deepseek: { thinking: { type: 'enabled' as const } } }
            : undefined;

          logger.info({ provider: provider.name, model: provider.getModel(), steps: MAX_STEPS, stream: canStream }, 'Generating agentic response');

          if (canStream && channel) {
            const streamResult = streamText({
              model: provider.getModelInstance(),
              system: systemPrompt,
              messages,
              tools: this.programmingMode.isPlan() ? this.capabilities.getPlanTools() : this.capabilities.getTools(),
              maxOutputTokens: MAX_RESPONSE_TOKENS,
              stopWhen: stepCountIs(MAX_STEPS),
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
                      await channel.send(`☿ **Mercury Autopilot** · Identical call loop — ${hardLoop.tool} called ${hardLoop.count}x with same params. Stopping this path.`, msg.channelId).catch(() => {});
                    }
                    loopAbortController.abort();
                    return;
                  }
                  const similarLoop = loopDetector.detectSimilarLoop();
                  if (similarLoop) {
                    logger.warn({ tool: similarLoop.tool, count: similarLoop.count }, 'Failing loop detected — aborting');
                    if (!loopWarningSent && channel && msg.channelType !== 'internal') {
                      loopWarningSent = true;
                      await channel.send(`☿ **Mercury Autopilot** · Failing loop — ${similarLoop.tool} called ${similarLoop.count}x, all failing. Stopping this path.`, msg.channelId).catch(() => {});
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
                            await channel.send(`☿ **Mercury Autopilot** · ${analysis.tool} repeated ${analysis.count}x with low progress (${Math.round(analysis.paramDiversity * 100)}% diversity, ${Math.round(analysis.successRate * 100)}% success). Stopping this path.`, msg.channelId).catch(() => {});
                            loopAbortController.abort();
                            return;
                          }
                        }
                        // Not yet at check limit — let it continue with a note
                        loopDetector.reset();
                        loopWarningSent = false;
                        await channel.send(`☿ **Mercury Autopilot** · Observing ${analysis.tool} (${analysis.count} calls, ${Math.round(analysis.paramDiversity * 100)}% diversity). Continuing under monitoring.`, msg.channelId).catch(() => {});
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
                        await channel.send(`☿ **Mercury Autopilot** · ${analysis.tool} is stuck (${analysis.count} calls, ${Math.round(analysis.paramDiversity * 100)}% diversity, ${Math.round(analysis.successRate * 100)}% success). Stopping this path.`, msg.channelId).catch(() => {});
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
                        void (channel as CLIChannel).sendToolFeedback(tc.toolName, tc.input as Record<string, any>).catch(() => {});
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
                        void tgCh.sendToolFeedback(tc.toolName, tc.input as Record<string, any>, msg.channelId).catch(() => {});
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
                    this.markProgress();
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
                  fullText = await (tgChannel as any).sendStreamToChat(chatId, this.withProgressStream(streamResult.textStream));
                } else {
                  fullText = await channel.stream(this.withProgressStream(streamResult.textStream), msg.channelId);
                }
              } else {
                fullText = await channel.stream(this.withProgressStream(streamResult.textStream), msg.channelId);
              }
            } else {
              fullText = await channel.stream(this.withProgressStream(streamResult.textStream), msg.channelId);
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
              tools: this.programmingMode.isPlan() ? this.capabilities.getPlanTools() : this.capabilities.getTools(),
              maxOutputTokens: MAX_RESPONSE_TOKENS,
              stopWhen: stepCountIs(MAX_STEPS),
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
                      await channel.send(`☿ **Mercury Autopilot** · Identical call loop — ${hardLoop.tool} called ${hardLoop.count}x with same params. Stopping this path.`, msg.channelId).catch(() => {});
                    }
                    loopAbortController.abort();
                    return;
                  }
                  const similarLoop = loopDetector.detectSimilarLoop();
                  if (similarLoop) {
                    logger.warn({ tool: similarLoop.tool, count: similarLoop.count }, 'Failing loop detected — aborting');
                    if (!loopWarningSent && channel && msg.channelType !== 'internal') {
                      loopWarningSent = true;
                      await channel.send(`☿ **Mercury Autopilot** · Failing loop — ${similarLoop.tool} called ${similarLoop.count}x, all failing. Stopping this path.`, msg.channelId).catch(() => {});
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
                            await channel.send(`☿ **Mercury Autopilot** · ${analysis.tool} repeated ${analysis.count}x with low progress (${Math.round(analysis.paramDiversity * 100)}% diversity, ${Math.round(analysis.successRate * 100)}% success). Stopping this path.`, msg.channelId).catch(() => {});
                            loopAbortController.abort();
                            return;
                          }
                        }
                        // Not yet at check limit — let it continue with a note
                        loopDetector.reset();
                        loopWarningSent = false;
                        await channel.send(`☿ **Mercury Autopilot** · Observing ${analysis.tool} (${analysis.count} calls, ${Math.round(analysis.paramDiversity * 100)}% diversity). Continuing under monitoring.`, msg.channelId).catch(() => {});
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
                        await channel.send(`☿ **Mercury Autopilot** · ${analysis.tool} is stuck (${analysis.count} calls, ${Math.round(analysis.paramDiversity * 100)}% diversity, ${Math.round(analysis.successRate * 100)}% success). Stopping this path.`, msg.channelId).catch(() => {});
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
                        void (channel as CLIChannel).sendToolFeedback(tc.toolName, tc.input as Record<string, any>).catch(() => {});
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
                        void tgCh.sendToolFeedback(tc.toolName, tc.input as Record<string, any>, msg.channelId).catch(() => {});
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
                    this.markProgress();
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
              const elapsedMs = Date.now() - startTime;
              const timedOut = elapsedMs >= MAX_FOREGROUND_WALL_MS;
              result = {
                text: timedOut
                  ? 'I stopped because this request exceeded the foreground time limit. Please retry with a narrower scope, or move it to background with /bg current sooner.'
                  : 'I stopped because I detected I was stuck in a loop (repeating the same action without progress). I cannot complete this task as requested. Please let me know if you\'d like me to try a completely different approach, or if there\'s something else I can help with.',
                usage: undefined,
              };
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
          // End task before sending error so it goes through as a normal message
          if (channel instanceof TelegramChannel) {
            (channel as TelegramChannel).endTask(msg.channelId);
            (channel as TelegramChannel).resetStepCounter(msg.channelId);
          }
          await channel.send(errMsg, msg.channelId);
        }
        this.lifecycle.transition('idle');
        return;
      }

      const finalText = (streamedText || result.text || '').trim() || '(no text response)';
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
        const stepCount = this.completedStepCount;

        // Send completion banner only for substantial tasks (3+ steps AND >30s)
        // Simple responses (greetings, quick answers) don't need a banner
        const isSubstantialTask = stepCount >= 3 && elapsed >= 30_000;
        if (isSubstantialTask && channel instanceof TelegramChannel) {
          // For substantial Telegram tasks: sendCompletion handles endTask + deferred flush + cleanup
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
          // If there's a non-streamed response that wasn't deferred, defer it now
          if (!streamedText && finalText && finalText.trim()) {
            // send() during active task already deferred it — nothing to do
          }
          await (channel as TelegramChannel).sendCompletion(elapsed, stepCount, msg.channelId, completionMeta);
        } else if (channel instanceof TelegramChannel) {
          // For non-substantial Telegram tasks: end task, flush deferred, clean up
          (channel as TelegramChannel).endTask(msg.channelId);
          // Flush deferred response
          const deferred = (channel as TelegramChannel).popDeferredResponse(msg.channelId);
          const responseText = deferred || (!streamedText && finalText ? finalText : null);
          if (responseText && responseText.trim()) {
            await channel.send(responseText, msg.channelId, elapsed);
          }
          if (stepCount > 0) {
            await (channel as TelegramChannel).cleanupEphemeralMessages(msg.channelId);
            (channel as TelegramChannel).resetStepCounter(msg.channelId);
          }
          this.markProgress();
        } else {
          // CLI or other channels — original flow
          if (streamedText && streamedText.trim()) {
            logger.info({ channelType: msg.channelType, elapsed }, 'Streamed response completed');
          } else {
            logger.info({ channelType: msg.channelType, targetId: msg.channelId }, 'Sending response');
            await channel.send(finalText, msg.channelId, elapsed);
            this.markProgress();
          }
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

      this.lifecycle.transition('idle');
    } catch (err) {
      logger.error({ err }, 'Error handling message');
      this.lifecycle.transition('idle');
    } finally {
      if (wallTimeout) clearTimeout(wallTimeout);
      stopHeartbeat();
      this.currentMessage = null;
      this.currentAbort = null;
      this.currentActivity = '';
      this.completedStepCount = 0;
      this.stepNarrative = [];
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
    const programmingSuffix = this.programmingMode.getSystemPromptSuffix();
    if (programmingSuffix) {
      prompt += programmingSuffix;
    }
    const budgetStatus = this.tokenBudget.getStatusText();
    prompt += '\n\n' + budgetStatus;
    if (this.tokenBudget.getUsagePercentage() > 70) {
      prompt += '\nBe concise to conserve tokens.';
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
    await this.sleep();
    logger.info('Mercury has shut down');
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

    if (channelType === 'telegram' && channel instanceof TelegramChannel) {
      const { InlineKeyboard } = await import('grammy');
      const kb = new InlineKeyboard();
      for (let i = 0; i < choices.length; i++) {
        const callbackData = `choice_${Date.now()}_${i}`;
        kb.text(choices[i].slice(0, 60), callbackData);
        if (i < choices.length - 1 && (i + 1) % 2 === 0) {
          kb.row();
        }
      }

      return new Promise<string>((resolve) => {
        const timeout = setTimeout(() => {
          (channel as any).pendingApprovals?.delete(`choice_timeout_${question}`);
          resolve(choices[0]);
        }, 120000);

        channel.send(question, channelId).catch(() => {});

        const tgBot = (channel as any).bot;
        if (tgBot) {
          const chatId = channelId.startsWith('telegram:')
            ? Number(channelId.split(':')[1])
            : Number(channelId);

          tgBot.api.sendMessage(chatId, question, { reply_markup: kb }).catch(() => {});

          const handler = async (ctx: any) => {
            const data = ctx.callbackQuery?.data;
            if (!data || !data.startsWith('choice_')) return;
            const parts = data.split('_');
            if (parts.length < 3) return;
            const index = parseInt(parts[2], 10);
            if (isNaN(index)) return;
            clearTimeout(timeout);
            try { await ctx.answerCallbackQuery(); } catch {}
            resolve(choices[index]);
          };

          if ((channel as any).pendingCallbacks) {
            (channel as any).pendingCallbacks.push(handler);
          }
        }
      });
    }

    await channel?.send(`${question}\n${choices.map((c, i) => `  ${i + 1}. ${c}`).join('\n')}`, channelId).catch(() => {});
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
      const helpText = channelType === 'telegram' ? getTelegramHelp() : ctx.manual();
      await channel.send(helpText, channelId);
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
            await channel.send('Second brain is not enabled.', channelId);
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
    await channel.send(lines.join('\n'), channelId);
  }

  private async openCliMemoryMenu(channel: CLIChannel, channelId: string, select?: (title: string, options: ArrowSelectOption[]) => Promise<string>): Promise<void> {
    if (!this.userMemory) return;

    const runMenu = async (sel: (title: string, options: ArrowSelectOption[]) => Promise<string>) => {
      while (true) {
        const learningLabel = this.userMemory!.isLearningPaused() ? 'Resume Learning' : 'Pause Learning';
        const action = await sel('Memory', [
          { value: 'overview', label: 'Overview' },
          { value: 'recent', label: 'Recent Memories' },
          { value: 'search', label: 'Search' },
          { value: 'toggle', label: learningLabel },
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
