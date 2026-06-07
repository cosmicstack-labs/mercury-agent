import type { ChannelType, ChannelMessage } from '../types/channel.js';
import type { CompletionMeta } from '../ui/types.js';

export type PermissionMode = 'allow-all' | 'ask-me';

export interface Channel {
  readonly type: ChannelType;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(content: string, targetId?: string, elapsedMs?: number): Promise<void>;
  sendFile(filePath: string, targetId?: string): Promise<void>;
  stream(content: AsyncIterable<string>, targetId?: string): Promise<string>;
  typing(targetId?: string): Promise<void>;
  askToContinue(question: string, targetId?: string): Promise<boolean>;
  askPermissionMode?(): Promise<PermissionMode>;
  isReady(): boolean;
  onMessage(handler: (msg: ChannelMessage) => void): void;

  // ─── Capability contract ────────────────────────────────────────────────
  // Channels that buffer tool feedback into a single live status message
  // (Telegram, Signal) return true; streaming-only channels (CLI, Web) false.
  usesTaskBuffering(): boolean;
  // Channels that can stream the model's text token-by-token (CLI, Web,
  // Telegram) return true; text-only channels (Signal) return false.
  supportsStreaming(): boolean;

  // Task lifecycle — no-ops on channels that don't buffer.
  beginTask(targetId?: string): void;
  endTask(targetId?: string): void;
  isTaskActive(targetId?: string): boolean;
  resetStepCounter(targetId?: string): void;
  popDeferredResponse(targetId?: string): string | undefined;
  cleanupEphemeralMessages(targetId?: string): Promise<void>;

  // Progress + completion rendering.
  sendToolFeedback(toolName: string, args: Record<string, any>, targetId?: string): void | Promise<void>;
  sendStepDone(toolName: string, result: unknown, targetId?: string): void | Promise<void>;
  sendCompletion(elapsedMs: number, stepCount: number, targetId?: string, meta?: CompletionMeta): void | Promise<void>;

  // Interactive single-choice prompt. Returns the chosen label. Channels that
  // can't block on a reply fall back to sending a numbered list and returning
  // the first option (the safe default).
  requestChoice(question: string, choices: string[], targetId?: string): Promise<string>;
}

export abstract class BaseChannel implements Channel {
  abstract readonly type: ChannelType;
  protected messageHandler?: (msg: ChannelMessage) => void;
  protected ready = false;

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract send(content: string, targetId?: string, elapsedMs?: number): Promise<void>;
  abstract sendFile(filePath: string, targetId?: string): Promise<void>;
  abstract stream(content: AsyncIterable<string>, targetId?: string): Promise<string>;
  abstract typing(targetId?: string): Promise<void>;
  abstract askToContinue(question: string, targetId?: string): Promise<boolean>;

  isReady(): boolean {
    return this.ready;
  }

  onMessage(handler: (msg: ChannelMessage) => void): void {
    this.messageHandler = handler;
  }

  protected emit(message: ChannelMessage): void {
    this.messageHandler?.(message);
  }

  // ─── Capability contract defaults (no-ops) ───────────────────────────────
  usesTaskBuffering(): boolean {
    return false;
  }

  supportsStreaming(): boolean {
    return false;
  }

  beginTask(_targetId?: string): void {}
  endTask(_targetId?: string): void {}

  isTaskActive(_targetId?: string): boolean {
    return false;
  }

  resetStepCounter(_targetId?: string): void {}

  popDeferredResponse(_targetId?: string): string | undefined {
    return undefined;
  }

  cleanupEphemeralMessages(_targetId?: string): Promise<void> {
    return Promise.resolve();
  }

  sendToolFeedback(_toolName: string, _args: Record<string, any>, _targetId?: string): void | Promise<void> {}
  sendStepDone(_toolName: string, _result: unknown, _targetId?: string): void | Promise<void> {}
  sendCompletion(_elapsedMs: number, _stepCount: number, _targetId?: string, _meta?: CompletionMeta): void | Promise<void> {}

  async requestChoice(question: string, choices: string[], targetId?: string): Promise<string> {
    const list = choices.map((c, i) => `  ${i + 1}. ${c}`).join('\n');
    await this.send(`${question}\n${list}`, targetId).catch(() => {});
    return choices[0] ?? '';
  }
}