import { existsSync, statSync } from 'node:fs';
import { resolve, basename, extname } from 'node:path';
import { BaseChannel } from './base.js';
import type { ChannelMessage } from '../types/channel.js';
import type { MercuryConfig } from '../utils/config.js';
import { isIMessagesAllowed } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { createImessagesApp, getContentBuilders, getImessagesProvider } from '../imessages/index.js';

const MAX_MESSAGE_LENGTH = 4000;
const DEDUP_MAX_SIZE = 4000;
const DEDUP_WINDOW_MS = 48 * 3600 * 1000;

type DedupEntry = { id: string; ts: number };

function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`{3}[\s\S]*?`{3}/g, (m) => m.replace(/`{3}/g, '').trim())
    .replace(/`(.+?)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/^>\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export class ImessagesChannel extends BaseChannel {
  readonly type = 'imessages' as const;

  private app: any = null;
  private config: MercuryConfig;
  private dedupSet: DedupEntry[] = [];
  private messageLoop: AbortController | null = null;
  private spaceCache = new Map<string, any>();
  private botPhoneNumber: string | null = null;

  constructor(config: MercuryConfig) {
    super();
    this.config = config;
  }

  async start(): Promise<void> {
    const { projectId, projectSecret } = this.config.channels.imessages;
    if (!projectId || !projectSecret) {
      logger.error('iMessages: IMESSAGES_PROJECT_ID and IMESSAGES_PROJECT_SECRET are required');
      return;
    }

    try {
      this.app = await createImessagesApp({ projectId, projectSecret });
      this.ready = true;
      logger.info({ channel: 'imessages' }, 'iMessages channel connected via Photon Spectrum');

      this.startMessageLoop();
    } catch (err) {
      logger.error({ err, channel: 'imessages' }, 'iMessages: failed to start');
      throw err;
    }
  }

  private startMessageLoop(): void {
    if (!this.app) return;
    this.messageLoop = new AbortController();

    const drain = async () => {
      try {
        for await (const [space, message] of this.app.messages) {
          if (this.messageLoop?.signal.aborted) break;
          this.handleInbound(space, message);
        }
      } catch (err: any) {
        if (this.messageLoop?.signal.aborted) return;
        logger.error({ err, channel: 'imessages' }, 'iMessages: message stream error, will reconnect');
      }
    };

    drain();
  }

  private handleInbound(space: any, message: any): void {
    if (!message) return;

    const sender = message.sender;
    const senderId = sender?.address || sender?.id || 'unknown';
    const senderName = sender?.name || sender?.address || undefined;

    if (sender?.kind === 'agent') {
      logger.debug({ channel: 'imessages', messageId: message.id }, 'iMessages: echo suppression — skipping own outbound');
      return;
    }

    if (!this.config.channels.imessages.allowAllUsers) {
      if (!isIMessagesAllowed(this.config, senderId)) {
        logger.info({ channel: 'imessages', senderId }, 'iMessages: message from unallowed user, ignoring');
        return;
      }
    }

    if (message.id && this.isDuplicate(message.id)) {
      return;
    }

    const content = this.extractContent(message);
    if (!content) {
      logger.debug({ channel: 'imessages', messageId: message.id, contentType: message.content?.type }, 'iMessages: could not extract text content, skipping');
      return;
    }

    const spaceId = space?.id || message.space?.id || senderId;

    this.spaceCache.set(spaceId, space);

    if (space?.phone && space.phone !== 'shared' && !this.botPhoneNumber) {
      this.botPhoneNumber = space.phone;
      logger.info({ channel: 'imessages', botPhone: this.botPhoneNumber }, 'iMessages: bot phone number auto-captured from first inbound space');
    }

    const channelId = `imessages:${spaceId}`;

    const channelMessage: ChannelMessage = {
      id: message.id || `imsg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      channelId,
      channelType: 'imessages',
      senderId,
      senderName,
      content,
      timestamp: message.timestamp instanceof Date ? message.timestamp.getTime() : (message.timestamp || Date.now()),
      metadata: {
        spaceId,
        platform: message.platform,
        ...this.extractMediaMetadata(message),
      },
    };

    logger.info({ channel: 'imessages', from: senderId, spaceId, contentPreview: content.slice(0, 50) }, 'iMessages: inbound message processed');
    this.emit(channelMessage);
  }

  private extractContent(message: any): string | null {
    const content = message.content;
    if (!content) return null;

    if (typeof content === 'string') return content;

    if (content.type === 'text' && content.text) return content.text;

    if (content.type === 'markdown') {
      if (content.markdown) return content.markdown;
      if (content.text) return content.text;
    }

    if (content.type === 'reply' && content.content) {
      const inner = this.extractContent({ content: content.content });
      if (inner) return inner;
    }

    if (content.type === 'group' && Array.isArray(content.items)) {
      const parts: string[] = [];
      for (const item of content.items) {
        const extracted = this.extractContent({ content: item });
        if (extracted) parts.push(extracted);
      }
      return parts.join(' ') || null;
    }

    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const part of content) {
        if (typeof part === 'string') parts.push(part);
        else if (part?.type === 'text' && part.text) parts.push(part.text);
        else if (part?.type === 'markdown' && (part.markdown || part.text)) parts.push(part.markdown || part.text);
      }
      return parts.join(' ') || null;
    }

    if (content.text) return content.text;

    return null;
  }

  private extractMediaMetadata(message: any): Record<string, unknown> {
    const meta: Record<string, unknown> = {};
    const content = message.content;

    if (!content) return meta;

    const items = Array.isArray(content) ? content : [content];
    const mediaTypes: string[] = [];

    for (const item of items) {
      if (item?.type === 'attachment' || item?.type === 'voice') {
        if (item.name) meta.attachmentName = item.name;
        if (item.mimeType) mediaTypes.push(item.mimeType);
        if (item.id) meta.attachmentId = item.id;
        if (item.size) meta.attachmentSize = item.size;
        if (item.type === 'voice' && item.duration) meta.voiceDuration = item.duration;
      }
    }

    if (mediaTypes.length > 0) meta.mediaTypes = mediaTypes;

    return meta;
  }

  private isDuplicate(id: string): boolean {
    const now = Date.now();
    this.dedupSet = this.dedupSet.filter((e) => now - e.ts < DEDUP_WINDOW_MS);
    if (this.dedupSet.some((e) => e.id === id)) return true;
    this.dedupSet.push({ id, ts: now });
    if (this.dedupSet.length > DEDUP_MAX_SIZE) {
      this.dedupSet = this.dedupSet.slice(-DEDUP_MAX_SIZE);
    }
    return false;
  }

  getBotPhoneNumber(): string | null {
    return this.botPhoneNumber;
  }

  async send(content: string, targetId?: string, elapsedMs?: number): Promise<void> {
    if (!this.app) throw new Error('iMessages channel not started');
    const builders = getContentBuilders();
    const useMarkdown = this.config.channels.imessages.markdown;

    const text = useMarkdown ? content : stripMarkdown(content);
    const chunks = this.chunkText(text, MAX_MESSAGE_LENGTH);

    const space = await this.resolveSpace(targetId);
    if (!space) {
      logger.warn({ channel: 'imessages', targetId }, 'iMessages: could not resolve space for send');
      return;
    }

    for (const chunk of chunks) {
      const contentObj = useMarkdown ? builders.markdown(chunk) : builders.text(chunk);
      await space.send(contentObj);
    }
  }

  async sendFile(filePath: string, targetId?: string): Promise<void> {
    if (!this.app) throw new Error('iMessages channel not started');

    const resolved = resolve(filePath);
    if (!existsSync(resolved)) {
      throw new Error(`File not found: ${resolved}`);
    }
    const stat = statSync(resolved);
    if (stat.isDirectory()) {
      throw new Error(`${resolved} is a directory, not a file`);
    }
    if (stat.size > this.config.channels.imessages.maxInlineAttachmentBytes) {
      throw new Error(`File too large (${Math.round(stat.size / (1024 * 1024))}MB). Maximum is ${Math.round(this.config.channels.imessages.maxInlineAttachmentBytes / (1024 * 1024))}MB`);
    }

    const { attachment } = getContentBuilders();
    const ext = extname(resolved).toLowerCase();
    const mimeMap: Record<string, string> = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
      '.webp': 'image/webp', '.pdf': 'application/pdf', '.txt': 'text/plain',
      '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
      '.mp4': 'video/mp4', '.mov': 'video/quicktime',
    };
    const mimeType = mimeMap[ext];
    const filename = basename(resolved);
    const attachOpts: { name?: string; mimeType?: string } = {};
    if (mimeType) attachOpts.mimeType = mimeType;
    if (filename !== extname(resolved)) attachOpts.name = filename;

    const space = await this.resolveSpace(targetId);
    if (!space) {
      logger.warn({ channel: 'imessages', targetId }, 'iMessages: could not resolve space for sendFile');
      return;
    }

    await space.send(attachment(resolved, attachOpts));
  }

  async stream(content: AsyncIterable<string>, targetId?: string): Promise<string> {
    let full = '';
    for await (const chunk of content) {
      full += chunk;
    }
    await this.send(full, targetId);
    return full;
  }

  async typing(targetId?: string): Promise<void> {
    if (!this.app) return;
    const { typing } = getContentBuilders();

    try {
      const space = await this.resolveSpace(targetId);
      if (space) {
        await space.startTyping();
      }
    } catch {
      // typing indicator failures are non-critical
    }
  }

  async askToContinue(question: string, targetId?: string): Promise<boolean> {
    await this.send(question, targetId);
    return true;
  }

  async stop(): Promise<void> {
    this.messageLoop?.abort();
    this.messageLoop = null;
    this.spaceCache.clear();

    if (this.app) {
      try {
        await this.app.stop();
      } catch (err) {
        logger.warn({ err, channel: 'imessages' }, 'iMessages: error during stop');
      }
      this.app = null;
    }

    this.ready = false;
    logger.info({ channel: 'imessages' }, 'iMessages channel stopped');
  }

  private async resolveSpace(targetId?: string): Promise<any> {
    if (!this.app) return null;

    const bareId = targetId?.startsWith('imessages:') ? targetId.slice('imessages:'.length) : targetId;

    if (bareId && this.spaceCache.has(bareId)) {
      return this.spaceCache.get(bareId);
    }

    if (bareId && bareId !== 'notification') {
      try {
        const narrowed = getImessagesProvider()(this.app);
        const existing = await narrowed.space.get(bareId);
        if (existing) {
          this.spaceCache.set(bareId, existing);
          return existing;
        }
      } catch {
        // fall through to create
      }

      try {
        const narrowed = getImessagesProvider()(this.app);
        const user = await narrowed.user(bareId);
        const space = await narrowed.space.create(user);
        this.spaceCache.set(bareId, space);
        return space;
      } catch (err) {
        logger.debug({ err, targetId: bareId, channel: 'imessages' }, 'iMessages: failed to resolve/create space');
        return null;
      }
    }

    if (bareId === 'notification' || !bareId) {
      if (this.spaceCache.size > 0) {
        const firstSpace = this.spaceCache.values().next().value;
        if (firstSpace) return firstSpace;
      }

      const allowedUsers = this.config.channels.imessages.allowedUsers;
      if (allowedUsers.length > 0) {
        return this.resolveSpace(allowedUsers[0]);
      }

      return null;
    }

    return null;
  }

  private chunkText(text: string, maxLength: number): string[] {
    if (text.length <= maxLength) return [text];

    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }

      let splitAt = remaining.lastIndexOf('\n', maxLength);
      if (splitAt === -1 || splitAt > maxLength) splitAt = remaining.lastIndexOf(' ', maxLength);
      if (splitAt === -1 || splitAt > maxLength) splitAt = maxLength;

      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt + (remaining[splitAt] === '\n' || remaining[splitAt] === ' ' ? 1 : 0));
    }

    return chunks;
  }
}