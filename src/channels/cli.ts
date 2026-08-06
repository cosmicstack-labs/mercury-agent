import React from 'react';
import { render } from 'ink';
import fs from 'node:fs';
import path from 'node:path';
import { execSync, execFile } from 'node:child_process';
import type { ChannelMessage } from '../types/channel.js';
import { BaseChannel, type PermissionMode } from './base.js';
import { logger } from '../utils/logger.js';
import { formatToolStep, formatToolResult } from '../utils/tool-label.js';
import type { ChatMessage, CompletionMeta, ToolStep, PermissionPromptState, SidebarSection, SkillInfo, SubAgentInfo, ProviderInfo, TokenInfo, SaverInfo, AppMode, WorkspaceState, WorkspaceTreeNode, WorkspaceGitFile, BackgroundTaskInfo } from '../ui/types.js';
import { TuiApp } from '../ui/App.js';

export interface TuiState {
  mode: AppMode;
  viewMode: 'balanced' | 'detailed';
  chatMessages: ChatMessage[];
  toolSteps: ToolStep[];
  isThinking: boolean;
  permissionPrompt: PermissionPromptState | null;
  agentName: string;
  version: string;
  provider: ProviderInfo | null;
  tokenInfo: TokenInfo | null;
  skills: SkillInfo[];
  subAgents: SubAgentInfo[];
  sidebarSections: SidebarSection[];
  programmingMode: import('../core/programming-mode.js').ProgrammingModeState;
  projectContext: string | null;
  permissionMode: PermissionMode;
  workspace: WorkspaceState | null;
  backgroundTasks: BackgroundTaskInfo[];
  web: { enabled: boolean; port: number } | null;
  saverInfo: SaverInfo | null;
  /** Last completed step log, preserved after completion wipes toolSteps. Ctrl+D dumps this. */
  lastStepLog: ToolStep[] | null;
  /** Elapsed ms for the last completed task. */
  lastStepLogElapsed: number | null;
}

const defaultState: TuiState = {
  mode: 'splash',
  viewMode: 'balanced',
  chatMessages: [],
  toolSteps: [],
  isThinking: false,
  permissionPrompt: null,
  agentName: 'Mercury',
  version: '1.1.5',
  provider: null,
  tokenInfo: null,
  skills: [],
  subAgents: [],
  sidebarSections: [],
  programmingMode: 'off',
  projectContext: null,
  permissionMode: 'ask-me',
  workspace: null,
  backgroundTasks: [],
  web: null,
  saverInfo: null,
  lastStepLog: null,
  lastStepLogElapsed: null,
};

function shallowEqualSubAgents(a: SubAgentInfo[], b: SubAgentInfo[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].status !== b[i].status || a[i].progress !== b[i].progress) return false;
  }
  return true;
}

function shallowEqualBgTasks(a: BackgroundTaskInfo[], b: BackgroundTaskInfo[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].status !== b[i].status || a[i].runningMs !== b[i].runningMs) return false;
  }
  return true;
}

export class CLIChannel extends BaseChannel {
  readonly type = 'cli' as const;
  private agentName: string;
  private inkInstance: ReturnType<typeof render> | null = null;
  private inputHandler: ((text: string) => void) | null = null;
  private exitHandler: (() => void) | null = null;
  private permissionResolver: ((value: string | boolean) => void) | null = null;
  private menuDepth = 0;
  private menuAbortController: AbortController | null = null;
  private heartbeatMsgId: string | null = null;
  private stepCount = 0;
  private stepStartTime = 0;
  private state: TuiState = { ...defaultState };
  private spotifyClient: any = null;
  private rawModeWatchdog: NodeJS.Timeout | null = null;
  private statusPoller: NodeJS.Timeout | null = null;
  private statusPollerBusy = false;
  private statusProviders: {
    tokens?: () => { used: number; budget: number; percentage: number };
    saver?: () => { state: import('../core/saver-mode.js').SaverModeState; savedToday: number; savedLifetime: number };
    subAgents?: () => SubAgentInfo[];
    bgTasks?: () => BackgroundTaskInfo[];
  } = {};

  constructor(agentName: string = 'Mercury') {
    super();
    this.agentName = agentName;
    this.state.agentName = agentName;
  }

  setAgentName(name: string): void {
    this.agentName = name;
    this.update({ agentName: name });
  }

  async start(): Promise<void> {
    this.ready = true;
    logger.info('CLI channel started (Ink TUI)');
  }

  async stop(): Promise<void> {
    this.stopRawModeWatchdog();
    this.stopStatusPoller();
    this.inkInstance?.unmount();
    this.inkInstance = null;
    this.releaseRawMode();
    this.ready = false;
  }

  private ensureRawMode(): void {
    if (!process.stdin.isTTY) return;
    const stdin = process.stdin as NodeJS.ReadStream;
    if (typeof stdin.setRawMode !== 'function') return;
    try {
      stdin.setRawMode(true);
      stdin.resume();
    } catch {
      // Ignore transient raw mode failures.
    }
  }

  private releaseRawMode(): void {
    if (!process.stdin.isTTY) return;
    const stdin = process.stdin as NodeJS.ReadStream;
    if (typeof stdin.setRawMode !== 'function') return;
    try {
      stdin.setRawMode(false);
    } catch {
      // Ignore teardown failures.
    }
  }

