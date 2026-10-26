import type { Tool } from 'ai';
import { ensurePinnedBinaries } from './shell/argv-lane.js';
import { PermissionManager } from './permissions.js';
import { createReadFileTool } from './filesystem/read-file.js';
import { createWriteFileTool } from './filesystem/write-file.js';
import { createCreateFileTool } from './filesystem/create-file.js';
import { createListDirTool } from './filesystem/list-dir.js';
import { createDeleteFileTool } from './filesystem/delete-file.js';
import { createEditFileTool } from './filesystem/edit-file.js';
import { createSendFileTool } from './filesystem/send-file.js';
import { createSendMessageTool } from './messaging/send-message.js';
import { createApproveScopeTool } from './filesystem/approve-scope.js';
import { createRunCommandTool } from './shell/run-command.js';
import { createCdTool } from './shell/cd.js';
import { createApproveCommandTool } from './shell/approve-command.js';
import { createInstallSkillTool } from './skills/install-skill.js';
import { createCreateSkillTool } from './skills/create-skill.js';
import { createListSkillsTool } from './skills/list-skills.js';
import { createUseSkillTool } from './skills/use-skill.js';
import { createScheduleTaskTool } from './scheduler/schedule-task.js';
import { createListTasksTool } from './scheduler/list-tasks.js';
import { createCancelTaskTool } from './scheduler/cancel-task.js';
import { createBudgetStatusTool } from './system/budget-status.js';
import { createSaveMemoryTool } from './system/save-memory.js';
import { createSearchMemoryTool } from './system/search-memory.js';
import { createForgetMemoryTool } from './system/forget-memory.js';
import { createConfirmBeliefTool } from './system/confirm-belief.js';
import { createCorrectBeliefTool } from './system/correct-belief.js';
import { createGitStatusTool } from './git/git-status.js';
import { createGitDiffTool } from './git/git-diff.js';
import { createGitLogTool } from './git/git-log.js';
import { createGitAddTool } from './git/git-add.js';
import { createGitCommitTool } from './git/git-commit.js';
import { createGitPushTool } from './git/git-push.js';
import { createCreatePrTool } from './github/create-pr.js';
import { createReviewPrTool } from './github/review-pr.js';
import { createListIssuesTool } from './github/list-issues.js';
import { createCreateIssueTool } from './github/create-issue.js';
import { createGithubApiTool } from './github/github-api.js';
import { createFetchUrlTool } from './web/fetch-url.js';
import { createWebSearchTool } from './web/web-search.js';
import { activeCallScheduler, describeTime } from '../plugins/call-schedule.js';
import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import {
  createSpotifySearchTool,
  createSpotifyPlayTool,
  createSpotifyPauseTool,
  createSpotifyNextTool,
  createSpotifyPreviousTool,
  createSpotifyNowPlayingTool,
  createSpotifyDevicesTool,
  createSpotifyQueueTool,
  createSpotifyLikeTool,
  createSpotifyVolumeTool,
  createSpotifyShuffleTool,
  createSpotifyRepeatTool,
  createSpotifyTopTracksTool,
  createSpotifyPlaylistsTool,
} from './spotify/index.js';
import { createAskUserTool, createUpdatePlanTool, setAskUserHandler } from './interaction/index.js';
import { isGitHubConfigured, setGitHubToken } from '../utils/github.js';
import type { SkillLoader } from '../skills/loader.js';
import type { Scheduler } from '../core/scheduler.js';
import type { TokenBudget } from '../utils/tokens.js';
import type { SubAgentSupervisor } from '../core/supervisor.js';
import type { SpotifyClient } from '../spotify/client.js';
import { createDelegateTaskTool, createListAgentsTool, createStopAgentTool } from './subagents/index.js';
import { getPluginTools } from '../plugins/tool-bridge.js';
import { createDispatchBotTool } from '../bots/tools/dispatch-bot.js';
import type { UserMemoryStore } from '../memory/user-memory.js';
import { logger } from '../utils/logger.js';
import type { McpManager } from './mcp/manager.js';
import type { McpServerStatus } from './mcp/types.js';

