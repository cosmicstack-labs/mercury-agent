/**
 * RecordingChannel — captures everything the agent sends.
 *
 * Two styles:
 *  - 'messaging' implements the Telegram-style task contract the agent's
 *    TaskSurface duck-types (beginTask/endTask/popDeferredResponse/…): while
 *    a task is active, short sends land in a status card (recorded as
 *    `notice`, i.e. NOT a persistent message) and streamed answers are
 *    deferred until the task ends. That is exactly the behaviour that used to
 *    swallow pause banners, so a scenario can assert they are persistent.
 *  - 'plain' delivers every send/stream as a persistent message.
 *
 * Every event carries a monotonic timestamp from the harness clock.
 */
import { BaseChannel } from '../channels/base.js';
import type { ChannelMessage, ChannelType } from '../types/channel.js';

export type ChannelEventKind =
  | 'delivered' // persistent message the user sees
  | 'notice' // status-card line (ephemeral on messaging channels)
  | 'deferred' // answer parked until the task ends
  | 'completion' // completion banner (sendCompletion)
  | 'prompt' // askToContinue question
  | 'file'
  | 'typing'
  | 'task-begin'
  | 'task-end';

export interface ChannelEvent {
  kind: ChannelEventKind;
  text: string;
  at: number;
  targetId?: string;
  /** Answer given to a prompt. */
  answer?: boolean;
}

const isStatusNotice = (content: string): boolean =>
  content.startsWith('☿ ') || content.startsWith('⚠') || content.startsWith('  [') || content.length < 200;

export class RecordingChannel extends BaseChannel {
  readonly events: ChannelEvent[] = [];
  /** Answer for askToContinue; set per turn by the runner. */
  continueAnswer = false;
  private readonly active = new Map<string, boolean>();
  private readonly deferred = new Map<string, string>();

  constructor(
    readonly type: ChannelType,
    readonly style: 'messaging' | 'plain',
    private readonly clock: () => number,
  ) {
    super();
    if (style === 'plain') {
      // Strip the messaging contract so TaskSurface picks its plain path.
      for (const name of ['beginTask', 'endTask', 'resetStepCounter', 'popDeferredResponse', 'deferResponse', 'cleanupEphemeralMessages', 'sendCompletion'] as const) {
        Object.defineProperty(this, name, { value: undefined });
      }
    }
  }

  private record(kind: ChannelEventKind, text: string, targetId?: string, extra: Partial<ChannelEvent> = {}): void {
    this.events.push({ kind, text, at: this.clock(), targetId, ...extra });
  }

  /** Simulate an inbound user message (goes through ChannelRegistry → Agent.enqueueMessage). */
  inject(message: ChannelMessage): void {
    this.emit(message);
  }

  async start(): Promise<void> {
    this.ready = true;
  }

  async stop(): Promise<void> {
    this.ready = false;
  }

  async send(content: string, targetId?: string): Promise<void> {
    const key = targetId ?? 'default';
    if (this.style === 'messaging' && this.active.get(key)) {
      if (!content.trim()) return;
      if (isStatusNotice(content)) this.record('notice', content, targetId);
      else {
        this.deferred.set(key, content);
        this.record('deferred', content, targetId);
      }
      return;
    }
    this.record('delivered', content, targetId);
  }

  async sendFile(filePath: string, targetId?: string): Promise<void> {
    this.record('file', filePath, targetId);
  }

  async stream(content: AsyncIterable<string>, targetId?: string): Promise<string> {
    let full = '';
    for await (const chunk of content) full += chunk;
    const key = targetId ?? 'default';
    if (this.style === 'messaging' && this.active.get(key)) {
      this.deferred.set(key, full);
      if (full) this.record('deferred', full, targetId);
      return full;
    }
    if (full) this.record('delivered', full, targetId);
    return full;
  }

  async typing(targetId?: string): Promise<void> {
    this.record('typing', '', targetId);
  }

  async askToContinue(question: string, targetId?: string): Promise<boolean> {
    this.record('prompt', question, targetId, { answer: this.continueAnswer });
    return this.continueAnswer;
  }

  // ── Messaging task contract (see core/task-surface.ts) ─────────────────────

  beginTask(targetId?: string): void {
    const key = targetId ?? 'default';
    this.active.set(key, true);
    this.deferred.delete(key);
    this.record('task-begin', '', targetId);
  }

  endTask(targetId?: string): void {
    const key = targetId ?? 'default';
    if (this.active.get(key)) this.record('task-end', '', targetId);
    this.active.set(key, false);
  }

  resetStepCounter(): void {}

  popDeferredResponse(targetId?: string): string | undefined {
    return this.deferred.get(targetId ?? 'default');
  }

  deferResponse(targetId: string | undefined, content: string): void {
    if (content.trim()) this.deferred.set(targetId ?? 'default', content);
  }

  async cleanupEphemeralMessages(): Promise<void> {}

  async sendCompletion(elapsedMs: number, stepCount: number, targetId?: string): Promise<void> {
    this.endTask(targetId);
    const deferred = this.deferred.get(targetId ?? 'default');
    if (deferred && deferred.trim()) await this.send(deferred, targetId);
    this.deferred.delete(targetId ?? 'default');
    this.record('completion', `Task complete · ${stepCount} steps · ${(elapsedMs / 1000).toFixed(1)}s`, targetId);
  }

  // ── Views ──────────────────────────────────────────────────────────────────

  since(index: number): ChannelEvent[] {
    return this.events.slice(index);
  }
}

/**
 * Minimal stand-in for ChannelRegistry: the real one always registers (and
 * on wake, starts) the Ink CLI channel, which must not render in tests.
 * Implements exactly the surface Agent uses.
 */
export class EvalChannelRegistry {
  private readonly channels = new Map<ChannelType, BaseChannel>();
  private incoming?: (msg: ChannelMessage) => void;

  register(type: ChannelType, channel: BaseChannel): void {
    channel.onMessage((msg) => this.incoming?.(msg));
    this.channels.set(type, channel);
  }

  get(type: ChannelType): BaseChannel | undefined {
    return this.channels.get(type);
  }

  getChannelForMessage(message: ChannelMessage): BaseChannel | undefined {
    return this.channels.get(message.channelType);
  }

  getCliChannel(): undefined {
    return undefined;
  }

  async startAll(): Promise<void> {
    for (const channel of this.channels.values()) await channel.start();
  }

  async stopAll(): Promise<void> {
    for (const channel of this.channels.values()) await channel.stop();
  }

  getActiveChannels(): ChannelType[] {
    return [...this.channels.entries()].filter(([, c]) => c.isReady()).map(([t]) => t);
  }

  getNotificationChannel(): BaseChannel | undefined {
    return this.channels.values().next().value;
  }

  onIncomingMessage(handler: (msg: ChannelMessage) => void): void {
    this.incoming = handler;
  }
}
