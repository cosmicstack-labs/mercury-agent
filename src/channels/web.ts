import { BaseChannel } from './base.js';
import { normalizePlan, PlanStore } from '../core/plan.js';
import type { ChannelMessage, ChannelAttachment } from '../types/channel.js';
import { logger } from '../utils/logger.js';
import { randomUUID } from 'node:crypto';
import { userFacingAiError } from '../utils/redact.js';
import { stepFailure, type ResearchSnapshot } from '../core/research-run.js';
import { formatToolStep } from '../utils/tool-label.js';

type CloudEventHandler = (event: ChatEvent) => boolean;

function safeJson(value: unknown): string {
  try { return JSON.stringify(value) ?? ''; } catch { return String(value); }
}

/**
 * What a media tool is making, so a screen can hold a placeholder of the
 * right shape while it works (ADR-042): kind, aspect, how many, the prompt.
 */
function mediaShape(toolName: string, args: Record<string, unknown>): { media?: Record<string, unknown> } {
  const kind = toolName === 'generate_image' ? 'image' : toolName === 'generate_speech' ? 'speech' : toolName === 'generate_video' ? 'video' : toolName === 'generate_music' ? 'music' : null;
  if (!kind) return {};
  const prompt = typeof args.prompt === 'string' ? args.prompt : typeof args.text === 'string' ? args.text : '';
  return {
    media: {
      kind,
      ...(typeof args.aspect === 'string' ? { aspect: args.aspect } : {}),
      ...(typeof args.count === 'number' ? { count: Math.min(Math.max(args.count, 1), 4) } : {}),
      ...(prompt ? { prompt: prompt.slice(0, 200) } : {}),
    },
  };
}