export interface ChatCommandContext {
  toolNames: () => string[];
  skillNames: () => string[];
  config: () => import('../utils/config.js').MercuryConfig;
  tokenBudget: () => import('../utils/tokens.js').TokenBudget;
  manual: () => string;
  memorySummary: () => import('../memory/user-memory.js').UserMemorySummary;
  memoryRecent: (limit?: number) => import('../memory/user-memory.js').UserMemoryRecord[];
  memorySearch: (query: string, limit?: number) => import('../memory/user-memory.js').UserMemoryRecord[];
  memorySetLearningPaused: (paused: boolean) => void;
  memoryClear: () => number;
  memoryGetSubconscious: (limit?: number) => import('../memory/user-memory.js').UserMemoryRecord[];
  memoryIsShareLearning: () => boolean;
  memorySetShareLearning: (enabled: boolean) => void;
  mcpStatus?: () => McpServerStatus[];
}

export class CapabilityRegistry {
  readonly permissions: PermissionManager;
  private tools: Record<string, Tool> = {};
  private skillLoader?: SkillLoader;
  private scheduler?: Scheduler;
  private tokenBudget?: TokenBudget;
  private supervisor?: SubAgentSupervisor;
  private spotifyClient?: SpotifyClient;
  private userMemory?: UserMemoryStore;
  private sendFileHandler?: (filePath: string, channel?: string) => Promise<void>;
  private sendMessageHandler?: (content: string) => Promise<void>;
  private chatCommandContext?: ChatCommandContext;
  private currentCwd = process.cwd();
  private researchModeGetter: (() => boolean) | null = null;
  private mcp?: McpManager;

  /**
   * Mercury Bots dispatch handler — set once the BotManager exists
   * (src/index.ts). Registers the dispatch_bot tool so the main agent can
   * hand tasks to the bot fleet (the bots section in the system prompt comes
   * from BotManager.getSystemPromptSection via the Agent).
   */
  setBotDispatchHandler(handler: (botId: string, message: string, ctx: { channelType: string; channelId: string }) => import('../bots/tools/dispatch-bot.js').BotDispatchResult | null, channelCtx: () => { channelType: string; channelId: string }): void {
    this.tools.dispatch_bot = createDispatchBotTool(handler, channelCtx);
    logger.info('Bot dispatch tool registered (dispatch_bot)');
  }

  constructor(skillLoader?: SkillLoader, scheduler?: Scheduler, tokenBudget?: TokenBudget, supervisor?: SubAgentSupervisor, userMemory?: UserMemoryStore) {
    this.permissions = new PermissionManager();
    // Resolve argv-lane binaries once, at startup, from the pinned PATH (#103).
    ensurePinnedBinaries();
    this.skillLoader = skillLoader;
    this.scheduler = scheduler;
    this.tokenBudget = tokenBudget;
    this.supervisor = supervisor;
    this.userMemory = userMemory;
  }

  setResearchModeGetter(getter: () => boolean): void {
    this.researchModeGetter = getter;
  }

  isResearchMode(): boolean {
    return this.researchModeGetter ? this.researchModeGetter() : false;
  }

  setChatCommandContext(ctx: ChatCommandContext): void {
    this.chatCommandContext = ctx;
  }

  getChatCommandContext(): ChatCommandContext | undefined {
    return this.chatCommandContext;
  }

  /**
   * Channel of the calling agent. Stored in its permission context, so a
   * sub-agent (running under its own context) never overwrites the main
   * agent's channel, and its prompts route to its own source channel.
   */
  setChannelContext(channelId: string, channelType: string): void {
    this.permissions.setCurrentContext(channelType, channelId);
  }

  getChannelContext(): { channelId: string; channelType: string } {
    const ctx = this.permissions.currentContext();
    return { channelId: ctx.channelId, channelType: ctx.channelType };
  }

  private toolsDisabled = false;