  private startRawModeWatchdog(): void {
    this.stopRawModeWatchdog();
    this.ensureRawMode();
    this.rawModeWatchdog = setInterval(() => {
      if (!this.inkInstance) return;
      this.ensureRawMode();
    }, 250);
  }

  private stopRawModeWatchdog(): void {
    if (this.rawModeWatchdog) {
      clearInterval(this.rawModeWatchdog);
      this.rawModeWatchdog = null;
    }
  }

  private update(partial: Partial<TuiState>): void {
    this.state = { ...this.state, ...partial };
    this.rerender();
  }

  /** Update an existing chat message's content in place (by ID). */
  private updateMessage(id: string, content: string, extra?: Partial<ChatMessage>): void {
    this.update({
      chatMessages: this.state.chatMessages.map((m) =>
        m.id === id ? { ...m, content, timestamp: Date.now(), ...extra } : m,
      ),
    });
  }

  private rerender(): void {
    if (!this.inkInstance) return;
    this.inkInstance.rerender(
      React.createElement(TuiApp, {
        state: this.state,
        onInput: (text: string) => { this.inputHandler?.(text); },
        onPermissionResolve: (value: string | boolean) => {
          if (this.permissionResolver) {
            this.permissionResolver(value);
            this.permissionResolver = null;
          }
          this.update({ permissionPrompt: null });
        },
        onExit: () => {
          this.stopRawModeWatchdog();
          this.inkInstance?.unmount();
          this.inkInstance = null;
          this.releaseRawMode();
          this.exitHandler?.();
        },
        spotifyClient: this.spotifyClient,
      }),
    );
  }

  mountTUI(onInput: (text: string) => void, spotifyClient?: any, onExit?: () => void): void {
    this.spotifyClient = spotifyClient ?? null;
    this.exitHandler = onExit ?? null;

    this.inputHandler = (text: string) => {
      const trimmed = text.trim();
      if (trimmed === '/chat' || trimmed === '/c') {
        this.update({ mode: 'chat' });
        return;
      }
      if (trimmed === '/coding') {
        this.update({ mode: 'coding' });
        return;
      }
      if (trimmed === '/workspace' || trimmed === '/ws') {
        this.update({ mode: this.state.workspace?.active ? 'workspace' : 'coding' });
        return;
      }
      if (trimmed === '/ws up') {
        this.moveWorkspaceSelection(-1);
        return;
      }
      if (trimmed === '/ws down') {
        this.moveWorkspaceSelection(1);
        return;
      }
      if (trimmed === '/ws open-selected') {
        this.toggleOrSelectWorkspaceNode();
        return;
      }
      if (trimmed === '/ws exit' || trimmed === '/workspace exit' || trimmed === '/general') {
        this.exitWorkspaceToChat();
        return;
      }
      if (trimmed === '/ws close-file') {
        this.closeWorkspaceFile();
        return;
      }
      if (trimmed === '/ws collapse') {
        this.collapseWorkspaceNode();
        return;
      }
      if (trimmed === '/ws expand') {
        this.expandWorkspaceNode();
        return;
      }
      if (trimmed.startsWith('/ws scroll ')) {
        const delta = parseInt(trimmed.slice(11), 10);
        if (!isNaN(delta)) this.scrollWorkspaceCode(delta);
        return;
      }
      if (trimmed.startsWith('/ws focus ')) {
        const area = trimmed.slice(9).trim() as 'explorer' | 'code' | 'git' | 'chat';
        if (['explorer', 'code', 'git', 'chat'].includes(area)) this.setWorkspaceFocus(area);
        return;
      }
      if (trimmed === '/ws toggle-chat') {
        this.toggleWorkspaceChat();
        return;
      }
      if (trimmed.startsWith('/ws chat-scroll ')) {
        const delta = parseInt(trimmed.slice(16), 10);
        if (!isNaN(delta)) this.scrollWorkspaceChat(delta);
        return;
      }
      if (trimmed === '/menu' || trimmed === '/m') {
        this.update({ mode: 'menu' });
        return;
      }
      if (trimmed === '/spotify' || trimmed === '/s') {
        this.update({ mode: 'spotify' });
        return;
      }
      if (trimmed === '/splash') {
        this.update({ mode: 'splash' });
        return;
      }
      if (trimmed === '/view balanced') {
        this.update({ viewMode: 'balanced' });
        return;
      }
      if (trimmed === '/view detailed') {
        this.update({ viewMode: 'detailed' });
        return;
      }
      if (trimmed === '/view toggle' || trimmed === '/view') {
        this.update({ viewMode: this.state.viewMode === 'balanced' ? 'detailed' : 'balanced' });
        return;
      }
      // Show last task's full step log (triggered by Ctrl+D or /log)
      if (trimmed === '/log') {
        const steps = this.state.toolSteps.length > 0 ? this.state.toolSteps : (this.state.lastStepLog ?? []);
        if (steps.length > 0) {
          const elapsed = this.state.lastStepLogElapsed;
          const suffix = this.state.toolSteps.length > 0 ? ' (active)' : '';
          const elapsedSec = elapsed != null ? ` · ${Math.round(elapsed / 1000)}s` : '';
          const lines = steps.map((s) => {
            const icon = s.status === 'done' ? '✓' : s.status === 'error' ? '✗' : '→';
            const time = s.elapsed != null ? ` (${s.elapsed.toFixed(1)}s)` : '';
            const result = s.result ? ` · ${s.result}` : '';
            return `${icon} ${s.label}${time}${result}`;
          });
          const header = `── Step log (${steps.filter((s) => s.status === 'done').length}/${steps.length} done${elapsedSec}${suffix}) ──`;
          const msg: ChatMessage = {
            id: `log-${Date.now().toString(36)}`,
            role: 'system',
            content: `${header}\n${lines.join('\n')}`,
            timestamp: Date.now(),
          };
          this.update({ chatMessages: [...this.state.chatMessages, msg] });
        } else {
          const msg: ChatMessage = {
            id: `log-${Date.now().toString(36)}`,
            role: 'system',
            content: 'No step history available yet. Run a task first, then press Ctrl+D.',
            timestamp: Date.now(),
          };
          this.update({ chatMessages: [...this.state.chatMessages, msg] });
        }
        return;
      }
      // Clear stale tool steps from the previous task so the activity
      // panel starts fresh for each new user message.
      if (this.state.toolSteps.length > 0) {
        this.update({ toolSteps: [] });
        this.stepCount = 0;
      }
      onInput(trimmed);
    };

    this.inkInstance = render(
      React.createElement(TuiApp, {
        state: this.state,
        onInput: (text: string) => { this.inputHandler?.(text); },
        onPermissionResolve: (value: string | boolean) => {
          if (this.permissionResolver) {
            this.permissionResolver(value);
            this.permissionResolver = null;
          }
          this.update({ permissionPrompt: null });
        },
        onExit: () => {
          this.stopRawModeWatchdog();
          this.inkInstance?.unmount();
          this.inkInstance = null;
          this.releaseRawMode();
          this.exitHandler?.();
        },
        spotifyClient: this.spotifyClient,
      }),
      { exitOnCtrlC: false, patchConsole: false },
    );

    this.startRawModeWatchdog();
  }

