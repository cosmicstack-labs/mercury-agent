import type { ChannelType, ChannelMessage } from '../types/channel.js';

export interface Channel {
  readonly type: ChannelType;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(content: string, targetId?: string, elapsedMs?: number): Promise<void>;
  sendFile(filePath: string, targetId?: string): Promise<void>;
  stream(content: AsyncIterable<string>, targetId?: string): Promise<string>;
  typing(targetId?: string): Promise<void>;
  isReady(): boolean;
  onMessage(handler: (msg: ChannelMessage) => void): void;
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

  isReady(): boolean {
    return this.ready;
  }

  onMessage(handler: (msg: ChannelMessage) => void): void {
    this.messageHandler = handler;
  }

  protected emit(message: ChannelMessage): void {
    this.messageHandler?.(message);
  }
}