import type { Tool } from 'ai';
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
import { createListSkillsTool } from './skills/list-skills.js';
import { createUseSkillTool } from './skills/use-skill.js';
import { createScheduleTaskTool } from './scheduler/schedule-task.js';
import { createListTasksTool } from './scheduler/list-tasks.js';
import { createCancelTaskTool } from './scheduler/cancel-task.js';
import { createBudgetStatusTool } from './system/budget-status.js';
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
import { createAskUserTool, setAskUserHandler } from './interaction/index.js';
import { isGitHubConfigured, setGitHubToken } from '../utils/github.js';
import type { SkillLoader } from '../skills/loader.js';
import type { Scheduler } from '../core/scheduler.js';
import type { TokenBudget } from '../utils/tokens.js';
import type { SubAgentSupervisor } from '../core/supervisor.js';
import type { SpotifyClient } from '../spotify/client.js';
import { createDelegateTaskTool, createListAgentsTool, createStopAgentTool } from './subagents/index.js';
import { logger } from '../utils/logger.js';

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
}

export class CapabilityRegistry {
  readonly permissions: PermissionManager;
  private tools: Record<string, Tool> = {};
  private skillLoader?: SkillLoader;
  private scheduler?: Scheduler;
  private tokenBudget?: TokenBudget;
  private supervisor?: SubAgentSupervisor;
  private spotifyClient?: SpotifyClient;
  private sendFileHandler?: (filePath: string) => Promise<void>;
  private sendMessageHandler?: (content: string) => Promise<void>;
  private currentChannelId = 'cli';
  private currentChannelType = 'cli';
  private chatCommandContext?: ChatCommandContext;
  private currentCwd = process.cwd();

  constructor(skillLoader?: SkillLoader, scheduler?: Scheduler, tokenBudget?: TokenBudget, supervisor?: SubAgentSupervisor) {
    this.permissions = new PermissionManager();
    this.skillLoader = skillLoader;
    this.scheduler = scheduler;
    this.tokenBudget = tokenBudget;
    this.supervisor = supervisor;
  }

  setChatCommandContext(ctx: ChatCommandContext): void {
    this.chatCommandContext = ctx;
  }

  getChatCommandContext(): ChatCommandContext | undefined {
    return this.chatCommandContext;
  }

  setChannelContext(channelId: string, channelType: string): void {
    this.currentChannelId = channelId;
    this.currentChannelType = channelType;
  }

  getChannelContext(): { channelId: string; channelType: string } {
    return { channelId: this.currentChannelId, channelType: this.currentChannelType };
  }

  getCwd(): string {
    return this.currentCwd;
  }

  setCwd(dir: string): void {
    this.currentCwd = dir;
  }

  setSendFileHandler(handler: (filePath: string) => Promise<void>): void {
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
      this.tools.list_skills = createListSkillsTool(this.skillLoader);
      this.tools.use_skill = createUseSkillTool(this.skillLoader, this.permissions);
      logger.info('Skill tools registered');
    }

    if (this.scheduler) {
      this.tools.schedule_task = createScheduleTaskTool(this.scheduler, () => this.getChannelContext());
      this.tools.list_scheduled_tasks = createListTasksTool(this.scheduler);
      this.tools.cancel_scheduled_task = createCancelTaskTool(this.scheduler);
      logger.info('Scheduler tools registered');
    }

    if (this.tokenBudget) {
      this.tools.budget_status = createBudgetStatusTool(this.tokenBudget);
      logger.info('Budget tool registered');
    }

    if (manifest.capabilities.git?.enabled) {
      this.tools.git_status = createGitStatusTool(() => this.getCwd());
      this.tools.git_diff = createGitDiffTool(() => this.getCwd());
      this.tools.git_log = createGitLogTool(() => this.getCwd());
      this.tools.git_add = createGitAddTool(() => this.getCwd());
      this.tools.git_commit = createGitCommitTool(() => this.getCwd());
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

    this.tools.fetch_url = createFetchUrlTool();
    logger.info('Web fetch tool registered');

    if (this.supervisor) {
      this.tools.delegate_task = createDelegateTaskTool(this.supervisor, this);
      this.tools.list_agents = createListAgentsTool(this.supervisor);
      this.tools.stop_agent = createStopAgentTool(this.supervisor);
      logger.info('Sub-agent tools registered');
    }

    this.tools.ask_user = createAskUserTool(() => this.getChannelContext());
    logger.info('Interaction tools registered');
  }

  getTools(): Record<string, Tool> {
    return this.tools;
  }

  /** Return tools filtered for plan mode — read-only tools only */
  getPlanTools(): Record<string, Tool> {
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
    return filtered;
  }

  getToolNames(): string[] {
    return Object.keys(this.tools);
  }

  getSkillContext(): string {
    return this.skillLoader?.getSkillSummariesText() || '';
  }
}
