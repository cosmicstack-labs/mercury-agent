import { BaseChannel } from './base.js';
import type { ChannelMessage } from '../types/channel.js';
import { logger } from '../utils/logger.js';
import { randomUUID } from 'node:crypto';

type CloudEventHandler = (event: ChatEvent) => boolean;

type PendingInteractionKind = 'permission' | 'continue' | 'mode' | 'choice';

interface PendingInteraction {
  kind: PendingInteractionKind;
  targetId?: string;
  allowedValues: Set<string>;
  resolve: (value: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ChatEvent {
  type: 'thinking' | 'provider' | 'heartbeat' | 'step_start' | 'step_done' | 'text_delta' | 'text_done' | 'permission_request' | 'permission_continue' | 'permission_mode' | 'permission_resolved' | 'choice_prompt' | 'choice_resolved' | 'loop_warning' | 'error';
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
    return true;
  }

  private waitForInteraction(
    id: string,
    kind: PendingInteractionKind,
    values: string[],
    targetId: string | undefined,
    fallback: string,
  ): Promise<string> {
    const boundTargetId = targetId && this.cloudEventHandlers.has(targetId) ? targetId : undefined;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const interaction = this.pendingInteractions.get(id);
        if (!interaction) return;
        this.pendingInteractions.delete(id);
        this.broadcast({
          type: interaction.kind === 'choice' ? 'choice_resolved' : 'permission_resolved',
          data: { id, status: 'expired', targetId: interaction.targetId },
        });
        resolve(fallback);
      }, 120_000);
      this.pendingInteractions.set(id, {
        kind,
        targetId: boundTargetId,
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

  async askPermission(prompt: string, _targetId?: string): Promise<string> {
    if (this.isPermissionBypassed(_targetId)) return 'yes';
    if (!this.hasInteractiveTarget(_targetId)) return 'no';
    const id = `perm_${randomUUID()}`;
    this.broadcast({
      type: 'permission_request',
      data: { id, prompt, options: ['yes', 'always', 'no'], targetId: _targetId },
    });

    return this.waitForInteraction(id, 'permission', ['yes', 'always', 'no'], _targetId, 'no');
  }

  async askToContinue(question: string, _targetId?: string): Promise<boolean> {
    if (!this.hasInteractiveTarget(_targetId)) return false;
    const id = `loop_${randomUUID()}`;
    this.broadcast({
      type: 'permission_continue',
      data: { id, question, options: ['yes', 'no'], targetId: _targetId },
    });

    return this.waitForInteraction(id, 'continue', ['yes', 'no'], _targetId, 'no').then((value) => value === 'yes');
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
    this.broadcast({
      type: 'choice_prompt',
      data: { id, question, options, targetId },
    });

    return this.waitForInteraction(id, 'choice', options.map((option) => option.value), targetId, '');
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
      data: { message, targetId },
    });
  }

  resetStepCounter(targetId?: string): void {
    const channelId = targetId || 'default';
    this.stepCounter.delete(channelId);
  }

  emitMessage(content: string): void {
    this.emitMessageInThread(content, 'web:default');
  }

  emitMessageInThread(content: string, threadId: string, sessionId?: string, requestId?: string, externalConversationId?: string, messageId?: string): void {
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
