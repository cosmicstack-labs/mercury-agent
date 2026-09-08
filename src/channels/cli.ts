import React from 'react';
import { EventEmitter } from 'node:events';
import { render } from 'ink';
import fs from 'node:fs';
import path from 'node:path';
import { execSync, execFile, execFileSync } from 'node:child_process';
import type { ChannelMessage } from '../types/channel.js';
import { BaseChannel, type PermissionMode } from './base.js';
import { STEPS_PAUSED_BANNER, NO_CHANGES_BANNER } from '../core/completion-verdict.js';
import { logger } from '../utils/logger.js';
import { formatToolStep, formatToolResult } from '../utils/tool-label.js';
import type { ChatMessage, CompletionMeta, FileChangeSummary, ToolStep, PermissionPromptState, CurrentSessionInfo, SidebarSection, SkillInfo, SubAgentInfo, ProviderInfo, TokenInfo, SaverInfo, AppMode, WorkspaceState, WorkspaceTreeNode, WorkspaceGitFile, BackgroundTaskInfo, MercuryCodeGitState, MercuryCodeState, LiveActivityState, PlanStep } from '../ui/types.js';
import { TuiApp } from '../ui/App.js';
import { ResilientTuiOutput } from '../ui/resilient-output.js';

/**
 * Strip mouse-report escape sequences from terminal input before Ink sees
 * them. Terminals emit SGR mouse sequences (ESC [ < b ; c ; r M/m) or legacy
 * X10 ones (ESC [ M ...); scrolling a trackpad emits a flood of these, and
 * Ink's keypress parser only partially consumes them, leaking fragments
 * ("<0;34;12M") into the input box as garbage text.
 */
