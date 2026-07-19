import { BaseChannel } from './base.js';
import type { ChannelMessage } from '../types/channel.js';
import { logger } from '../utils/logger.js';

type ApprovalResolver = () => void;
type ChoiceResolver = (value: string) => void;
type CloudEventHandler = (event: ChatEvent) => void;

function normalizeStreamText(current: string, incoming: string): string {
  if (!current) return incoming;
  if (!incoming || incoming === current || current.endsWith(incoming)) return current;
  if (incoming.startsWith(current)) return incoming;

  let overlap = 0;
  const max = Math.min(current.length, incoming.length);
  for (let size = max; size > 0; size--) {
    if (current.slice(-size) === incoming.slice(0, size)) {
      overlap = size;
      break;
    }
  }
  return current + incoming.slice(overlap);
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
  private pendingApprovals: Map<string, ApprovalResolver> = new Map();
  private pendingContinues: Map<string, ApprovalResolver> = new Map();
  private pendingPermModes: Map<string, ApprovalResolver> = new Map();
  private pendingChoices: Map<string, ChoiceResolver> = new Map();
  private agentName: string;
  private stepCounter: Map<string, number> = new Map();
  private cloudEventHandlers: Map<string, CloudEventHandler> = new Map();
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

  private broadcast(event: ChatEvent): void {
    const targetId = typeof event.data?.targetId === 'string' ? event.data.targetId : undefined;
    if (targetId) {
      const cloudHandler = this.cloudEventHandlers.get(targetId);
      if (cloudHandler) {
        cloudHandler(event);
        if (event.type === 'text_done' || event.type === 'error') {
          this.cloudEventHandlers.delete(targetId);
        }
      }
    }

    for (const [, client] of this.sseClients) {
      if (targetId && client.sessionId !== targetId) continue;
      client.send(event);
    }
  }

  resolveApproval(id: string, action: string): boolean {
    const key = `${id}:${action}`;
    const resolver = this.pendingApprovals.get(key);
    if (resolver) {
      this.pendingApprovals.delete(key);
      resolver();
      return true;
    }
    // also check continues
    const continueResolver = this.pendingContinues.get(key);
    if (continueResolver) {
      this.pendingContinues.delete(key);
      continueResolver();
      return true;
    }
    // and perm modes
    const modeResolver = this.pendingPermModes.get(key);
    if (modeResolver) {
      this.pendingPermModes.delete(key);
      modeResolver();
      return true;
    }
    return false;
  }

  resolveChoice(id: string, value: string): boolean {
    const resolver = this.pendingChoices.get(id);
    if (!resolver) return false;
    this.pendingChoices.delete(id);
    resolver(value);
    return true;
  }

  async send(content: string, targetId?: string, elapsedMs?: number): Promise<void> {
    this.broadcast({
      type: 'text_done',
      data: { fullText: content, elapsedMs, targetId },
    });
  }

  async sendFile(_filePath: string, _targetId?: string): Promise<void> {
    // Not needed for web — files are referenced in text
  }

  async stream(content: AsyncIterable<string>, targetId?: string): Promise<string> {
    let fullText = '';
    let emittedText = '';
    for await (const chunk of content) {
      const nextText = normalizeStreamText(emittedText, chunk);
      const delta = nextText.slice(emittedText.length);
      fullText = nextText;
      emittedText = nextText;
      if (!delta) continue;
      this.broadcast({
        type: 'text_delta',
        data: { text: delta, targetId },
      });
    }
    return fullText;
  }

  async typing(_targetId?: string): Promise<void> {
    this.broadcast({ type: 'thinking', data: { targetId: _targetId } });
  }

  async askPermission(prompt: string, _targetId?: string): Promise<string> {
    if (this.bypassPermissions) return 'yes';
    const id = `perm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.broadcast({
      type: 'permission_request',
      data: { id, prompt, options: ['yes', 'always', 'no'], targetId: _targetId },
    });

    return new Promise((resolve) => {
      const yesKey = `${id}:yes`;
      const alwaysKey = `${id}:always`;
      const noKey = `${id}:no`;
      this.pendingApprovals.set(yesKey, () => resolve('yes'));
      this.pendingApprovals.set(alwaysKey, () => resolve('always'));
      this.pendingApprovals.set(noKey, () => resolve('no'));

      setTimeout(() => {
        this.pendingApprovals.delete(yesKey);
        this.pendingApprovals.delete(alwaysKey);
        this.pendingApprovals.delete(noKey);
        resolve('no');
      }, 120_000);
    });
  }

  async askToContinue(question: string, _targetId?: string): Promise<boolean> {
    if (this.bypassPermissions) return true;
    const id = `loop_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.broadcast({
      type: 'permission_continue',
      data: { id, question, options: ['yes', 'no'], targetId: _targetId },
    });

    return new Promise((resolve) => {
      const yesKey = `${id}:yes`;
      const noKey = `${id}:no`;
      this.pendingContinues.set(yesKey, () => resolve(true));
      this.pendingContinues.set(noKey, () => resolve(false));

      setTimeout(() => {
        this.pendingContinues.delete(yesKey);
        this.pendingContinues.delete(noKey);
        resolve(false);
      }, 120_000);
    });
  }

  askPermissionMode(): Promise<'allow-all' | 'ask-me'> {
    if (this.bypassPermissions) return Promise.resolve('allow-all');
    const id = `mode_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.broadcast({
      type: 'permission_mode',
      data: { id, options: ['ask-me', 'allow-all'] },
    });

    return new Promise((resolve) => {
      const askKey = `${id}:ask-me`;
      const allowKey = `${id}:allow-all`;
      this.pendingPermModes.set(askKey, () => resolve('ask-me'));
      this.pendingPermModes.set(allowKey, () => resolve('allow-all'));

      setTimeout(() => {
        this.pendingPermModes.delete(askKey);
        this.pendingPermModes.delete(allowKey);
        resolve('ask-me');
      }, 120_000);
    });
  }

  async presentChoicePrompt(question: string, options: Array<{ value: string; label: string }>, targetId?: string): Promise<string> {
    const id = `choice_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.broadcast({
      type: 'choice_prompt',
      data: { id, question, options, targetId },
    });

    return new Promise((resolve) => {
      this.pendingChoices.set(id, resolve);
      setTimeout(() => {
        if (!this.pendingChoices.has(id)) return;
        this.pendingChoices.delete(id);
        resolve(options[0]?.value || '');
      }, 120_000);
    });
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

  sendError(message: string, targetId?: string): void {
    this.broadcast({
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
    this.emitMessageInThread(content, requestId, sessionId, requestId, externalConversationId, messageId);
  }

  setBypassPermissions(enabled: boolean): void {
    this.bypassPermissions = enabled;
  }

  setRestrictUser(enabled: boolean): void {
    this.restrictUser = enabled;
  }

  getSettings(): { bypassPermissions: boolean; restrictUser: boolean } {
    return { bypassPermissions: this.bypassPermissions, restrictUser: this.restrictUser };
  }
}