  async send(content: string, _targetId?: string, _elapsedMs?: number): Promise<void> {
    const msg: ChatMessage = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      role: 'agent',
      content,
      timestamp: Date.now(),
    };
    // Clear any lingering heartbeat message when we send a real response.
    if (this.heartbeatMsgId) {
      this.state.chatMessages = this.state.chatMessages.filter((m) => m.id !== this.heartbeatMsgId);
      this.heartbeatMsgId = null;
    }
    this.update({
      chatMessages: [...this.state.chatMessages, msg],
      isThinking: false,
    });
  }

  /**
   * Send or replace a heartbeat progress message. First call creates a new
   * message; subsequent calls update it in place. This avoids stacking
   * multiple "⏳ Working..." messages in the chat history.
   */
  sendHeartbeat(content: string): void {
    if (this.heartbeatMsgId) {
      // Update existing heartbeat message in place.
      this.updateMessage(this.heartbeatMsgId, content, { role: 'system' });
    } else {
      // First heartbeat — create the message.
      const id = `heartbeat-${Date.now().toString(36)}`;
      this.heartbeatMsgId = id;
      const msg: ChatMessage = { id, role: 'system', content, timestamp: Date.now() };
      this.update({
        chatMessages: [...this.state.chatMessages, msg],
        isThinking: true,
      });
    }
  }

  /** Clear the heartbeat message (called when processing completes). */
  clearHeartbeat(): void {
    if (this.heartbeatMsgId) {
      this.state.chatMessages = this.state.chatMessages.filter((m) => m.id !== this.heartbeatMsgId);
      this.heartbeatMsgId = null;
      this.rerender();
    }
  }

  sendCompletion(elapsedMs: number, stepCount: number, meta?: CompletionMeta): void {
    this.clearHeartbeat();
    const secs = Math.floor(elapsedMs / 1000);
    const mins = Math.floor(secs / 60);
    const remSecs = secs % 60;
    const timeStr = mins > 0 ? `${mins}m ${remSecs}s` : `${secs}s`;
    const stepsStr = stepCount > 0 ? `${stepCount} step${stepCount !== 1 ? 's' : ''}` : '';
    const parts = [stepsStr, timeStr].filter(Boolean).join(' · ');

    const msg: ChatMessage = {
      id: `done-${Date.now().toString(36)}`,
      role: 'system',
      content: `━━━ Task complete (${parts}) ━━━`,
      timestamp: Date.now(),
      completionMeta: meta,
    };
    this.update({
      chatMessages: [...this.state.chatMessages, msg],
      isThinking: false,
      toolSteps: [],
      lastStepLog: this.state.toolSteps.length > 0 ? [...this.state.toolSteps] : (this.state.lastStepLog ?? null),
      lastStepLogElapsed: elapsedMs,
    });
  }

  async sendFile(filePath: string, _targetId?: string): Promise<void> {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const resolved = path.resolve(filePath);
    let content = '';
    if (!fs.existsSync(resolved)) {
      content = `File not found: ${filePath}`;
    } else {
      const stat = fs.statSync(resolved);
      const sizeStr = stat.size > 1024 * 1024
        ? `${(stat.size / (1024 * 1024)).toFixed(1)}MB`
        : stat.size > 1024
          ? `${(stat.size / 1024).toFixed(1)}KB`
          : `${stat.size}B`;
      content = `path: ${resolved}\nsize: ${sizeStr}`;
    }
    const msg: ChatMessage = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      role: 'agent',
      content,
      timestamp: Date.now(),
    };
    this.update({
      chatMessages: [...this.state.chatMessages, msg],
    });
  }

  async sendToolFeedback(toolName: string, args: Record<string, any>): Promise<void> {
    const label = formatToolStep(toolName, args);
    const step: ToolStep = {
      id: `step-${Date.now()}-${this.stepCount}`,
      toolName,
      label,
      status: 'running',
      startedAt: Date.now(),
    };
    this.stepCount += 1;
    this.stepStartTime = Date.now();
    logger.debug({ tool: toolName, args }, 'voice.tui step start');
    this.update({
      toolSteps: [...this.state.toolSteps, step],
      isThinking: true,
    });
  }

  sendStepDone(toolName: string, result: unknown): void {
    const summary = formatToolResult(toolName, result);
    const toolSteps = this.state.toolSteps.map((step) => {
      if (step.status === 'running') {
        const elapsed = this.stepStartTime ? (Date.now() - this.stepStartTime) / 1000 : 0;
        return { ...step, status: 'done' as const, elapsed, result: summary || undefined };
      }
      return step;
    });
    logger.debug({ tool: toolName, summary }, 'voice.tui step done');
    this.update({ toolSteps });
  }

  async stream(content: AsyncIterable<string>, _targetId?: string): Promise<string> {
    const msgId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    let full = '';
    let lastRender = 0;

    this.clearHeartbeat();

    const initialMsg: ChatMessage = {
      id: msgId,
      role: 'agent',
      content: '',
      timestamp: Date.now(),
      streaming: true,
    };

    this.update({
      chatMessages: [...this.state.chatMessages, initialMsg],
      isThinking: true,
    });

    try {
      for await (const chunk of content) {
        full += chunk;
        const now = Date.now();
        if (now - lastRender >= 16) {
          this.update({
            chatMessages: this.state.chatMessages.map((m) =>
              m.id === msgId ? { ...m, content: full, streaming: true } : m,
            ),
          });
          lastRender = now;
        }
      }
    } catch (err) {
      // Stream was interrupted (API disconnect, abort, etc.). Save
      // whatever partial text we accumulated so the user doesn't lose it.
      logger.warn({ err, partialLen: full.length }, 'CLI stream interrupted, saving partial text');
      if (full.length > 0) {
        this.update({
          chatMessages: this.state.chatMessages.map((m) =>
            m.id === msgId ? { ...m, content: full + '\n\n⚠ Stream was interrupted. Partial response shown above.', streaming: false } : m,
          ),
          isThinking: false,
        });
      } else {
        this.update({
          chatMessages: this.state.chatMessages.map((m) =>
            m.id === msgId ? { ...m, content: '⚠ Stream was interrupted before any response was generated.', streaming: false } : m,
          ),
          isThinking: false,
        });
      }
      return full;
    }

    this.update({
      chatMessages: this.state.chatMessages.map((m) =>
        m.id === msgId ? { ...m, content: full, streaming: false } : m,
      ),
      isThinking: false,
    });

    return full;
  }

  async typing(_targetId?: string): Promise<void> {
    this.update({ isThinking: true });
  }

  showPrompt(): void {}

  async withMenu<T>(runner: (select: (title: string, options: Array<{ value: string; label: string }>) => Promise<string>) => Promise<T>): Promise<T | undefined> {
    this.menuDepth += 1;
    const { selectWithArrowKeys } = await import('../utils/arrow-select.js');
    this.menuAbortController = new AbortController();

    try {
      return await runner((title, options) => selectWithArrowKeys(title, options, {
        signal: this.menuAbortController?.signal,
      }));
    } catch (error) {
      if (error instanceof Error && error.name === 'ArrowSelectCancelledError') {
        return undefined;
      }
      throw error;
    } finally {
      this.menuDepth = Math.max(0, this.menuDepth - 1);
      if (this.menuDepth === 0) {
        this.menuAbortController = null;
      }
      this.ensureRawMode();
    }
  }

  private closeActiveMenu(): void {
    if (!this.menuAbortController?.signal.aborted) {
      this.menuAbortController?.abort();
    }
  }

  async prompt(question: string): Promise<string> {
    return new Promise((resolve) => {
      this.permissionResolver = (val) => resolve(String(val));
      this.update({
        permissionPrompt: {
          type: 'ask',
          message: question,
          resolve: () => {},
        },
      });
    });
  }

  async askPermissionMode(): Promise<PermissionMode> {
    if (!process.stdout.isTTY) return 'ask-me';

    return new Promise((resolve) => {
      this.permissionResolver = (val) => resolve(val as PermissionMode);
      this.update({
        permissionPrompt: {
          type: 'mode',
          message: 'Choose how Mercury handles risky actions this session.',
          options: [
            { value: 'allow-all', label: 'Allow All — auto-approve everything (scopes, commands, loop continuation)' },
            { value: 'ask-me', label: 'Ask Me — confirm before file writes, shell commands, and scope changes' },
          ],
          resolve: () => {},
        },
      });
    });
  }

  async askPermission(prompt: string): Promise<string> {
    return new Promise((resolve) => {
      this.permissionResolver = (val) => resolve(String(val));
      this.update({
        permissionPrompt: {
          type: 'ask',
          message: prompt,
          options: [
            { value: 'yes', label: 'Yes — approve once' },
            { value: 'always', label: 'Always — remember this permission' },
            { value: 'no', label: 'No — deny' },
          ],
          resolve: () => {},
        },
      });
    });
  }

  async presentChoicePrompt(question: string, options: Array<{ value: string; label: string }>): Promise<string> {
    return new Promise((resolve) => {
      this.permissionResolver = (val) => resolve(String(val));
      this.update({
        permissionPrompt: {
          type: 'mode',
          message: question,
          options,
          resolve: () => {},
        },
      });
    });
  }

  async askToContinue(question: string, _targetId?: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.permissionResolver = (val) => {
        const normalized = typeof val === 'string' ? val.trim().toLowerCase() : val;
        resolve(normalized === true || normalized === 'yes' || normalized === 'y');
      };
      this.update({
        permissionPrompt: {
          type: 'continue',
          message: question,
          options: [
            { value: 'yes', label: 'Yes — continue' },
            { value: 'no', label: 'No — stop' },
          ],
          resolve: () => {},
        },
      });
    });
  }

  clearPermissionPrompt(): void {
    this.update({ permissionPrompt: null });
  }

  setSkills(skills: SkillInfo[]): void {
    this.update({ skills });
  }

  setProvider(name: string, model: string, badge?: string): void {
    this.update({ provider: { name, model, badge } });
  }

  setTokenInfo(used: number, budget: number, percentage: number): void {
    this.update({ tokenInfo: { used, budget, percentage } });
  }

  setSaverMode(state: import('../core/saver-mode.js').SaverModeState, savedToday: number, savedLifetime: number): void {
    if (state === 'off' && savedToday === 0 && savedLifetime === 0) {
      // Keep null to preserve zero-impact UI when saver has never been touched.
      this.update({ saverInfo: null });
      return;
    }
    this.update({ saverInfo: { state, savedToday, savedLifetime } });
  }

  setWebInfo(enabled: boolean, port: number): void {
    this.update({ web: { enabled, port } });
  }

  setSubAgents(agents: SubAgentInfo[]): void {
    this.update({ subAgents: agents });
  }

  updateBackgroundTasks(tasks: BackgroundTaskInfo[]): void {
    this.update({ backgroundTasks: tasks });
  }

  setSidebarSections(sections: SidebarSection[]): void {
    this.update({ sidebarSections: sections });
  }

  setMode(mode: AppMode): void {
    this.update({ mode });
  }

  setProgrammingStatus(mode: import('../core/programming-mode.js').ProgrammingModeState, projectContext: string | null): void {
    this.update({ programmingMode: mode, projectContext });
  }

  openWorkspace(rawPath: string): { ok: boolean; message: string } {
    const target = path.resolve(rawPath.replace(/^~(?=$|\/)/, process.env.HOME || '~'));
    if (!fs.existsSync(target)) return { ok: false, message: `Workspace path does not exist: ${target}` };
    if (!fs.statSync(target).isDirectory()) return { ok: false, message: `Workspace path is not a directory: ${target}` };

    const workspace = this.buildWorkspaceState(target, undefined, 'Workspace opened');
    this.update({ workspace, mode: 'workspace', projectContext: target });
    return { ok: true, message: `Workspace opened: ${target}` };
  }

  refreshWorkspace(): void {
    if (!this.state.workspace?.active) return;
    const selectedPath = this.state.workspace.selectedPath ?? undefined;
    const workspace = this.buildWorkspaceState(this.state.workspace.rootPath, selectedPath, 'Workspace refreshed');
    this.update({ workspace });
  }

  /**
   * Register provider callbacks the poller will sample on every tick.
   * Called once at boot from index.ts. Each callback should be cheap
   * (just a getter on already-in-memory state).
   */
  setStatusProviders(providers: typeof this.statusProviders): void {
    this.statusProviders = { ...this.statusProviders, ...providers };
  }

  /**
   * Start the 2s status poller. Refreshes:
   *  - token budget bar (every tick)
   *  - saver mode state (every tick)
   *  - sub-agent counts (every tick)
   *  - background task counts (every tick)
   *  - workspace git state (every tick, async, only if workspace is active)
   *
   * Each section diff-checks its values before calling update() so
   * idle ticks cause zero React re-renders.
   */
  startStatusPoller(intervalMs = 2000): void {
    this.stopStatusPoller();
    this.statusPoller = setInterval(() => { void this.statusPollerTick(); }, intervalMs);
    // Fire once immediately so the first paint is fresh.
    void this.statusPollerTick();
  }

  stopStatusPoller(): void {
    if (this.statusPoller) {
      clearInterval(this.statusPoller);
      this.statusPoller = null;
    }
  }

  private async statusPollerTick(): Promise<void> {
    // Re-entrancy guard: if a previous git read is still in flight we skip.
    if (this.statusPollerBusy) return;
    this.statusPollerBusy = true;
    try {
      const patch: Partial<TuiState> = {};

      // 1. Token budget
      if (this.statusProviders.tokens) {
        const t = this.statusProviders.tokens();
        const cur = this.state.tokenInfo;
        if (!cur || cur.used !== t.used || cur.budget !== t.budget || cur.percentage !== t.percentage) {
          patch.tokenInfo = { used: t.used, budget: t.budget, percentage: t.percentage };
        }
      }

      // 2. Saver mode
      if (this.statusProviders.saver) {
        const s = this.statusProviders.saver();
        const cur = this.state.saverInfo;
        const shouldShow = !(s.state === 'off' && s.savedToday === 0 && s.savedLifetime === 0);
        if (!shouldShow) {
          if (cur !== null) patch.saverInfo = null;
        } else if (!cur || cur.state !== s.state || cur.savedToday !== s.savedToday || cur.savedLifetime !== s.savedLifetime) {
          patch.saverInfo = { state: s.state, savedToday: s.savedToday, savedLifetime: s.savedLifetime };
        }
      }

      // 3. Sub-agents
      if (this.statusProviders.subAgents) {
        const agents = this.statusProviders.subAgents();
        if (!shallowEqualSubAgents(this.state.subAgents, agents)) {
          patch.subAgents = agents;
        }
      }

      // 4. Background tasks
      if (this.statusProviders.bgTasks) {
        const tasks = this.statusProviders.bgTasks();
        if (!shallowEqualBgTasks(this.state.backgroundTasks, tasks)) {
          patch.backgroundTasks = tasks;
        }
      }

      // 5. Workspace git state (async — branch/files/ahead/behind can
      // change from outside Mercury, so we re-read every tick)
      if (this.state.workspace?.active) {
        const root = this.state.workspace.rootPath;
        const fresh = await this.readGitStateAsync(root);
        const cur = this.state.workspace;
        if (
          cur.branch !== fresh.branch ||
          cur.ahead !== fresh.ahead ||
          cur.behind !== fresh.behind ||
          cur.stagedCount !== fresh.stagedCount ||
          cur.unstagedCount !== fresh.unstagedCount ||
          cur.gitFiles.length !== fresh.files.length
        ) {
          patch.workspace = {
            ...cur,
            branch: fresh.branch,
            ahead: fresh.ahead,
            behind: fresh.behind,
            stagedCount: fresh.stagedCount,
            unstagedCount: fresh.unstagedCount,
            gitFiles: fresh.files,
          };
        }
      }

      if (Object.keys(patch).length > 0) {
        this.update(patch);
      }
    } catch {
      // Polling should never crash the UI loop.
    } finally {
      this.statusPollerBusy = false;
    }
  }

  stageWorkspaceFile(filePath: string): { ok: boolean; message: string } {
    if (!this.state.workspace?.active) return { ok: false, message: 'No active workspace.' };
    const root = this.state.workspace.rootPath;
    try {
      const rel = filePath === 'all' ? '.' : filePath;
      execSync(`git add ${this.quoteArg(rel)}`, { cwd: root, stdio: 'pipe' });
      this.refreshWorkspace();
      return { ok: true, message: rel === '.' ? 'Staged all changes.' : `Staged: ${rel}` };
    } catch (err: any) {
      return { ok: false, message: `Stage failed: ${err?.message || String(err)}` };
    }
  }

  undoWorkspaceFile(filePath: string): { ok: boolean; message: string } {
    if (!this.state.workspace?.active) return { ok: false, message: 'No active workspace.' };
    const root = this.state.workspace.rootPath;
    try {
      execSync(`git checkout -- ${this.quoteArg(filePath)}`, { cwd: root, stdio: 'pipe' });
      this.refreshWorkspace();
      return { ok: true, message: `Reverted: ${filePath}` };
    } catch (err: any) {
      return { ok: false, message: `Undo failed: ${err?.message || String(err)}` };
    }
  }

  commitWorkspace(message: string): { ok: boolean; message: string } {
    if (!this.state.workspace?.active) return { ok: false, message: 'No active workspace.' };
    const root = this.state.workspace.rootPath;
    if (!message.trim()) return { ok: false, message: 'Commit message is required.' };
    const body = `${message.trim()}\n\nCo-authored-by: Mercury <mercury@cosmicstack.org>`;
    try {
      execSync(`git commit -m ${this.quoteArg(body)}`, { cwd: root, stdio: 'pipe' });
      this.refreshWorkspace();
      return { ok: true, message: 'Commit created with Mercury co-author.' };
    } catch (err: any) {
      return { ok: false, message: `Commit failed: ${err?.message || String(err)}` };
    }
  }

  getWorkspace(): WorkspaceState | null {
    return this.state.workspace;
  }

  private quoteArg(v: string): string {
    return `'${v.replace(/'/g, `'\\''`)}'`;
  }

  private moveWorkspaceSelection(delta: number): void {
    if (!this.state.workspace?.active) return;
    const next = Math.max(0, Math.min(this.state.workspace.nodes.length - 1, this.state.workspace.selectedIndex + delta));
    const node = this.state.workspace.nodes[next];
    this.update({
      workspace: {
        ...this.state.workspace,
        selectedIndex: next,
        selectedPath: node?.path || null,
      },
    });
  }

  private toggleOrSelectWorkspaceNode(): void {
    const ws = this.state.workspace;
    if (!ws?.active) return;
    const node = ws.nodes[ws.selectedIndex];
    if (!node) return;
    if (!node.isDir) {
      const preview = this.readFilePreview(node.path);
      this.update({
        workspace: {
          ...ws,
          selectedPath: node.path,
          openedFilePath: node.path,
          openedFilePreview: preview,
          codeScrollOffset: 0,
          focusArea: 'code',
          lastAction: `Opened: ${path.basename(node.path)}`,
        },
      });
      return;
    }
    const expanded = !node.expanded;
    this.rebuildWorkspaceWithExpansion(node.path, expanded);
  }

  private collapseWorkspaceNode(): void {
    const ws = this.state.workspace;
    if (!ws?.active) return;
    const node = ws.nodes[ws.selectedIndex];
    if (!node?.isDir) return;
    if (!node.expanded) return;
    this.rebuildWorkspaceWithExpansion(node.path, false);
  }

  private expandWorkspaceNode(): void {
    const ws = this.state.workspace;
    if (!ws?.active) return;
    const node = ws.nodes[ws.selectedIndex];
    if (!node?.isDir) return;
    if (node.expanded) return;
    this.rebuildWorkspaceWithExpansion(node.path, true);
  }

  private rebuildWorkspaceWithExpansion(nodePath: string, expand: boolean): void {
    const ws = this.state.workspace;
    if (!ws) return;
    const expandedSet = new Set(ws.nodes.filter((n) => n.isDir && n.expanded).map((n) => n.path));
    if (expand) expandedSet.add(nodePath);
    else expandedSet.delete(nodePath);
    const workspace = this.buildWorkspaceState(ws.rootPath, ws.selectedPath || undefined, ws.lastAction, expandedSet);
    this.update({ workspace });
  }

  private buildWorkspaceState(rootPath: string, selectedPath?: string, lastAction = '', preExpanded?: Set<string>): WorkspaceState {
    const expanded = preExpanded || new Set<string>([rootPath]);
    const nodes = this.buildTreeNodes(rootPath, expanded, 0);
    const selectedIndex = Math.max(0, nodes.findIndex((n) => n.path === selectedPath));
    const selectedNode = nodes[selectedIndex] || nodes[0] || null;
    const { files, branch, stagedCount, unstagedCount, ahead, behind } = this.readGitState(rootPath);
    return {
      active: true,
      rootPath,
      nodes,
      selectedIndex,
      selectedPath: selectedNode?.path || null,
      openedFilePath: this.state.workspace?.openedFilePath || null,
      openedFilePreview: this.state.workspace?.openedFilePreview || [],
      gitFiles: files,
      stagedCount,
      unstagedCount,
      branch,
      ahead,
      behind,
      lastAction,
      codeScrollOffset: this.state.workspace?.codeScrollOffset ?? 0,
      focusArea: this.state.workspace?.focusArea ?? 'explorer',
      chatCollapsed: this.state.workspace?.chatCollapsed ?? false,
      chatScrollOffset: this.state.workspace?.chatScrollOffset ?? 0,
      rightPanel: this.state.workspace?.rightPanel ?? 'chat',
    };
  }

  closeWorkspaceFile(): void {
    const ws = this.state.workspace;
    if (!ws?.active) return;
    this.update({ workspace: { ...ws, openedFilePath: null, openedFilePreview: [], codeScrollOffset: 0, focusArea: 'explorer', lastAction: 'Closed file preview' } });
  }

  scrollWorkspaceCode(delta: number): void {
    const ws = this.state.workspace;
    if (!ws?.active || !ws.openedFilePreview.length) return;
    const maxOffset = Math.max(0, ws.openedFilePreview.length - 1);
    const next = Math.max(0, Math.min(maxOffset, ws.codeScrollOffset + delta));
    if (next !== ws.codeScrollOffset) {
      this.update({ workspace: { ...ws, codeScrollOffset: next } });
    }
  }

  setWorkspaceFocus(area: 'explorer' | 'code' | 'git' | 'chat'): void {
    const ws = this.state.workspace;
    if (!ws?.active) return;
    // When focusing git or chat, also switch the right panel
    const rightPanel = area === 'git' ? 'git' : area === 'chat' ? 'chat' : ws.rightPanel;
    this.update({ workspace: { ...ws, focusArea: area, rightPanel } });
  }

  toggleWorkspaceChat(): void {
    const ws = this.state.workspace;
    if (!ws?.active) return;
    // Toggle right panel between chat and git
    const rightPanel = ws.rightPanel === 'chat' ? 'git' : 'chat';
    const focusArea = rightPanel === 'chat' ? 'chat' : ws.focusArea === 'chat' ? 'explorer' : ws.focusArea;
    this.update({ workspace: { ...ws, rightPanel, focusArea } });
  }

  scrollWorkspaceChat(delta: number): void {
    const ws = this.state.workspace;
    if (!ws?.active) return;
    const maxOffset = Math.max(0, this.state.chatMessages.length - 1);
    const next = Math.max(0, Math.min(maxOffset, ws.chatScrollOffset + delta));
    if (next !== ws.chatScrollOffset) {
      this.update({ workspace: { ...ws, chatScrollOffset: next } });
    }
  }

  private exitWorkspaceToChat(): void {
    const ws = this.state.workspace;
    const nextWorkspace = ws ? { ...ws, active: false, focusArea: 'explorer' as const, codeScrollOffset: 0, chatCollapsed: false, chatScrollOffset: 0, rightPanel: 'chat' as const, lastAction: 'Exited workspace mode' } : null;
    this.update({
      mode: 'chat',
      workspace: nextWorkspace,
      programmingMode: 'off',
      projectContext: null,
    });
  }

  private readFilePreview(filePath: string): string[] {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      return raw.split('\n').slice(0, 500);
    } catch {
      return ['(Unable to read file preview)'];
    }
  }

  private buildTreeNodes(dir: string, expanded: Set<string>, depth: number): WorkspaceTreeNode[] {
    const nodes: WorkspaceTreeNode[] = [];
    const id = `${dir}:${depth}`;
    const isExpanded = expanded.has(dir);
    nodes.push({ id, name: depth === 0 ? path.basename(dir) || dir : path.basename(dir), path: dir, depth, isDir: true, expanded: isExpanded });
    if (!isExpanded) return nodes;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return nodes;
    }
    const sorted = entries
      .filter((e) => e.name !== '.git' && e.name !== 'node_modules')
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of sorted.slice(0, 200)) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        nodes.push(...this.buildTreeNodes(full, expanded, depth + 1));
      } else {
        nodes.push({ id: `${full}:${depth + 1}`, name: entry.name, path: full, depth: depth + 1, isDir: false });
      }
    }
    return nodes;
  }

  private readGitState(rootPath: string): { files: WorkspaceGitFile[]; branch: string; stagedCount: number; unstagedCount: number; ahead: number; behind: number } {
    try {
      const branch = execSync('git branch --show-current', { cwd: rootPath, stdio: 'pipe' }).toString().trim() || 'detached';
      const out = execSync('git status --porcelain=v1 --branch', { cwd: rootPath, stdio: 'pipe' }).toString();
      return this.parseGitOutput(branch, out);
    } catch {
      return { files: [], branch: 'not-a-git-repo', stagedCount: 0, unstagedCount: 0, ahead: 0, behind: 0 };
    }
  }

  private parseGitOutput(branch: string, statusOut: string): { files: WorkspaceGitFile[]; branch: string; stagedCount: number; unstagedCount: number; ahead: number; behind: number } {
    const lines = statusOut.split('\n');
    let ahead = 0;
    let behind = 0;
    const header = lines[0] || '';
    const aheadMatch = header.match(/ahead (\d+)/);
    const behindMatch = header.match(/behind (\d+)/);
    if (aheadMatch) ahead = parseInt(aheadMatch[1], 10);
    if (behindMatch) behind = parseInt(behindMatch[1], 10);
    const files: WorkspaceGitFile[] = lines
      .slice(1)
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map((line) => {
        const x = line[0] || ' ';
        const y = line[1] || ' ';
        const rel = line.slice(3).trim();
        const staged = x !== ' ' && x !== '?';
        const status = `${x}${y}`.trim() || '??';
        return { path: rel, staged, status };
      });
    const stagedCount = files.filter((f) => f.staged).length;
    const unstagedCount = files.length - stagedCount;
    return { files, branch, stagedCount, unstagedCount, ahead, behind };
  }

  private execAsync(cmd: string, args: string[], cwd: string, timeoutMs = 1500): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 1024 * 512 }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout.toString());
      });
    });
  }

  private async readGitStateAsync(rootPath: string): Promise<{ files: WorkspaceGitFile[]; branch: string; stagedCount: number; unstagedCount: number; ahead: number; behind: number }> {
    try {
      const [branchOut, statusOut] = await Promise.all([
        this.execAsync('git', ['branch', '--show-current'], rootPath),
        this.execAsync('git', ['status', '--porcelain=v1', '--branch'], rootPath),
      ]);
      const branch = branchOut.trim() || 'detached';
      return this.parseGitOutput(branch, statusOut);
    } catch {
      return { files: [], branch: 'not-a-git-repo', stagedCount: 0, unstagedCount: 0, ahead: 0, behind: 0 };
    }
  }

  initSplash(agentName: string, version: string): void {
    this.update({ agentName, version, mode: 'splash' });
  }

  sendUserMessage(content: string): void {
    const userMsg: ChatMessage = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      role: 'user',
      content,
      timestamp: Date.now(),
    };
    this.update({ chatMessages: [...this.state.chatMessages, userMsg] });
    this.emit({
      id: userMsg.id,
      channelId: 'cli',
      channelType: 'cli',
      senderId: 'owner',
      content,
      timestamp: userMsg.timestamp,
    });
  }
}