const MOUSE_SEQ_RE = /\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[M[\x20-\x2f]*[\x40-\x6f]|\x1b\[\?100[0-7][hl]/g;

/**
 * Parsed mouse event from an SGR/X10 sequence.
 * click: press (or release of a press) without motion and without wheel.
 */
export interface MouseEvent {
  button: number;      // 0 left, 1 middle, 2 right, 64/65 wheel up/down
  col: number;         // 0-based
  row: number;         // 0-based
  wheel: 'up' | 'down' | null;
  click: boolean;
  release: boolean;
  motion: boolean;
}

/** Parse a single SGR or X10 mouse sequence into a MouseEvent. */
export function parseMouseSequence(seq: string): MouseEvent | null {
  // SGR: ESC [ < b ; c ; r M/m
  const sgr = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(seq);
  if (sgr) {
    const rawButton = parseInt(sgr[1], 10);
    const col = parseInt(sgr[2], 10) - 1;
    const row = parseInt(sgr[3], 10) - 1;
    const isRelease = sgr[4] === 'm';
    const motion = (rawButton & 32) !== 0;
    const wheelBits = (rawButton & 64) !== 0;
    const wheel: 'up' | 'down' | null = wheelBits ? ((rawButton & 1) === 0 ? 'up' : 'down') : null;
    return {
      button: rawButton & 3,
      col,
      row,
      wheel,
      click: !isRelease && !wheel && !motion,
      release: isRelease,
      motion,
    };
  }
  // X10: ESC [ M cb+32 cx+32 cy+32
  const x10 = /^\x1b\[M([\x20-\x2f])([\x20-\xff])([\x20-\xff])$/.exec(seq);
  if (x10) {
    const rawButton = x10[1].charCodeAt(0) - 32;
    const col = x10[2].charCodeAt(0) - 33;
    const row = x10[3].charCodeAt(0) - 33;
    const wheelBits = (rawButton & 64) !== 0;
    const motion = (rawButton & 32) !== 0;
    const wheel: 'up' | 'down' | null = wheelBits ? ((rawButton & 1) === 0 ? 'up' : 'down') : null;
    return {
      button: rawButton & 3,
      col,
      row,
      wheel,
      click: !wheel && !motion,
      release: false,
      motion,
    };
  }
  return null;
}

/** DECSET sequences to start (enable=true) or stop mouse reporting. */
export function mouseTrackingSequences(enable: boolean): string {
  return enable
    ? '\x1b[?1000h\x1b[?1002h\x1b[?1006h'
    : '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l';
}

/**
 * Stateful mouse-sequence filter for the terminal input stream.
 *
 * Feeds complete mouse sequences (SGR/X10) to `onEvent`, passes every
 * other byte through `write`, and HOLDS BACK partial escape prefixes so a
 * sequence split across two stdin chunks is joined — never dropped,
 * never leaked as keystrokes. A bounded holdback prevents a corrupt
 * stream from growing memory without limit.
 */
/**
 * Ink-facing stdin: forwards the Ink-required stream surface (setRawMode,
 * ref/unref, setEncoding, readable/read) to the real terminal stream while
 * feeding every chunk through the MouseSequenceFilter first. Ink never sees
 * raw mouse sequences; wheel events become transcript scrolling in Mercury
 * Code. Non-mouse bytes pass through byte-identical.
 */
class TtyStdinProxy extends EventEmitter {
  private buffer = '';
  private readonly real: NodeJS.ReadStream;
  private readonly filter: MouseSequenceFilter;

  readonly isTTY = true;

  constructor(real: NodeJS.ReadStream, filter: MouseSequenceFilter) {
    super();
    this.real = real;
    this.filter = filter;
    this.real.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      this.filter.push(text);
    });
    this.real.on('end', () => this.emit('end'));
    this.real.on('close', () => this.emit('close'));
  }

  /** Filter output lands here (called by the MouseSequenceFilter). */
  write(s: string): void {
    if (s.length === 0) return;
    this.buffer += s;
    this.emit('readable');
  }

  read(): string | null {
    if (this.buffer.length === 0) return null;
    const out = this.buffer;
    this.buffer = '';
    return out;
  }

  setEncoding(enc: BufferEncoding): this {
    this.real.setEncoding(enc);
    return this;
  }

  setRawMode(mode: boolean): this {
    this.real.setRawMode(mode);
    return this;
  }

  ref(): this { this.real.ref(); return this; }
  unref(): this { this.real.unref(); return this; }
  resume(): this { this.real.resume(); return this; }
  pause(): this { this.real.pause(); return this; }
}

export class MouseSequenceFilter {
  private buf = '';
  private static readonly SGR = /^\x1b\[<\d+;\d+;\d+[Mm]/;
  private static readonly X10 = /^\x1b\[M[\x20-\x2f][\x20-\xff][\x20-\xff]/;
  private static readonly DEC = /^\x1b\[\?100[0-7][hl]/;
  private static readonly CSI_COMPLETE = /^\x1b\[[\d;<]*[A-Za-z]/;
  private static readonly MAX_HOLDBACK = 64;

  constructor(
    private onEvent: (ev: MouseEvent) => void,
    private write: (s: string) => void,
  ) {}

  /** Feed a raw chunk from the terminal; returns nothing, side-effects only. */
  push(chunk: Buffer | string): void {
    this.buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let out = '';
    let i = 0;
    while (i < this.buf.length) {
      const rest = this.buf.slice(i);
      if (rest[0] !== '\x1b') {
        out += rest[0];
        i += 1;
        continue;
      }
      const seq = MouseSequenceFilter.SGR.exec(rest)?.[0]
        ?? MouseSequenceFilter.X10.exec(rest)?.[0]
        ?? MouseSequenceFilter.DEC.exec(rest)?.[0];
      if (seq) {
        const ev = parseMouseSequence(seq);
        if (ev) {
          try { this.onEvent(ev); } catch { /* handler must never crash input */ }
        }
        i += seq.length;
        continue;
      }
      // X10 mouse in flight (ESC [ M + 0-2 pending payload bytes) — MUST be
      // tested before the generic CSI pass-through, because 'M' is a valid
      // CSI final byte and would otherwise leak the prefix downstream.
      if (/^\x1b\[M[\x20-\xff]{0,2}$/.test(rest)) {
        break;
      }
      // Complete non-mouse CSI (arrow keys etc.) — pass through untouched.
      const csi = MouseSequenceFilter.CSI_COMPLETE.exec(rest)?.[0];
      if (csi) {
        out += csi;
        i += csi.length;
        continue;
      }
      // Incomplete escape sequence — hold it back and wait for the rest.
      // Covers CSI starts (ESC [ 3 2 ...) and SGR mouse starts (ESC [ < 6 4 ;).
      if (/^\x1b(\[[\d;<\?<>]*)?$/.test(rest)) {
        break;
      }
      // Unknown escape byte — pass it through so Ink's parser sees it.
      out += rest[0];
      i += 1;
    }
    this.buf = i >= this.buf.length ? '' : this.buf.slice(i);
    // Overflow guard: an unterminated garbage prefix must not grow forever.
    // Flush it, stripping ESC bytes so terminal/Ink never sees raw ones.
    if (this.buf.length > MouseSequenceFilter.MAX_HOLDBACK) {
      this.buf = '';
    }
    if (out) this.write(out);
  }
}

export interface TuiState {
  mode: AppMode;
  viewMode: 'balanced' | 'detailed';
  chatMessages: ChatMessage[];
  toolSteps: ToolStep[];
  /** Live plan checklist maintained by the agent via the update_plan tool. */
  planProgress: PlanStep[] | null;
  /** Live reasoning preview while the model thinks before speaking. */
  thinkingPreview: string | null;
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
  currentSession: CurrentSessionInfo | null;
  /** Mercury Code (full-screen `/code`) state — null unless active. */
  mercuryCode: MercuryCodeState | null;
  /** Double-Esc detection for Mercury Code exit. */
  exitEscArmed: boolean;
  /** Real-time activity phase (what the agent is doing right now), or null when idle. */
  liveActivity: LiveActivityState | null;
}

const defaultState: TuiState = {
  mode: 'splash',
  viewMode: 'balanced',
  chatMessages: [],
  toolSteps: [],
  planProgress: null,
  thinkingPreview: null,
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
  currentSession: null,
  mercuryCode: null,
  exitEscArmed: false,
  liveActivity: null,
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
  private statusPoller: NodeJS.Timeout | null = null;
  private statusPollerBusy = false;
  private mouseEnabled = false;
  private mouseHandler: ((ev: MouseEvent) => void) | null = null;
  private tuiOutput: ResilientTuiOutput | null = null;
  private stateListeners = new Set<() => void>();
  private rerenderMicrotaskQueued = false;
  private tuiExitImmediate: NodeJS.Immediate | null = null;
  private exitEscArmed = false;
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
    this.stopStatusPoller();
    this.setMouseEnabled(false);
    if (this.tuiExitImmediate) {
      clearImmediate(this.tuiExitImmediate);
      this.tuiExitImmediate = null;
    }
    this.teardownTui();
    this.ready = false;
  }

  private teardownTui(): void {
    const inkInstance = this.inkInstance;
    this.inkInstance = null;
    // Unmount may throw on a corrupted Yoga heap; shutdown must still
    // release the output wrapper and restore the terminal.
    try { inkInstance?.unmount(); } catch { /* best effort teardown */ }
    this.stateListeners.clear();
    this.tuiOutput?.dispose();
    this.tuiOutput = null;
    this.releaseRawMode();
    this.restoreTerminal();
  }

  private scheduleTuiExit(): void {
    if (this.tuiExitImmediate) return;
    this.setMouseEnabled(false);
    // useInput runs inside React's batchedUpdates. Calling Ink.unmount()
    // there re-enters the reconciler and can invalidate Yoga nodes while
    // they are still being laid out. Leave React's callback stack first.
    this.tuiExitImmediate = setImmediate(() => {
      this.tuiExitImmediate = null;
      this.teardownTui();
      this.exitHandler?.();
    });
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

  private restoreRawModeAfterMenu(): void {
    if (!process.stdin.isTTY) return;
    const stdin = process.stdin as NodeJS.ReadStream;
    if (stdin.isRaw === true || typeof stdin.setRawMode !== 'function') return;
    try {
      // Arrow menus temporarily own stdin and disable raw mode on exit.
      // Do not call resume(): Ink consumes stdin through a readable listener.
      stdin.setRawMode(true);
    } catch {
      // Ink will surface input failures if the TTY is no longer available.
    }
  }

  private update(partial: Partial<TuiState>): void {
    this.state = { ...this.state, ...partial };
    this.rerender();
  }

  /** useSyncExternalStore contract: read the latest immutable state snapshot. */
  getTuiStateSnapshot = (): TuiState => {
    return this.state;
  };

  /** useSyncExternalStore contract: subscribe to state changes. */
  subscribeToTuiState = (listener: () => void): (() => void) => {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  };

  /** Update an existing chat message's content in place (by ID). */
  private updateMessage(id: string, content: string, extra?: Partial<ChatMessage>): void {
    this.update({
      chatMessages: this.state.chatMessages.map((m) =>
        m.id === id ? { ...m, content: content.slice(0, CLIChannel.MAX_MESSAGE_CHARS), timestamp: Date.now(), ...extra } : m,
      ),
    });
  }

  private rerender(): void {
    // Notify React subscribers instead of calling inkInstance.rerender().
    // Imperative re-rendering enters the reconciler synchronously from
    // arbitrary call sites and races React's own renders (spinner/size
    // timers) — the resulting re-entrant commit corrupted Yoga's WASM heap
    // ("memory access out of bounds").
    //
    // Notifications are deferred to the event loop's check phase and
    // coalesced: update() is sometimes called from inside React's own
    // commit phase (e.g. the scroll-clamp effect calls back into channel
    // state). A synchronous listener call there would re-enter the
    // reconciler mid-work — React's "Should not already be working." error.
    // setImmediate (not queueMicrotask) is deliberate: microtasks drain
    // before timers, so under streaming render pressure a memory-guard
    // interval could never fire and a runaway task reached a fatal V8 OOM.
    // The check phase lets pending timers run between render batches.
    if (this.rerenderMicrotaskQueued) return;
    this.rerenderMicrotaskQueued = true;
    setImmediate(() => {
      this.rerenderMicrotaskQueued = false;
      this.stateListeners.forEach((listener) => listener());
    });
  }

  /**
   * Restore the terminal to a sane, non-mouse state. Called on every exit
   * path (graceful stop, TUI exit, crash handlers) so a crashed Mercury
   * never leaves the shell spewing mouse-report garbage.
   */
  restoreTerminal(): void {
    try {
      process.stdout.write(mouseTrackingSequences(false) + '\x1b[?25h');
    } catch { /* not a TTY */ }
  }

  mountTUI(onInput: (text: string) => void, spotifyClient?: any, onExit?: any): void {
    this.spotifyClient = spotifyClient ?? null;
    this.exitHandler = onExit ?? null;
    if (this.tuiExitImmediate) {
      clearImmediate(this.tuiExitImmediate);
      this.tuiExitImmediate = null;
    }
    // Ink reads through the filtered proxy: mouse sequences never reach the
    // input box, and wheel events drive Mercury Code scrolling.
    this.installStdinProxy();

    this.inputHandler = (text: string) => {
      const trimmed = text.trim();
      if (trimmed === '/chat' || trimmed === '/c') {
        // Returning from Mercury Code must tear down its state (mouse mode,
        // scroll offset, programming mode) — not just flip the view. A bare
        // mode switch left mercuryCode set and programmingMode dangling.
        if (this.state.mode === 'mercury-code') this.exitMercuryCode();
        else this.update({ mode: 'chat' });
        return;
      }
      // Instant switch back to regular chat — no exit-confirm dance. The
      // confirm exists to guard the Esc-Esc path against accidental exits
      // mid-task; an explicit command is deliberate by definition.
      if (trimmed === '/code chat' || trimmed === '/code back') {
        if (this.state.mercuryCode) this.exitMercuryCode();
        return;
      }
      // `/code` flows to the agent so core ProgrammingMode + view stay in
      // sync (agent calls back into enterMercuryCode).
      // Internal Mercury Code view commands (issued by the TUI itself).
      if (trimmed.startsWith('/mc ')) {
        const sub = trimmed.slice(4).trim();
        // scroll-set MUST be matched before the generic scroll- prefix — the
        // generic branch parses 'scroll-set N' as delta 'set N' (NaN) and
        // returns, which silently killed the scroll-clamp loop: after a
        // history trim the stored offset could exceed the shrunken
        // transcript forever, leaving the viewport stuck on the last rows
        // ("can't scroll, only see the code").
        if (sub.startsWith('scroll-set ')) {
          const distance = parseInt(sub.slice(11), 10);
          if (Number.isFinite(distance)) {
            const mcRef = this.state.mercuryCode;
            if (mcRef && distance !== mcRef.scrollOffset) {
              this.update({ mercuryCode: { ...mcRef, scrollOffset: distance } });
            }
          }
          return;
        }
        if (sub === 'scroll' || sub.startsWith('scroll ') || sub.startsWith('scroll-')) {
          const arg = sub.startsWith('scroll-') ? sub.slice(7) : sub.slice(6).trim();
          const delta = arg.startsWith('-') ? -parseInt(arg.slice(1), 10) : parseInt(arg, 10);
          if (Number.isFinite(delta)) this.scrollMercuryCode(delta);
          return;
        }
        if (sub === 'live') { this.scrollMercuryCodeToLive(); return; }
        if (sub === 'esc-arm') {
          this.exitEscArmed = true;
          // Auto-disarm after 1.5s so Esc-Esc window is bounded.
          setTimeout(() => { if (this.exitEscArmed) { this.exitEscArmed = false; this.update({ exitEscArmed: false }); } }, 1500);
          this.update({ exitEscArmed: true });
          return;
        }
        if (sub === 'exit-arm') { this.exitEscArmed = false; this.update({ exitEscArmed: false }); this.setMercuryCodeExitConfirm(true); return; }
        if (sub === 'exit-cancel') { this.exitEscArmed = false; this.update({ exitEscArmed: false }); this.setMercuryCodeExitConfirm(false); return; }
        if (sub === 'exit-confirm' || sub === 'exit-force') {
          this.exitEscArmed = false;
          this.update({ exitEscArmed: false });
          this.exitMercuryCode();
          return;
        }
        if (sub === 'git-refresh') { this.refreshMercuryCodeGit(); return; }
        return;
      }
      if (trimmed === '/mc') {
        this.update({ exitEscArmed: false });
        return;
      }
      if (trimmed === '/coding') {
        this.update({ mode: this.state.mode === 'mercury-code' ? 'mercury-code' : 'coding' });
        return;
      }
      if (trimmed === '/workspace' || trimmed === '/ws') {
        if (this.state.mode === 'mercury-code') return;
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
        if (this.state.mode === 'mercury-code') return;
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
        const [deltaRaw, viewportRaw] = trimmed.slice(11).trim().split(/\s+/);
        const delta = parseInt(deltaRaw, 10);
        const viewportLines = parseInt(viewportRaw, 10);
        if (!isNaN(delta)) this.scrollWorkspaceCode(delta, Number.isFinite(viewportLines) ? viewportLines : 1);
        return;
      }
      if (trimmed === '/ws scroll-home') {
        this.scrollWorkspaceCodeToBoundary('top');
        return;
      }
      if (trimmed.startsWith('/ws scroll-end ')) {
        const viewportLines = parseInt(trimmed.slice(15), 10);
        this.scrollWorkspaceCodeToBoundary('bottom', Number.isFinite(viewportLines) ? viewportLines : 1);
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
      if (trimmed.startsWith('/ws chat-set ')) {
        const distance = parseInt(trimmed.slice(13), 10);
        if (Number.isFinite(distance)) this.setWorkspaceChatDistance(distance);
        return;
      }
      if (trimmed === '/ws chat-home') {
        this.setWorkspaceChatBoundary('top');
        return;
      }
      if (trimmed === '/ws chat-end') {
        this.setWorkspaceChatBoundary('bottom');
        return;
      }
      if (trimmed === '/menu' || trimmed === '/m') {
        if (this.state.mode === 'mercury-code') return;
        this.update({ mode: 'menu' });
        return;
      }
      if (trimmed === '/spotify' || trimmed === '/s') {
        if (this.state.mode === 'mercury-code') return;
        this.update({ mode: 'spotify' });
        return;
      }
      if (trimmed === '/splash') {
        if (this.state.mode === 'mercury-code') return;
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
          this.trimAndSetMessages([...this.state.chatMessages, msg]);
        } else {
          const msg: ChatMessage = {
            id: `log-${Date.now().toString(36)}`,
            role: 'system',
            content: 'No step history available yet. Run a task first, then press Ctrl+D.',
            timestamp: Date.now(),
          };
          this.trimAndSetMessages([...this.state.chatMessages, msg]);
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

    // Reset mouse-report modes in case a previous run left the terminal
    // stuck emitting mouse sequences (1000/1002/1003 + SGR 1006).
    try {
      process.stdout.write('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l');
    } catch {
      // Not a TTY or write failed — nothing to reset.
    }

    this.tuiOutput?.dispose();
    this.tuiOutput = new ResilientTuiOutput(process.stdout, process.stderr);
    // Single mount. Every later UI update flows through useSyncExternalStore
    // notifications — never inkInstance.rerender(), whose synchronous
    // reconciler entry caused re-entrant commits and Yoga WASM corruption.
    this.inkInstance = render(
      React.createElement(TuiApp, {
        channel: this,
        onInput: (text: string) => { this.inputHandler?.(text); },
        onPermissionResolve: (value: string | boolean) => {
          if (this.permissionResolver) {
            this.permissionResolver(value);
            this.permissionResolver = null;
          }
          this.update({ permissionPrompt: null });
        },
        onExit: () => {
          this.scheduleTuiExit();
        },
        spotifyClient: this.spotifyClient,
      }),
      { exitOnCtrlC: false, patchConsole: false, stdin: (this.stdinProxy ?? process.stdin) as unknown as NodeJS.ReadStream, stdout: this.tuiOutput as unknown as NodeJS.WriteStream },
    );
  }

  private stdinProxy: TtyStdinProxy | null = null;

  /** Install the filtered-stdin proxy: Ink reads clean text; the mouse
   *  filter (always active) delivers wheel events for transcript scrolling
   *  and never lets raw sequences leak into the input. */
  private installStdinProxy(): void {
    if (this.stdinProxy) return;
    const proxy = new TtyStdinProxy(process.stdin, new MouseSequenceFilter(
      (ev) => this.dispatchMouseEvent(ev),
      (s) => proxy.write(s),
    ));
    this.stdinProxy = proxy;
  }

  /** Hard cap on rendered transcript messages held in TUI state. */
  private static readonly MAX_CHAT_MESSAGES = 2000;
  /**
   * Byte budget for the rendered transcript. Sized to retain a full
   * Mercury Code session without scrolling history out of reach: even a
   * 75-step coding task with file echoes stays ~2MB now that per-message
   * content is capped and the AI SDK no longer clones raw bodies per step.
   */
  private static readonly MAX_CHAT_CHARS = 4 * 1024 * 1024;
  /** Per-message cap: larger payloads are truncated with a notice. */
  private static readonly MAX_MESSAGE_CHARS = 64 * 1024;

  private trimAndSetMessages(messages: ChatMessage[], extra: Partial<TuiState> = {}): void {
    // Transcript bounds: cap both message count and total retained chars.
    // Dropping oldest keeps renders + heap flat while preserving the tail
    // the user is actively reading. The WorkLedger/session stores preserve
    // the full history elsewhere.
    let trimmed = messages.length > CLIChannel.MAX_CHAT_MESSAGES
      ? messages.slice(-CLIChannel.MAX_CHAT_MESSAGES)
      : messages;
    // Per-message display cap: one multi-MB payload (a whole-file echo from
    // a coding task) must never dominate the transcript heap. Full text is
    // preserved in the session store; the TUI keeps the head + a notice.
    trimmed = trimmed.map((msg) => msg.content.length > CLIChannel.MAX_MESSAGE_CHARS
      ? { ...msg, content: msg.content.slice(0, CLIChannel.MAX_MESSAGE_CHARS) + `\n\n[…display truncated at ${Math.round(CLIChannel.MAX_MESSAGE_CHARS / 1024)}KB — full content in session history]` }
      : msg);
    let total = 0;
    for (const msg of trimmed) total += msg.content.length;
    while (trimmed.length > 1 && total > CLIChannel.MAX_CHAT_CHARS) {
      total -= trimmed[0].content.length;
      trimmed = trimmed.slice(1);
    }
    if (trimmed.length !== messages.length) {
      trimmed = trimmed.map((msg, i) => i === 0 && trimmed.length > 0
        ? { ...msg, content: `[…earlier transcript trimmed to keep Mercury responsive…]\n${msg.content}` }
        : msg);
    }
    this.update({ chatMessages: trimmed, ...extra });
  }

  /**
   * Show a file-change preview in the transcript (Mercury Code / coding
   * surfaces): a bounded, syntax-highlighted excerpt of what the agent just
   * wrote or edited. Formatted by utils/file-preview.ts. Skips silently
   * when the identical preview is already the last message (tool retries).
   */
  showFileChange(content: string): void {
    if (!content) return;
    const last = this.state.chatMessages[this.state.chatMessages.length - 1];
    if (last && last.role === 'system' && last.content === content) return;
    const msg: ChatMessage = {
      id: `file-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      role: 'system',
      content,
      timestamp: Date.now(),
    };
    this.trimAndSetMessages([...this.state.chatMessages, msg]);
  }

  async send(content: string, _targetId?: string, _elapsedMs?: number): Promise<void> {
    const msg: ChatMessage = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      role: 'agent',
      content,
      timestamp: Date.now(),
    };
    // Clear any lingering heartbeat message when we send a real response.
    let chat = this.state.chatMessages;
    if (this.heartbeatMsgId) {
      chat = chat.filter((m) => m.id !== this.heartbeatMsgId);
      this.heartbeatMsgId = null;
    }
    this.trimAndSetMessages([...chat, msg], { isThinking: false, liveActivity: null });
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
      this.trimAndSetMessages([...this.state.chatMessages, msg], { isThinking: true });
    }
  }

  /** Clear the heartbeat message (called when processing completes). */
  clearHeartbeat(): void {
    if (this.heartbeatMsgId) {
      // All state changes must go through update() — direct mutation here
      // previously bypassed render notification.
      const id = this.heartbeatMsgId;
      this.heartbeatMsgId = null;
      this.update({
        chatMessages: this.state.chatMessages.filter((m) => m.id !== id),
        isThinking: false,
      });
    } else {
      this.rerender();
    }
  }

  /**
   * Real-time tool event: called at TOOL EXECUTION START (from the AI SDK's
   * onToolCallStart), not after the LLM step completes. The step shows as
   * running with a live elapsed timer while the tool actually runs.
   */
  sendToolEvent(toolName: string, args: Record<string, any>, callId: string): Promise<void> {
    const label = formatToolStep(toolName, args);
    // Reuse an existing running step for the same callId (e.g. duplicate start).
    const existing = this.state.toolSteps.find((s) => s.callId === callId && s.status === 'running');
    if (existing) {
      return this.sendToolFeedback(toolName, args);
    }
    const step: ToolStep = {
      id: `step-${Date.now()}-${this.stepCount}`,
      toolName,
      label,
      status: 'running',
      startedAt: Date.now(),
      callId,
    };
    this.stepCount += 1;
    this.stepStartTime = Date.now();
    // Cap the live step list: long coding sessions can run hundreds of
    // tool calls; an unbounded array both bloats renders and memory.
    const MAX_LIVE_STEPS = 60;
    this.update({
      toolSteps: [...this.state.toolSteps, step].slice(-MAX_LIVE_STEPS),
      isThinking: true,
    });
    return Promise.resolve();
  }

  /**
   * Real-time tool completion: pairs with sendToolEvent via callId so the
   * exact step that started flips to done — even when several tools ran.
   */
  completeToolEvent(toolName: string, result: unknown, isError: boolean, durationMs?: number): void {
    const summary = formatToolResult(toolName, result);
    let matched = false;
    const toolSteps = this.state.toolSteps.map((step) => {
      if (!matched && step.status === 'running' && step.toolName === toolName) {
        matched = true;
        return {
          ...step,
          status: (isError ? 'error' : 'done') as 'done' | 'error',
          elapsed: durationMs != null ? durationMs / 1000 : (step.startedAt ? (Date.now() - step.startedAt) / 1000 : 0),
          result: summary || undefined,
        };
      }
      return step;
    });
    this.update({ toolSteps });
  }

  sendCompletion(elapsedMs: number, stepCount: number, meta?: CompletionMeta, outcome?: 'complete' | 'steps-paused'): void {
    this.clearHeartbeat();
    this.clearLiveActivity();
    const secs = Math.floor(elapsedMs / 1000);
    const mins = Math.floor(secs / 60);
    const remSecs = secs % 60;
    const timeStr = mins > 0 ? `${mins}m ${remSecs}s` : `${secs}s`;
    const stepsStr = stepCount > 0 ? `${stepCount} step${stepCount !== 1 ? 's' : ''}` : '';
    const parts = [stepsStr, timeStr].filter(Boolean).join(' · ');

    // Completion contract: a paused task never wears the completion banner,
    // and execute-mode work that changed nothing cannot claim "complete".
    let content = outcome === 'steps-paused'
      ? STEPS_PAUSED_BANNER
      : `Task complete · ${parts}`;
    // AUTO shares execute-class display semantics (file-change summaries,
    // the no-changes honesty banner). The no-changes rewrite requires git
    // evidence — in a non-git directory collectMercuryCodeChanges() always
    // returns [] and would falsely claim "no file changes" even when files
    // were created.
    const canVerifyChanges = this.state.mode === 'mercury-code'
      && (this.state.programmingMode === 'execute' || this.state.programmingMode === 'auto')
      && this.state.mercuryCode?.git.branch !== 'no-git';
    const fileChanges = canVerifyChanges
      ? this.collectMercuryCodeChanges()
      : undefined;
    if (content.startsWith('Task complete') && fileChanges && fileChanges.length === 0) {
      content = NO_CHANGES_BANNER + (parts ? ` · ${parts}` : '');
    }

    const msg: ChatMessage = {
      id: `done-${Date.now().toString(36)}`,
      role: 'system',
      content,
      timestamp: Date.now(),
      completionMeta: meta,
      fileChanges,
    };
    this.trimAndSetMessages([...this.state.chatMessages, msg], {
      isThinking: false,
      toolSteps: [],
      planProgress: null,
      lastStepLog: this.state.toolSteps.length > 0 ? [...this.state.toolSteps] : (this.state.lastStepLog ?? null),
      lastStepLogElapsed: elapsedMs,
    });
  }

  /**
   * Live "thinking" preview: the tail of the model's reasoning while it
   * works, so a silent generation phase is never dead air. Pass null to
   * clear (when text starts streaming or the stream ends).
   */
  showThinkingPreview(preview: string | null): void {
    if (this.state.thinkingPreview === preview) return;
    this.update({ thinkingPreview: preview });
  }

  /**
   * Replace the live plan checklist (from the update_plan tool). Validates
   * defensively — malformed model output must never break the TUI.
   */
  setPlanProgress(steps: unknown): void {
    if (!Array.isArray(steps)) return;
    const normalized: PlanStep[] = [];
    for (const raw of steps.slice(0, 20)) {
      const label = typeof (raw as any)?.label === 'string' ? (raw as any).label.trim() : '';
      const status = (raw as any)?.status;
      if (!label || (status !== 'pending' && status !== 'active' && status !== 'done')) continue;
      if (normalized.some((s) => s.label === label)) continue;
      normalized.push({ label: label.slice(0, 120), status });
    }
    if (normalized.length === 0) return;
    // Guard against two "active" steps from sloppy model updates.
    const activeIdx = normalized.findIndex((s) => s.status === 'active');
    normalized.forEach((s, i) => { if (s.status === 'active' && i !== activeIdx) s.status = 'pending'; });
    this.update({ planProgress: normalized });
  }

  private collectMercuryCodeChanges(): FileChangeSummary[] {
    const cwd = this.state.mercuryCode?.cwd;
    if (!cwd) return [];

    const changes = new Map<string, FileChangeSummary>();
    try {
      let output = '';
      try {
        output = execFileSync('git', ['diff', '--numstat', 'HEAD', '--'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      } catch {
        output = execFileSync('git', ['diff', '--numstat', '--'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      }
      for (const line of output.split('\n')) {
        if (!line.trim()) continue;
        const [addedRaw, removedRaw, ...pathParts] = line.split('\t');
        const filePath = pathParts.join('\t');
        if (!filePath) continue;
        changes.set(filePath, {
          path: filePath,
          added: addedRaw === '-' ? null : Number.parseInt(addedRaw, 10) || 0,
          removed: removedRaw === '-' ? null : Number.parseInt(removedRaw, 10) || 0,
        });
      }
    } catch {
      return [];
    }

    try {
      const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      for (const filePath of untracked.split('\n').filter(Boolean)) {
        if (changes.has(filePath)) continue;
        try {
          const data = fs.readFileSync(path.join(cwd, filePath));
          const binary = data.includes(0);
          const text = binary ? '' : data.toString('utf8');
          const added = binary ? null : (text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0));
          changes.set(filePath, { path: filePath, added, removed: binary ? null : 0 });
        } catch {
          changes.set(filePath, { path: filePath, added: null, removed: null });
        }
      }
    } catch {
      // A tracked diff is still useful when untracked-file discovery fails.
    }

    return [...changes.values()].sort((a, b) => a.path.localeCompare(b.path));
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
    this.trimAndSetMessages([...this.state.chatMessages, msg]);
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
    // Cap the live step list: long coding sessions can run hundreds of
    // tool calls; an unbounded array both bloats renders and memory.
    const MAX_LIVE_STEPS = 60;
    const nextSteps = [...this.state.toolSteps, step].slice(-MAX_LIVE_STEPS);
    this.update({
      toolSteps: nextSteps,
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
    let started = false;
    let lastRender = 0;

    this.clearHeartbeat();
    this.setLiveActivity('Streaming response', 'generating answer');

    try {
      for await (const chunk of content) {
        full += chunk;
        const now = Date.now();
        // Throttle streaming re-renders to ~60ms. At 16ms the live Yoga
        // tree was being recomputed on nearly every token, which — combined
        // with markdown re-parsing of the full accumulated buffer each
        // render — caused the visible "vibration"/flicker during generation.
        // 60ms is fast enough to feel live while keeping each frame's layout
        // stable.
        if (!started || now - lastRender >= 60) {
          // Streaming display cap: an unbounded `full` string re-rendered
          // every 60ms makes each frame allocate a fresh multi-MB message
          // object; a long code-mode task can then retain gigabytes. The
          // complete text still reaches the session store via the final
          // channel.send().
          const shown = full.length > CLIChannel.MAX_MESSAGE_CHARS
            ? full.slice(0, CLIChannel.MAX_MESSAGE_CHARS) + `\n\n[…stream display truncated at ${Math.round(CLIChannel.MAX_MESSAGE_CHARS / 1024)}KB — full response in transcript]`
            : full;
          const streamedMessage = { id: msgId, role: 'agent' as const, content: shown, timestamp: now, streaming: true };
          this.update({
            chatMessages: started
              ? this.state.chatMessages.map((message) => message.id === msgId ? streamedMessage : message)
              : [...this.state.chatMessages, streamedMessage],
            isThinking: true,
          });
          started = true;
          lastRender = now;
        }
      }
    } catch (err) {
      logger.warn({ err, partialLen: full.length }, 'CLI stream interrupted, saving partial text');
      this.clearLiveActivity();
      if (full.length > 0) {
        const interruptedMessage = { id: msgId, role: 'agent' as const, content: full + '\n\n⚠ Stream was interrupted. Partial response shown above.', timestamp: Date.now(), streaming: false };
        this.update({
          chatMessages: started
            ? this.state.chatMessages.map((message) => message.id === msgId ? interruptedMessage : message)
            : [...this.state.chatMessages, interruptedMessage],
          isThinking: false,
        });
      } else {
        this.update({
          chatMessages: [...this.state.chatMessages, { id: msgId, role: 'agent', content: '⚠ Stream was interrupted before any response was generated.', timestamp: Date.now(), streaming: false }],
          isThinking: false,
        });
      }
      return full;
    }

    const shownFull = full.length > CLIChannel.MAX_MESSAGE_CHARS
      ? full.slice(0, CLIChannel.MAX_MESSAGE_CHARS) + `\n\n[…response display truncated at ${Math.round(CLIChannel.MAX_MESSAGE_CHARS / 1024)}KB]`
      : full;
    if (full.length > 0) {
      const finalMessage = { id: msgId, role: 'agent' as const, content: shownFull, timestamp: Date.now(), streaming: false };
      this.trimAndSetMessages(
        started
          ? this.state.chatMessages.map((message) => message.id === msgId ? finalMessage : message)
          : [...this.state.chatMessages, finalMessage],
        { isThinking: false, liveActivity: null },
      );
    } else {
      // Zero chunks arrived (e.g. the model returned nothing): render no
      // bubble at all rather than an empty "MERCURY" header.
      this.update({ isThinking: false, liveActivity: null });
    }

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
      this.restoreRawModeAfterMenu();
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
          type: 'choice',
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

  setCurrentSession(session: CurrentSessionInfo | null): void {
    this.update({ currentSession: session });
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

  /**
   * Push a real-time activity phase to the live feedback block. Called by the
   * agent at execution time (provider call, tool start, streaming) — the TUI
   * shows what is happening now, not just post-step results.
   */
  setLiveActivity(phase: string, detail?: string): void {
    const existing = this.state.liveActivity;
    this.update({
      liveActivity: {
        phase,
        detail,
        stepsDone: existing?.stepsDone ?? 0,
        startedAt: existing?.phase === phase && existing?.detail === detail
          ? existing.startedAt
          : Date.now(),
      },
      isThinking: true,
    });
  }

  /** Advance the live step counter (called when an AI SDK step completes). */
  bumpLiveActivitySteps(): void {
    const existing = this.state.liveActivity;
    if (existing) this.update({ liveActivity: { ...existing, stepsDone: existing.stepsDone + 1 } });
  }

  /** Clear the live activity block (task finished or idle). */
  clearLiveActivity(): void {
    if (this.state.liveActivity) this.update({ liveActivity: null });
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

  /** Read-only snapshot of the current TUI state (for cross-module checks). */
  getTuiState(): TuiState {
    return this.state;
  }

  // ─── Mercury Code (`/code`) full-screen mode ─────────────────────────────

  /**
   * Enable or disable SGR mouse tracking. When enabled, the filtered stdin
   * stream forwards parsed mouse events to `handler`; wheel scroll drives
   * transcript scrollback in Mercury Code.
   */
  setMouseEnabled(enabled: boolean, handler?: (ev: MouseEvent) => void): void {
    this.mouseEnabled = enabled;
    this.mouseHandler = enabled ? (handler ?? null) : null;
    try {
      process.stdout.write(mouseTrackingSequences(enabled));
    } catch {
      // Not a TTY or write failed — mouse stays off.
      this.mouseEnabled = false;
      this.mouseHandler = null;
    }
    this.update({ mercuryCode: this.state.mercuryCode ? { ...this.state.mercuryCode, mouse: enabled } : null });
  }

  isMouseEnabled(): boolean {
    return this.mouseEnabled;
  }

  /** Internal: called by the filtered stdin stream on a parsed mouse event. */
  private dispatchMouseEvent(ev: MouseEvent): void {
    if (!this.mouseEnabled) return;
    this.mouseHandler?.(ev);
  }

  /**
   * Enter Mercury Code: full-screen coding TUI bound to `dir`.
   * Switches to plan mode by default (analyze-first). Transcript scrolling
   * stays keyboard-only: terminal mouse reporting survives native process
   * aborts and leaves the user's shell receiving raw mouse escape sequences.
   */
  enterMercuryCode(dir: string, version: string): { ok: boolean; message: string } {
    const target = path.resolve(dir.replace(/^~(?=$|\/)/, process.env.HOME || '~'));
    if (!fs.existsSync(target)) return { ok: false, message: `Directory does not exist: ${target}` };
    if (!fs.statSync(target).isDirectory()) return { ok: false, message: `Not a directory: ${target}` };

    const dirName = path.basename(target) || target;
    this.exitEscArmed = false;
    this.update({
      mode: 'mercury-code',
      mercuryCode: {
        cwd: target,
        dirName,
        git: this.readGitStateQuick(target),
        mouse: false,
        scrollOffset: 0,
        exitConfirm: false,
      },
      projectContext: target,
      version,
      // AUTO is the default Mercury Code flow: plan and build in one pass,
      // confirming with the user only for large/consequential changes.
      programmingMode: 'auto',
      exitEscArmed: false,
    });
    // Reset stale mouse state, then enable mouse reporting for THIS
    // Mercury Code session: wheel scroll drives the transcript scrollback
    // (full-screen frames keep history OUT of terminal scrollback — the
    // wheel is the only natural way back up).
    this.setMouseEnabled(true, (ev) => {
      if (ev.wheel === 'up') this.scrollMercuryCode(3);
      else if (ev.wheel === 'down') this.scrollMercuryCode(-3);
    });
    try {
      process.stdout.write('\x1b[2J\x1b[H');
    } catch { /* ignore */ }
    return { ok: true, message: `Mercury Code active in ${dirName}` };
  }

  exitMercuryCode(): void {
    if (this.state.mercuryCode) {
      this.setMouseEnabled(false);
    }
    this.exitEscArmed = false;
    this.update({
      mode: 'chat',
      mercuryCode: null,
      programmingMode: 'off',
      projectContext: null,
      planProgress: null,
      exitEscArmed: false,
    });
    try {
      process.stdout.write('\x1b[2J\x1b[H');
    } catch { /* ignore */ }
  }

  /** Toggle the exit confirmation inline in Mercury Code. */
  setMercuryCodeExitConfirm(show: boolean): void {
    if (!this.state.mercuryCode) return;
    this.update({ mercuryCode: { ...this.state.mercuryCode, exitConfirm: show } });
  }

  /** Adjust transcript scrollback (distance from bottom, clamped). */
  scrollMercuryCode(deltaTowardTop: number): void {
    const mc = this.state.mercuryCode;
    if (!mc) return;
    const next = Math.max(0, mc.scrollOffset + deltaTowardTop);
    if (next !== mc.scrollOffset) {
      this.update({ mercuryCode: { ...mc, scrollOffset: next } });
    }
  }

  /** Snap transcript to live (bottom). */
  scrollMercuryCodeToLive(): void {
    const mc = this.state.mercuryCode;
    if (!mc || mc.scrollOffset === 0) return;
    this.update({ mercuryCode: { ...mc, scrollOffset: 0 } });
  }

  /** Refresh cached git header state from disk. */
  refreshMercuryCodeGit(): void {
    const mc = this.state.mercuryCode;
    if (!mc) return;
    const git = this.readGitStateQuick(mc.cwd);
    if (
      git.branch !== mc.git.branch ||
      git.ahead !== mc.git.ahead ||
      git.behind !== mc.git.behind ||
      git.dirty !== mc.git.dirty
    ) {
      this.update({ mercuryCode: { ...mc, git } });
    }
  }

  private readGitStateQuick(rootPath: string): MercuryCodeGitState {
    try {
      const branch = execSync('git -C ' + JSON.stringify(rootPath) + ' branch --show-current', { stdio: 'pipe' }).toString().trim() || 'detached';
      const out = execSync('git -C ' + JSON.stringify(rootPath) + ' status --porcelain=v1 --branch', { stdio: 'pipe' }).toString();
      const lines = out.split('\n');
      const header = lines[0] || '';
      const ahead = parseInt(header.match(/ahead (\d+)/)?.[1] ?? '0', 10);
      const behind = parseInt(header.match(/behind (\d+)/)?.[1] ?? '0', 10);
      const dirty = lines.slice(1).filter((l) => l.trim().length > 0).length;
      return { branch, ahead, behind, dirty };
    } catch {
      return { branch: 'no-git', ahead: 0, behind: 0, dirty: 0 };
    }
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

      // 6. Mercury Code header (branch / ahead / behind / dirty count).
      // Async git read: execSync here blocks the event loop while the TUI
      // is rendering (and mid-task), which stalls streaming + input.
      if (this.state.mode === 'mercury-code' && this.state.mercuryCode) {
        const mc = this.state.mercuryCode;
        const asyncState = await this.readGitStateAsync(mc.cwd);
        const fresh = {
          branch: asyncState.branch,
          ahead: asyncState.ahead,
          behind: asyncState.behind,
          dirty: asyncState.files.length,
        };
        if (
          fresh.branch !== mc.git.branch ||
          fresh.ahead !== mc.git.ahead ||
          fresh.behind !== mc.git.behind ||
          fresh.dirty !== mc.git.dirty
        ) {
          patch.mercuryCode = { ...mc, git: fresh };
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

  scrollWorkspaceCode(delta: number, viewportLines = 1): void {
    const ws = this.state.workspace;
    if (!ws?.active || !ws.openedFilePreview.length) return;
    const maxOffset = Math.max(0, ws.openedFilePreview.length - Math.max(1, viewportLines));
    const next = Math.max(0, Math.min(maxOffset, ws.codeScrollOffset + delta));
    if (next !== ws.codeScrollOffset) {
      this.update({ workspace: { ...ws, codeScrollOffset: next } });
    }
  }

  private scrollWorkspaceCodeToBoundary(boundary: 'top' | 'bottom', viewportLines = 1): void {
    const ws = this.state.workspace;
    if (!ws?.active || !ws.openedFilePreview.length) return;
    const codeScrollOffset = boundary === 'top'
      ? 0
      : Math.max(0, ws.openedFilePreview.length - Math.max(1, viewportLines));
    this.update({ workspace: { ...ws, codeScrollOffset } });
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
    const next = Math.max(0, ws.chatScrollOffset + delta);
    if (next !== ws.chatScrollOffset) {
      this.update({ workspace: { ...ws, chatScrollOffset: next } });
    }
  }

  private setWorkspaceChatBoundary(boundary: 'top' | 'bottom'): void {
    const ws = this.state.workspace;
    if (!ws?.active) return;
    this.update({
      workspace: {
        ...ws,
        chatScrollOffset: boundary === 'top' ? Number.MAX_SAFE_INTEGER : 0,
      },
    });
  }

  private setWorkspaceChatDistance(distance: number): void {
    const ws = this.state.workspace;
    if (!ws?.active) return;
    const chatScrollOffset = Math.max(0, distance);
    if (chatScrollOffset !== ws.chatScrollOffset) {
      this.update({ workspace: { ...ws, chatScrollOffset } });
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
      return raw.replace(/\r\n?/g, '\n').split('\n').slice(0, 500);
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
    this.trimAndSetMessages([...this.state.chatMessages, userMsg]);
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