  /**
   * No tools at all for the current turn (a chat channel at "general"
   * access). Enforced here so every code path that asks for tools, including
   * the plan and narration-guard paths, gets none.
   */
  setToolsDisabled(disabled: boolean): void {
    this.toolsDisabled = disabled;
  }

  areToolsDisabled(): boolean {
    return this.toolsDisabled;
  }

  getCwd(): string {
    return this.currentCwd;
  }

  setCwd(dir: string): void {
    this.currentCwd = dir;
  }

  setSendFileHandler(handler: (filePath: string, channel?: string) => Promise<void>): void {
    this.sendFileHandler = handler;
  }

  setSendMessageHandler(handler: (content: string) => Promise<void>): void {
    this.sendMessageHandler = handler;
  }

  setSupervisor(supervisor: SubAgentSupervisor): void {
    this.supervisor = supervisor;
  }

  setSpotifyClient(client: SpotifyClient): void {
    this.spotifyClient = client;
  }

  registerSpotifyTools(): void {
    if (!this.spotifyClient) return;
    this.tools.spotify_search = createSpotifySearchTool(this.spotifyClient);
    this.tools.spotify_play = createSpotifyPlayTool(this.spotifyClient);
    this.tools.spotify_pause = createSpotifyPauseTool(this.spotifyClient);
    this.tools.spotify_next = createSpotifyNextTool(this.spotifyClient);
    this.tools.spotify_previous = createSpotifyPreviousTool(this.spotifyClient);
    this.tools.spotify_now_playing = createSpotifyNowPlayingTool(this.spotifyClient);
    this.tools.spotify_devices = createSpotifyDevicesTool(this.spotifyClient);
    this.tools.spotify_queue = createSpotifyQueueTool(this.spotifyClient);
    this.tools.spotify_like = createSpotifyLikeTool(this.spotifyClient);
    this.tools.spotify_volume = createSpotifyVolumeTool(this.spotifyClient);
    this.tools.spotify_shuffle = createSpotifyShuffleTool(this.spotifyClient);
    this.tools.spotify_repeat = createSpotifyRepeatTool(this.spotifyClient);
    this.tools.spotify_top_tracks = createSpotifyTopTracksTool(this.spotifyClient);
    this.tools.spotify_playlists = createSpotifyPlaylistsTool(this.spotifyClient);
    logger.info('Spotify tools registered');
  }