/** "Read src/x.ts", "Run npm test": the tool's label without its icon. */
function toolTitle(toolName: string, args: Record<string, unknown>): string {
  return formatToolStep(toolName, args).replace(/^[^\p{L}\p{N}]+/u, '').trim() || toolName;
}

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
  type: 'activity' | 'thinking' | 'reasoning' | 'plan' | 'artifacts' | 'provider' | 'heartbeat' | 'step_start' | 'step_done' | 'text_delta' | 'text_done' | 'progress' | 'phase' | 'media_ready' | 'media_pending' | 'permission_request' | 'permission_continue' | 'permission_mode' | 'permission_resolved' | 'choice_prompt' | 'choice_resolved' | 'loop_warning' | 'error' | 'bot_activity' | 'status' | 'session_switched' | 'queued' | 'queue_dropped' | 'research' | 'research_plan' | 'research_plan_resolved' | 'notice' | 'owner_approval';
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
    for (const [id, plan] of this.researchPlans) {
      clearTimeout(plan.timer);
      plan.resolve({ action: 'cancel', questions: plan.questions });
      this.researchPlans.delete(id);
    }
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

  addActivityClient(controller: ReadableStreamDefaultController, thisComputer = false): string {
    const id = `act_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.activityClients.set(id, new SSEClient(controller, id));
    if (thisComputer) this.localActivityClients.add(id);
    return id;
  }

  /** Activity screens on this computer: the only ones that get security questions (they can answer them). */
  private localActivityClients = new Set<string>();

  /** A security question for the owner (owner-approvals), to Mercury Desktop on this computer only. */
  sendOwnerApproval(a: { id: string; code: string; kind: string; title: string; detail?: string; who: string; ip?: string; expiresAt: number; status: string }, change: 'new' | 'decided'): void {
    const out: ChatEvent = { type: 'owner_approval', data: { change, id: a.id, code: a.code, kind: a.kind, title: a.title, detail: a.detail, who: a.who, ip: a.ip, expiresAt: a.expiresAt, status: a.status } };
    for (const id of this.localActivityClients) this.activityClients.get(id)?.send(out);
  }

  removeActivityClient(id: string): void {
    this.activityClients.delete(id);
    this.localActivityClients.delete(id);
  }

  setSessionTitleLookup(fn: (sessionId: string) => string | undefined): void {
    this.titleOf = fn;
  }

  /** Prompts still waiting in a session, as the events that asked them. */
  pendingFor(sessionId: string): ChatEvent[] {
    const prompts = [...this.pendingInteractions.values()].filter((i) => i.sessionId === sessionId && i.event).map((i) => i.event!);
    const plans = [...this.researchPlans.values()].filter((p) => p.sessionId === sessionId).map((p) => p.event);
    return [...prompts, ...plans];
  }

  /** Research plans waiting for the owner's Start (see askResearchPlan). */
  private researchPlans = new Map<string, { sessionId?: string; event: ChatEvent; resolve: (a: { action: 'start' | 'cancel'; questions: string[] }) => void; timer: ReturnType<typeof setTimeout>; questions: string[] }>();

  /**
   * Show a research plan the owner can edit, and wait for Start or Cancel.
   * Nobody answering in `timeoutMs` starts the plan as proposed: they asked
   * for the research, the plan was only a chance to steer it.
   */
  askResearchPlan(runId: string, topic: string, questions: string[], targetId: string | undefined, timeoutMs: number): Promise<{ action: 'start' | 'cancel'; questions: string[]; timedOut?: boolean }> {
    const id = `rplan_${runId}`;
    const event: ChatEvent = { type: 'research_plan', data: { id, runId, topic, questions, targetId, expiresAt: Date.now() + timeoutMs } };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!this.researchPlans.delete(id)) return;
        this.broadcast({ type: 'research_plan_resolved', data: { id, action: 'start', targetId } });
        resolve({ action: 'start', questions, timedOut: true });
      }, timeoutMs);
      timer.unref?.();
      this.researchPlans.set(id, { sessionId: targetId, event, resolve, timer, questions });
      this.broadcast(event);
    });
  }

  /** The owner's answer to a research plan. False when it's gone (answered, timed out). */
  answerResearchPlan(id: string, action: 'start' | 'cancel', questions?: string[]): boolean {
    const p = this.researchPlans.get(id);
    if (!p) return false;
    this.researchPlans.delete(id);
    clearTimeout(p.timer);
    const kept = (questions ?? p.questions).map((q) => String(q).trim()).filter(Boolean).slice(0, 8);
    p.resolve({ action, questions: kept.length ? kept : p.questions });
    this.broadcast({ type: 'research_plan_resolved', data: { id, action, targetId: p.sessionId } });
    return true;
  }

  /** A research run as it stands: phase, counts, sources and how each went. */
  sendResearch(snapshot: ResearchSnapshot, targetId?: string): void {
    this.broadcast({ type: 'research', data: { ...snapshot, targetId } });
  }

  /** Research switched on (or off) for a chat's next message. */
  sendResearchArmed(armed: boolean, targetId: string | undefined, info: { topic?: string | null; planFirst?: boolean } = {}): void {
    this.broadcast({ type: 'research', data: { state: armed ? 'armed' : 'off', topic: info.topic ?? null, planFirst: !!info.planFirst, targetId } });
  }

  /**
   * A line about the turn that is not its answer: "the provider stalled,
   * retrying". Sent as text_done it ended the turn on screen while the work
   * went on.
   */
  sendNotice(message: string, targetId?: string, level: 'info' | 'warning' = 'info'): void {
    this.broadcast({ type: 'notice', data: { message, level, targetId } });
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
      case 'research_plan':
        data = { kind: 'needs_you', id: d.id, prompt: `Research plan ready: ${String(d.topic ?? '').slice(0, 200)}` };
        break;
      case 'research':
        // A finished (or cut-short) research run: the notification can say what came of it.
        if (d.state === 'done' || d.state === 'partial' || d.state === 'stopped' || d.state === 'failed') {
          data = { kind: 'research', state: d.state, topic: String(d.topic ?? '').slice(0, 200), read: d.read, cited: d.cited, failed: d.failed, report: (d.report as { name?: string } | undefined)?.name };
        }
        break;
      case 'permission_resolved':
      case 'choice_resolved':
      case 'research_plan_resolved':
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
  /**
   * This chat's message is waiting: every slot Mercury runs chats in is
   * taken (ADR-037), and another one (`busySessionId`, doing `busyWith`) is
   * ahead of it. Sent when it
   * joins the line and whenever the line moves; the turn's own events follow
   * when it starts.
   */
  sendQueued(targetId: string, data: { position: number; busyWith?: string; busySessionId?: string }): void {
    this.broadcast({ type: 'queued', data: { targetId, ...data } });
  }

  /** Waiting messages of this chat were dropped (a stop): they will not run (ADR-038). */
  sendQueueDropped(targetId: string, data: { dropped: number; reason: string }): void {
    this.broadcast({ type: 'queue_dropped', data: { targetId, ...data } });
  }

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

  async send(content: string, targetId?: string, elapsedMs?: number, usage?: Record<string, unknown>): Promise<void> {
    if (targetId) this.liveText.delete(targetId);
    const delivered = this.broadcast({
      type: 'text_done',
      data: { fullText: content, elapsedMs, targetId, ...(usage ? { usage } : {}) },
    });
    if (!delivered) throw new Error('Cloud WebSocket could not accept the terminal response');
  }

  async sendFile(_filePath: string, _targetId?: string): Promise<void> {
    // Not needed for web — files are referenced in text
  }

  /** The reply text streamed so far per chat, for a screen that comes back mid-turn. */
  private liveText = new Map<string, string>();

  clearLiveText(targetId: string): void {
    this.liveText.delete(targetId);
  }

  /** What this chat's running reply has written so far ('' when none). */
  liveTextFor(targetId: string): string {
    return this.liveText.get(targetId) ?? '';
  }

  async stream(content: AsyncIterable<string>, targetId?: string): Promise<string> {
    let fullText = '';
    // A later round of the same turn writes on after the earlier text.
    const before = targetId ? this.liveText.get(targetId) ?? '' : '';
    for await (const chunk of content) {
      fullText += chunk;
      if (!chunk) continue;
      if (targetId) this.liveText.set(targetId, before + fullText);
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
   * A tool started running, sent the moment it starts (not when the step
   * ends), so a screen shows what is running during a long command. `id` is
   * the tool call id: the matching tool_done carries it.
   */
  sendToolStarted(id: string, toolName: string, args: Record<string, unknown>, targetId?: string): void {
    const channelId = targetId || 'default';
    const step = (this.stepCounter.get(channelId) || 0) + 1;
    this.stepCounter.set(channelId, step);
    const label = Object.keys(args).length > 0
      ? `${toolName}(${Object.entries(args).slice(0, 3).map(([k, v]) => `${k}=${typeof v === 'string' && v.length > 50 ? v.slice(0, 50) + '...' : v}`).join(', ')})`
      : toolName;
    this.broadcast({
      type: 'step_start',
      data: { id, step, tool: toolName, label: String(label), title: toolTitle(toolName, args), ...mediaShape(toolName, args), targetId },
    });
  }

  /** The tool with this call id finished (or failed), with how long it ran. */
  sendToolFinished(id: string, toolName: string, result: unknown, failed: boolean, durationMs: number | undefined, targetId?: string): void {
    const text = result == null ? '' : typeof result === 'string' ? result : safeJson(result);
    const summary = text.slice(0, 200);
    // "HTTP 403 …" and "timed out" come back as text, not errors.
    const reason = failed ? (stepFailure(toolName, text) ?? (summary.split('\n')[0] || 'failed')) : stepFailure(toolName, text);
    this.broadcast({
      type: 'step_done',
      data: {
        id, tool: toolName, summary, failed: reason !== null,
        ...(reason ? { reason } : {}),
        ...(typeof durationMs === 'number' && Number.isFinite(durationMs) ? { durationMs: Math.max(0, Math.round(durationMs)) } : {}),
        targetId,
      },
    });
  }

  /** What the turn is doing between tools ("Calling anthropic", "Retrying after a stall"…). */
  sendPhase(phase: string, detail: string | undefined, targetId?: string): void {
    this.broadcast({ type: 'phase', data: { phase, ...(detail ? { detail } : {}), targetId } });
  }

  /**
   * A note while the turn keeps working ("Checking my work…"). Not a reply:
   * a screen shows it inside the running turn instead of ending the turn.
   */
  sendProgressNote(text: string, targetId?: string): void {
    this.broadcast({ type: 'progress', data: { text, targetId } });
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

  /**
   * A video or song made in the background is ready (or failed), after its
   * turn ended: a message of its own, so a turn running in the chat now is
   * left alone.
   */
  sendMediaReady(text: string, artifacts: unknown[], targetId?: string, jobId?: string): void {
    this.broadcast({ type: 'media_ready', data: { text, artifacts, targetId, ...(jobId ? { jobId } : {}) } });
  }

  /** A video or song started in the background: a screen holds a placeholder for it until media_ready. */
  sendMediaPending(job: { id: string; kind: string; prompt: string; createdAt: number; aspect?: string }, targetId: string): void {
    this.broadcast({ type: 'media_pending', data: { jobId: job.id, kind: job.kind, prompt: job.prompt.slice(0, 200), startedAt: job.createdAt, ...(job.aspect ? { aspect: job.aspect } : {}), targetId } });
  }

  /** Artifacts this turn made (images, PDFs, reports…), for the conversation's live view. */
  sendArtifacts(items: unknown[], targetId?: string): void {
    if (!items.length) return;
    this.broadcast({ type: 'artifacts', data: { items, targetId } });
  }

  sendStepDone(toolName: string, result: unknown, targetId?: string): void {
    const text = typeof result === 'string' ? result : String(result);
    const summary = text.slice(0, 200);
    // Whether it failed, decided here: "HTTP 403 …" and "timed out" are text, not errors.
    const reason = stepFailure(toolName, text);
    this.broadcast({
      type: 'step_done',
      data: { tool: toolName, summary, failed: reason !== null, ...(reason ? { reason } : {}), targetId },
    });
  }

  sendProviderInfo(name: string, model: string, targetId?: string): void {
    this.broadcast({
      type: 'provider',
      // `provider` too: screens read the same field as on `connected`.
      data: { name, provider: name, model, targetId },
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
  emitMessageInThread(content: string, threadId: string, sessionId?: string, requestId?: string, externalConversationId?: string, messageId?: string, attachments?: ChannelAttachment[], scope?: { programming?: string; cwd?: string; thisComputer?: boolean; media?: { kind: 'image' | 'video' | 'music'; aspect?: string } }): void {
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
        // Sent from this computer (Mercury Desktop or an attached terminal here): /server is allowed.
        ...(scope?.thisComputer ? { thisComputer: true } : {}),
        // The desktop's Image switch: this message asks for an image (media/intent.ts).
        ...(scope?.media ? { media: scope.media } : {}),
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
