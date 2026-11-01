import { BaseChannel } from './base.js';
import { normalizePlan, PlanStore } from '../core/plan.js';
import type { ChannelMessage, ChannelAttachment } from '../types/channel.js';
import { logger } from '../utils/logger.js';
import { randomUUID } from 'node:crypto';
import { userFacingAiError } from '../utils/redact.js';

type CloudEventHandler = (event: ChatEvent) => boolean;

type PendingInteractionKind = 'permission' | 'continue' | 'mode' | 'choice';

interface PendingInteraction {
  kind: PendingInteractionKind;
  targetId?: string;
  /** The session it was asked in, and the event that asked it (replayed when a screen opens that session). */
  sessionId?: string;
  event?: ChatEvent;
  allowedValues: Set<string>;
  resolve: (value: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ChatEvent {
  type: 'activity' | 'thinking' | 'reasoning' | 'plan' | 'artifacts' | 'provider' | 'heartbeat' | 'step_start' | 'step_done' | 'text_delta' | 'text_done' | 'permission_request' | 'permission_continue' | 'permission_mode' | 'permission_resolved' | 'choice_prompt' | 'choice_resolved' | 'loop_warning' | 'error' | 'bot_activity' | 'status' | 'session_switched';
  data?: Record<string, unknown>;
}

class SSEClient {
  controller: ReadableStreamDefaultController;
  id: string;
  sessionId?: string;

  constructor(controller: ReadableStreamDefaultController, id: string, sessionId?: string) {
    this.controller = controller;
    this.id = id;
    this.sessionId = sessionId;
  }

  send(event: ChatEvent): void {
    try {
      const data = `event: ${event.type}\ndata: ${JSON.stringify(event.data ?? {})}\n\n`;
      this.controller.enqueue(new TextEncoder().encode(data));
    } catch {
      // client disconnected
    }
  }

  close(): void {
    try {
      this.controller.close();
    } catch {}
  }
}

export class WebChannel extends BaseChannel {
  readonly type = 'web' as const;
  private sseClients: Map<string, SSEClient> = new Map();
  /** Screens that want a summary of every session (started, needs you, done): notifications. */
  private activityClients: Map<string, SSEClient> = new Map();
  private turnStarts = new Map<string, number>();
  /** Session titles for activity events (set by the web server). */
  private titleOf: ((sessionId: string) => string | undefined) | null = null;
  private pendingInteractions = new Map<string, PendingInteraction>();
  private agentName: string;
  private stepCounter: Map<string, number> = new Map();
  private cloudEventHandlers: Map<string, CloudEventHandler> = new Map();
  private cloudRequestSessions = new Map<string, string>();
  private permissionModes = new Map<string, 'allow-all' | 'ask-me'>();
  private bypassPermissions = false;
  private restrictUser = false;

  constructor(agentName: string) {
    super();
    this.agentName = agentName;
  }

  async start(): Promise<void> {
    this.ready = true;
    logger.info('Web channel started');
  }

  async stop(): Promise<void> {
    this.ready = false;
    for (const [, client] of this.sseClients) {
      client.close();
    }
    this.sseClients.clear();
    for (const [id, interaction] of this.pendingInteractions) {
      clearTimeout(interaction.timer);
      interaction.resolve(interaction.kind === 'mode' ? 'ask-me' : interaction.kind === 'choice' ? '' : 'no');
      this.pendingInteractions.delete(id);
    }
  }

  addSSEClient(controller: ReadableStreamDefaultController, sessionId?: string): string {
    const id = `sse_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const client = new SSEClient(controller, id, sessionId);
    this.sseClients.set(id, client);
    return id;
  }

  removeSSEClient(id: string): void {
    this.sseClients.delete(id);
  }

  addActivityClient(controller: ReadableStreamDefaultController): string {
    const id = `act_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.activityClients.set(id, new SSEClient(controller, id));
    return id;
  }

  removeActivityClient(id: string): void {
    this.activityClients.delete(id);
  }

  setSessionTitleLookup(fn: (sessionId: string) => string | undefined): void {
    this.titleOf = fn;
  }

  /** Prompts still waiting in a session, as the events that asked them. */
  pendingFor(sessionId: string): ChatEvent[] {
    return [...this.pendingInteractions.values()].filter((i) => i.sessionId === sessionId && i.event).map((i) => i.event!);
  }

  /**
   * One line per session event that a person would want to hear about:
   * a turn started, Mercury needs an answer, a turn finished or failed.
   * Cloud-relayed sessions belong to their remote screen, so they're left out.
   */
  private emitActivity(event: ChatEvent, targetId: string | undefined): void {
    if (!targetId) return;
    if (this.cloudEventHandlers.has(targetId)) return;
    const d = event.data ?? {};
    const now = Date.now();
    let data: Record<string, unknown> | null = null;
    switch (event.type) {
      case 'thinking':
        if (!this.turnStarts.has(targetId)) { this.turnStarts.set(targetId, now); data = { kind: 'started' }; }
        break;
      case 'permission_request':
      case 'permission_continue':
      case 'choice_prompt':
        data = { kind: 'needs_you', id: d.id, prompt: String(d.prompt ?? d.question ?? '').slice(0, 300) };
        break;
      case 'permission_resolved':
      case 'choice_resolved':
        data = { kind: 'resolved', id: d.id };
        break;
      case 'text_done': {
        const started = this.turnStarts.get(targetId);
        this.turnStarts.delete(targetId);
        const text = String(d.fullText ?? '');
        const ms = typeof d.elapsedMs === 'number' ? d.elapsedMs : started ? now - started : 0;
        data = { kind: /^⏹/.test(text.trim()) ? 'stopped' : 'done', ms, preview: text.replace(/\s+/g, ' ').trim().slice(0, 200) };
        break;
      }
      case 'error': {
        const started = this.turnStarts.get(targetId);
        this.turnStarts.delete(targetId);
        data = { kind: 'failed', ms: started ? now - started : 0, message: String(d.message ?? '').slice(0, 200) };
        break;
      }
    }
    if (!data || this.activityClients.size === 0) return;
    let title: string | undefined;
    try { title = this.titleOf?.(targetId); } catch { title = undefined; }
    const out: ChatEvent = { type: 'activity', data: { ...data, sessionId: targetId, title, at: now } };
    for (const [, client] of this.activityClients) client.send(out);
  }

  /**
   * Real-time bot activity feed: what each Mercury bot is doing RIGHT NOW
   * (step, tool calls, turn lifecycle). Broadcast to every connected web
   * session — the dashboard / third-party backends consume these for live
   * bot views. Bot turns never carry text deltas, only activity labels.
   */
  /** Runtime status for every attached screen's bottom bar (no target: all clients). */
  broadcastStatus(status: Record<string, unknown>): void {
    this.broadcast({ type: 'status', data: { ...status } });
  }

  /**
   * The screen listening on `targetId` was re-bound to another session
   * (/new, /session <ref>, a deleted current session). Without this the
   * attached terminal kept streaming the old id: replies to the new session
   * never reached it, and it showed "Thinking" forever.
   */
  sendSessionSwitched(targetId: string, session: { id: string; shortId: string; alias: string; title: string }): void {
    this.broadcast({ type: 'session_switched', data: { targetId, id: session.id, shortId: session.shortId, alias: session.alias, title: session.title } });
  }

  broadcastBotActivity(ev: { botId: string; jobId: string; kind: string; label: string; detail?: string; stepIndex: number; elapsedMs: number; status?: string }): void {
    this.broadcast({ type: 'bot_activity', data: { ...ev } });
  }

  private broadcast(event: ChatEvent): boolean {
    let delivered = true;
    const targetId = typeof event.data?.targetId === 'string' ? event.data.targetId : undefined;
    if (targetId) {
      const cloudHandler = this.cloudEventHandlers.get(targetId);
      if (cloudHandler) {
        delivered = cloudHandler(event);
        if (delivered && (event.type === 'text_done' || event.type === 'error')) {
          this.cloudEventHandlers.delete(targetId);
          this.cloudRequestSessions.delete(targetId);
        }
      }
    }

    for (const [, client] of this.sseClients) {
      if (targetId && client.sessionId !== targetId) continue;
      client.send(event);
    }
    this.emitActivity(event, targetId);
    return delivered;
  }

  resolveApproval(id: string, action: string, targetId?: string): boolean {
    return this.resolveInteraction(id, action, targetId, ['permission', 'continue', 'mode']);
  }

  resolveChoice(id: string, value: string, targetId?: string): boolean {
    return this.resolveInteraction(id, value, targetId, ['choice']);
  }

  cancelInteraction(id: string, targetId?: string): boolean {
    const interaction = this.pendingInteractions.get(id);
    if (!interaction || (interaction.targetId && interaction.targetId !== targetId)) return false;
    this.pendingInteractions.delete(id);
    clearTimeout(interaction.timer);
    interaction.resolve(interaction.kind === 'choice' ? '' : interaction.kind === 'mode' ? 'ask-me' : 'no');
    return true;
  }

  private resolveInteraction(id: string, value: string, targetId: string | undefined, kinds: PendingInteractionKind[]): boolean {
    const interaction = this.pendingInteractions.get(id);
    if (!interaction || !kinds.includes(interaction.kind) || !interaction.allowedValues.has(value)) return false;
    if (interaction.targetId && interaction.targetId !== targetId) return false;
    this.pendingInteractions.delete(id);
    clearTimeout(interaction.timer);
    interaction.resolve(value);
    // Every screen (and the notification feed) learns it was answered.
    this.broadcast({ type: interaction.kind === 'choice' ? 'choice_resolved' : 'permission_resolved', data: { id, status: 'answered', targetId: interaction.sessionId } });
    return true;
  }

  private waitForInteraction(
    id: string,
    kind: PendingInteractionKind,
    values: string[],
    targetId: string | undefined,
    fallback: string,
    event?: ChatEvent,
  ): Promise<string> {
    const boundTargetId = targetId && this.cloudEventHandlers.has(targetId) ? targetId : undefined;
    // The same two minutes whether or not the session is on screen: the agent waits while
    // a prompt is open, so a longer wait would hold up every other conversation.
    const waitMs = 120_000;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const interaction = this.pendingInteractions.get(id);
        if (!interaction) return;
        this.pendingInteractions.delete(id);
        this.broadcast({
          type: interaction.kind === 'choice' ? 'choice_resolved' : 'permission_resolved',
          data: { id, status: 'expired', targetId: interaction.sessionId ?? interaction.targetId },
        });
        resolve(fallback);
      }, waitMs);
      this.pendingInteractions.set(id, {
        kind,
        targetId: boundTargetId,
        sessionId: targetId,
        event,
        allowedValues: new Set(values),
        resolve,
        timer,
      });
    });
  }

  private isPermissionBypassed(targetId?: string): boolean {
    if (this.bypassPermissions) return true;
    const sessionId = targetId ? this.cloudRequestSessions.get(targetId) : undefined;
    return !!sessionId && this.permissionModes.get(sessionId) === 'allow-all';
  }

  private hasInteractiveTarget(targetId?: string): boolean {
    if (!targetId) return this.sseClients.size > 0;
    if (this.cloudEventHandlers.has(targetId)) return true;
    // A screen listening for notifications can answer once the owner opens the session.
    return this.isWatched(targetId) || this.activityClients.size > 0;
  }

  private isWatched(targetId: string): boolean {
    return [...this.sseClients.values()].some((client) => client.sessionId === targetId);
  }

  async send(content: string, targetId?: string, elapsedMs?: number): Promise<void> {
    const delivered = this.broadcast({
      type: 'text_done',
      data: { fullText: content, elapsedMs, targetId },
    });
    if (!delivered) throw new Error('Cloud WebSocket could not accept the terminal response');
  }

  async sendFile(_filePath: string, _targetId?: string): Promise<void> {
    // Not needed for web — files are referenced in text
  }

  async stream(content: AsyncIterable<string>, targetId?: string): Promise<string> {
    let fullText = '';
    for await (const chunk of content) {
      fullText += chunk;
      if (!chunk) continue;
      this.broadcast({
        type: 'text_delta',
        data: { text: chunk, targetId },
      });
    }
    return fullText;
  }

  async typing(_targetId?: string): Promise<void> {
    this.broadcast({ type: 'thinking', data: { targetId: _targetId } });
  }

  async askPermission(prompt: string, _targetId?: string, options?: { alwaysAsk?: boolean }): Promise<string> {
    if (!options?.alwaysAsk && this.isPermissionBypassed(_targetId)) return 'yes';
    if (!this.hasInteractiveTarget(_targetId)) return 'no';
    const id = `perm_${randomUUID()}`;
    const event: ChatEvent = {
      type: 'permission_request',
      data: { id, prompt, options: ['yes', 'always', 'no'], targetId: _targetId },
    };
    const pending = this.waitForInteraction(id, 'permission', ['yes', 'always', 'no'], _targetId, 'no', event);
    this.broadcast(event);
    return pending;
  }

  async askToContinue(question: string, _targetId?: string): Promise<boolean> {
    if (!this.hasInteractiveTarget(_targetId)) return false;
    const id = `loop_${randomUUID()}`;
    const event: ChatEvent = {
      type: 'permission_continue',
      data: { id, question, options: ['yes', 'no'], targetId: _targetId },
    };
    const pending = this.waitForInteraction(id, 'continue', ['yes', 'no'], _targetId, 'no', event);
    this.broadcast(event);
    return pending.then((value) => value === 'yes');
  }

  askPermissionMode(): Promise<'allow-all' | 'ask-me'> {
    if (this.bypassPermissions) return Promise.resolve('allow-all');
    const id = `mode_${randomUUID()}`;
    this.broadcast({
      type: 'permission_mode',
      data: { id, options: ['ask-me', 'allow-all'] },
    });

    return this.waitForInteraction(id, 'mode', ['ask-me', 'allow-all'], undefined, 'ask-me') as Promise<'allow-all' | 'ask-me'>;
  }

  async presentChoicePrompt(question: string, options: Array<{ value: string; label: string }>, targetId?: string): Promise<string> {
    if (!this.hasInteractiveTarget(targetId)) return '';
    const id = `choice_${randomUUID()}`;
    const event: ChatEvent = {
      type: 'choice_prompt',
      data: { id, question, options, targetId },
    };
    const pending = this.waitForInteraction(id, 'choice', options.map((option) => option.value), targetId, '', event);
    this.broadcast(event);
    return pending;
  }

  sendToolFeedback(toolName: string, args: Record<string, unknown>, targetId?: string): void {
    const channelId = targetId || 'default';
    const step = (this.stepCounter.get(channelId) || 0) + 1;
    this.stepCounter.set(channelId, step);

    const label = Object.keys(args).length > 0
      ? `${toolName}(${Object.entries(args).slice(0, 3).map(([k, v]) => `${k}=${typeof v === 'string' && v.length > 50 ? v.slice(0, 50) + '...' : v}`).join(', ')})`
      : toolName;

    this.broadcast({
      type: 'step_start',
      data: { step, tool: toolName, label: String(label), targetId },
    });
  }

  /**
   * The model's reasoning as it streams, for clients that show the thought
   * process live. Deltas are batched (≤ 8 events/s per target); null closes
   * the reasoning block when the answer starts.
   */
  private reasoningBuf = new Map<string, { text: string; timer: ReturnType<typeof setTimeout> | null }>();

  sendReasoning(delta: string | null, targetId?: string): void {
    const key = targetId || 'default';
    const entry = this.reasoningBuf.get(key) ?? { text: '', timer: null };
    const flush = () => {
      const e = this.reasoningBuf.get(key);
      if (!e) return;
      if (e.timer) clearTimeout(e.timer);
      e.timer = null;
      if (e.text) this.broadcast({ type: 'reasoning', data: { text: e.text, targetId } });
      e.text = '';
    };
    if (delta === null) {
      this.reasoningBuf.set(key, entry);
      flush();
      this.broadcast({ type: 'reasoning', data: { done: true, targetId } });
      this.reasoningBuf.delete(key);
      return;
    }
    entry.text += delta;
    this.reasoningBuf.set(key, entry);
    if (!entry.timer) entry.timer = setTimeout(flush, 125);
  }

  /** The latest plan per conversation (see core/plan.ts). */
  plans = new PlanStore();

  /** The model updated its plan checklist: keep it with the conversation and show it live. */
  sendPlan(steps: unknown, targetId?: string): void {
    const normalized = normalizePlan(steps);
    if (normalized.length === 0) return;
    const plan = targetId ? this.plans.set(targetId, normalized) : { steps: normalized, updatedAt: Date.now() };
    this.broadcast({ type: 'plan', data: { steps: plan.steps, updatedAt: plan.updatedAt, targetId } });
  }

  /** Artifacts this turn made (images, PDFs, reports…), for the conversation's live view. */
  sendArtifacts(items: unknown[], targetId?: string): void {
    if (!items.length) return;
    this.broadcast({ type: 'artifacts', data: { items, targetId } });
  }

  sendStepDone(toolName: string, result: unknown, targetId?: string): void {
    const summary = typeof result === 'string'
      ? result.slice(0, 200)
      : String(result).slice(0, 200);
    this.broadcast({
      type: 'step_done',
      data: { tool: toolName, summary, targetId },
    });
  }

  sendProviderInfo(name: string, model: string, targetId?: string): void {
    this.broadcast({
      type: 'provider',
      data: { name, model, targetId },
    });
  }

  sendHeartbeat(message: string, targetId?: string): void {
    this.broadcast({
      type: 'heartbeat',
      data: { message, targetId },
    });
  }

  sendLoopWarning(message: string, targetId?: string): void {
    this.broadcast({
      type: 'loop_warning',
      data: { message, targetId },
    });
  }

  sendError(message: string, targetId?: string): boolean {
    return this.broadcast({
      type: 'error',
      data: { message: userFacingAiError(message), targetId },
    });
  }

  resetStepCounter(targetId?: string): void {
    const channelId = targetId || 'default';
    this.stepCounter.delete(channelId);
  }

  emitMessage(content: string): void {
    this.emitMessageInThread(content, 'web:default');
  }

  /**
   * `attachments` are files already on disk (see `web/api/uploads.ts`); them being
   * present is what lets the runtime hand a photo to a vision model instead of a path.
   */
  emitMessageInThread(content: string, threadId: string, sessionId?: string, requestId?: string, externalConversationId?: string, messageId?: string, attachments?: ChannelAttachment[], scope?: { programming?: string; cwd?: string }): void {
    if (this.restrictUser) {
      throw new Error('Web user is restricted. Disable restrict mode to continue.');
    }
    const msg: ChannelMessage = {
      id: `web_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      channelId: threadId,
      channelType: 'web',
      senderId: 'web_user',
      senderName: 'You',
      content,
      timestamp: Date.now(),
      sessionId,
      metadata: {
        ...(sessionId ? { sessionId } : {}),
        ...(requestId ? { requestId } : {}),
        ...(externalConversationId ? { externalConversationId } : {}),
        ...(messageId ? { canonicalMessageId: messageId } : {}),
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
        // Session-scoped coding (Mercury Desktop's Code surface): the mode and
        // folder apply to this turn only; the agent restores the rest after.
        ...(scope?.programming ? { programming: scope.programming } : {}),
        ...(scope?.cwd ? { programmingCwd: scope.cwd } : {}),
      },
    };
    this.emit(msg);
  }

  emitCloudMessage(content: string, requestId: string, sessionId: string, externalConversationId: string, messageId: string | undefined, onEvent: CloudEventHandler): void {
    this.cloudEventHandlers.set(requestId, onEvent);
    this.cloudRequestSessions.set(requestId, sessionId);
    this.emitMessageInThread(content, requestId, sessionId, requestId, externalConversationId, messageId);
  }

  hasCloudEventHandler(requestId: string): boolean {
    return this.cloudEventHandlers.has(requestId);
  }

  setBypassPermissions(enabled: boolean): void {
    this.bypassPermissions = enabled;
  }

  setSessionPermissionMode(sessionId: string, mode: 'allow-all' | 'ask-me'): void {
    this.permissionModes.set(sessionId, mode);
  }

  setRestrictUser(enabled: boolean): void {
    this.restrictUser = enabled;
  }

  getSettings(): { bypassPermissions: boolean; restrictUser: boolean } {
    return { bypassPermissions: this.bypassPermissions, restrictUser: this.restrictUser };
  }
}