  registerAll(): void {
    const manifest = this.permissions.getManifest();

    if (manifest.capabilities.filesystem.enabled) {
      this.tools.read_file = createReadFileTool(this.permissions, () => this.getCwd());
      this.tools.write_file = createWriteFileTool(this.permissions, () => this.getCwd());
      this.tools.create_file = createCreateFileTool(this.permissions, () => this.getCwd());
      this.tools.list_dir = createListDirTool(this.permissions, () => this.getCwd());
      this.tools.delete_file = createDeleteFileTool(this.permissions, () => this.getCwd());
      this.tools.edit_file = createEditFileTool(this.permissions, () => this.getCwd());

      if (this.sendFileHandler) {
        this.tools.send_file = createSendFileTool(this.permissions, () => this.getCwd(), this.sendFileHandler);
      }

      this.tools.approve_scope = createApproveScopeTool(this.permissions, () => this.getCwd());

      logger.info('Filesystem tools registered');
    }

    if (this.sendMessageHandler) {
      this.tools.send_message = createSendMessageTool(this.sendMessageHandler);
      logger.info('Messaging tool registered');
    }

    if (manifest.capabilities.shell.enabled) {
      this.tools.run_command = createRunCommandTool(this.permissions, () => this.getCwd(), (dir: string) => this.setCwd(dir));
      this.tools.cd = createCdTool(() => this.getCwd(), (dir: string) => this.setCwd(dir));
      this.tools.approve_command = createApproveCommandTool(this.permissions);
      logger.info('Shell tools registered');
    }

    if (this.skillLoader) {
      this.tools.install_skill = createInstallSkillTool(this.skillLoader);
      this.tools.create_skill = createCreateSkillTool(this.skillLoader);
      this.tools.list_skills = createListSkillsTool(this.skillLoader);
      this.tools.use_skill = createUseSkillTool(this.skillLoader, this.permissions);
      logger.info('Skill tools registered');
    }

    if (this.scheduler) {
      this.tools.schedule_task = createScheduleTaskTool(this.scheduler, this.permissions, () => this.getChannelContext());
      this.tools.list_scheduled_tasks = createListTasksTool(this.scheduler);
      this.tools.cancel_scheduled_task = createCancelTaskTool(this.scheduler);
      logger.info('Scheduler tools registered');
    }

    if (this.tokenBudget) {
      this.tools.budget_status = createBudgetStatusTool(this.tokenBudget);
      logger.info('Budget tool registered');
    }

    if (this.userMemory) {
      this.tools.save_memory = createSaveMemoryTool(this.userMemory);
      this.tools.search_memory = createSearchMemoryTool(this.userMemory);
      // Owner Model (ADR-026): the owner's verbs over what Mercury believes about them.
      this.tools.forget_memory = createForgetMemoryTool(this.userMemory);
      this.tools.confirm_belief = createConfirmBeliefTool(this.userMemory);
      this.tools.correct_belief = createCorrectBeliefTool(this.userMemory);
      logger.info('Second Brain tools registered (save_memory, search_memory, forget_memory, confirm_belief, correct_belief)');
    }

    if (manifest.capabilities.git?.enabled) {
      this.tools.git_status = createGitStatusTool(this.permissions, () => this.getCwd());
      this.tools.git_diff = createGitDiffTool(this.permissions, () => this.getCwd());
      this.tools.git_log = createGitLogTool(this.permissions, () => this.getCwd());
      this.tools.git_add = createGitAddTool(this.permissions, () => this.getCwd());
      this.tools.git_commit = createGitCommitTool(this.permissions, () => this.getCwd());
      this.tools.git_push = createGitPushTool(this.permissions, () => this.getCwd());
      logger.info('Git tools registered');
    }

    if (isGitHubConfigured()) {
      this.tools.create_pr = createCreatePrTool();
      this.tools.review_pr = createReviewPrTool();
      this.tools.list_issues = createListIssuesTool();
      this.tools.create_issue = createCreateIssueTool();
      this.tools.github_api = createGithubApiTool();
      logger.info('GitHub tools registered');
    }

    this.tools.fetch_url = createFetchUrlTool({ isResearchMode: () => this.isResearchMode() });
    this.tools.web_search = createWebSearchTool();
    logger.info('Web fetch tool registered');

    if (this.supervisor) {
      this.tools.delegate_task = createDelegateTaskTool(this.supervisor, this);
      this.tools.list_agents = createListAgentsTool(this.supervisor);
      this.tools.stop_agent = createStopAgentTool(this.supervisor);
      logger.info('Sub-agent tools registered');
    }

    this.tools.ask_user = createAskUserTool(() => this.getChannelContext());
    this.tools.update_plan = createUpdatePlanTool();
    logger.info('Interaction tools registered');
  }

  attachMcp(manager: McpManager): void {
    this.mcp = manager;
  }

  getMcpManager(): McpManager | undefined {
    return this.mcp;
  }

  private allTools(): Record<string, Tool> {
    return this.mcp ? { ...this.tools, ...this.mcp.getTools() } : this.tools;
  }

  getTools(): Record<string, Tool> {
    if (this.toolsDisabled) return {};
    // Scheduled calls (when a calling channel plugin is running): owner only.
    if (this.permissions.getCurrentSenderRole() !== 'member' && activeCallScheduler()) {
      return { ...this.getToolsInner(), ...callTools() };
    }
    return this.getToolsInner();
  }

  private getToolsInner(): Record<string, Tool> {
    // Members on a channel that distinguishes roles (e.g. Telegram) must not be
    // able to install skills: `install_skill` is the escalation path from chat
    // access to arbitrary local execution and is documented as admin-only.
    // Plugin and MCP tools are owner-installed, so members don't get them either.
    if (this.permissions.getCurrentSenderRole() === 'member') {
      const filtered: Record<string, Tool> = {};
      for (const [name, tool] of Object.entries(this.tools)) {
        if (name !== 'install_skill' && name !== 'create_skill') filtered[name] = tool;
      }
      return filtered;
    }
    // MCP tools sit beside the built-ins (members never get them: above).
    return this.withPluginTools(this.allTools(), false);
  }

  /**
   * Built-in tools plus the live plugin tools (src/plugins). Read on every
   * call, so enabling or disabling a plugin takes effect on the next turn.
   * A built-in tool always wins a name clash.
   */
  private withPluginTools(base: Record<string, Tool>, readOnlyOnly: boolean): Record<string, Tool> {
    const plugin = getPluginTools(this.permissions, { readOnlyOnly });
    if (Object.keys(plugin).length === 0) return base;
    const merged: Record<string, Tool> = { ...base };
    for (const [name, tool] of Object.entries(plugin)) {
      if (!(name in merged)) merged[name] = tool;
    }
    return merged;
  }

  /** Return tools filtered for plan mode — read-only tools only */
  getPlanTools(): Record<string, Tool> {
    if (this.toolsDisabled) return {};
    const blocked = new Set([
      'write_file', 'create_file', 'delete_file', 'edit_file',
      'run_command', 'cd',
      'git_add', 'git_commit', 'git_push',
      'create_pr', 'create_issue',
      'delegate_task',
    ]);
    const filtered: Record<string, Tool> = {};
    for (const [name, tool] of Object.entries(this.tools)) {
      if (!blocked.has(name)) filtered[name] = tool;
    }
    // Plan mode: only plugin tools their manifest declares read-only.
    if (this.permissions.getCurrentSenderRole() === 'member') return filtered;
    return this.withPluginTools(filtered, true);
  }

  getToolNames(): string[] {
    return Object.keys(this.allTools());
  }

  getSkillContext(): string {
    return this.skillLoader?.getSkillSummariesText() || '';
  }
}

/** Tools for scheduled calls (the time is worked out in code, not by the model). */
function callTools(): Record<string, Tool> {
  return {
    schedule_call: tool({
      description:
        'Schedule Mercury to call the owner on WhatsApp later, e.g. "call me at 9pm about the deploy", "call me back in 20 minutes", "call me tomorrow 8:30am". ' +
        'Pass the time exactly as the owner said it (e.g. "9pm", "after 9 PM", "in 20 minutes", "tomorrow 8:30am"); it is converted in code. ' +
        'Tell the owner the confirmation it returns (it has the exact time). For "call me when X is done", do X first, then call call_owner.',
      inputSchema: zodSchema(z.object({
        when: z.string().min(1).max(80).describe('The time as the owner said it'),
        topic: z.string().max(300).optional().describe('What the call is about, in a few words'),
      })),
      execute: async ({ when, topic }) => {
        const s = activeCallScheduler();
        if (!s) return 'Calls need the WhatsApp plugin, linked and running.';
        try {
          return s.schedule(when, topic ?? '').confirmation;
        } catch (err) {
          return `Couldn't schedule: ${(err as Error).message}`;
        }
      },
    }),
    list_scheduled_calls: tool({
      description: 'List the calls Mercury has scheduled to the owner.',
      inputSchema: zodSchema(z.object({})),
      execute: async () => {
        const list = activeCallScheduler()?.list() ?? [];
        return list.length ? list.map((c, i) => `${i + 1}. ${describeTime(new Date(c.at))}: ${c.topic} (id ${c.id})`).join('\n') : 'No calls scheduled.';
      },
    }),
    cancel_scheduled_call: tool({
      description: 'Cancel a scheduled call by its number in list_scheduled_calls, its id, or "all".',
      inputSchema: zodSchema(z.object({ which: z.string().min(1).max(40) })),
      execute: async ({ which }) => {
        const n = activeCallScheduler()?.cancel(which.toLowerCase()) ?? 0;
        return n ? `Cancelled ${n} call${n === 1 ? '' : 's'}.` : 'No scheduled call matches that.';
      },
    }),
  };
}
