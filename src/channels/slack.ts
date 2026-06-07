import fs from 'node:fs';
import path from 'node:path';
import { App, SocketModeReceiver, HTTPReceiver } from '@slack/bolt';
import type { ChannelMessage } from '../types/channel.js';
import { BaseChannel, type PermissionMode } from './base.js';
import type { MercuryConfig, SlackAccessUser, SlackPendingRequest } from '../utils/config.js';
import {
  addSlackPendingRequest,
  approveSlackPendingRequest,
  approveSlackPendingRequestByPairingCode,
  clearSlackAccess,
  findSlackAdmin,
  findSlackApprovedUser,
  findSlackPendingRequest,
  getSlackAccessSummary,
  getSlackAdmins,
  getSlackApprovedUserIds,
  getSlackApprovedUsers,
  hasSlackAdmins,
  loadConfig,
  rejectSlackPendingRequest,
  removeSlackUser,
  saveConfig,
} from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { mdToSlack } from '../utils/markdown.js';
import { formatToolStep, formatToolResult } from '../utils/tool-label.js';

const MAX_MESSAGE_LENGTH = 40000;
const ACCESS_ACTION_PREFIX = 'sl_access';
const MEMORY_ACTION_PREFIX = 'sl_memory';
const PIN_STEP_THRESHOLD = 3;

type ApprovalResolver = () => void;

export class SlackChannel extends BaseChannel {
  readonly type = 'slack' as const;
  private app: App | null = null;
  private botUserId: string = '';
  private teamId: string = '';
  private chatCommandContext?: import('../capabilities/registry.js').ChatCommandContext;
  private pendingApprovals: Map<string, ApprovalResolver> = new Map();
  private permissionModes = new Map<string, PermissionMode>();
  private onPermissionMode?: (mode: PermissionMode, channelId: string) => void;
  private statusMessageTs = new Map<string, string>();
  private stepCounters = new Map<string, number>();
  private stepHistory = new Map<string, string[]>();
  private taskActive = new Map<string, boolean>();
  private deferredResponses = new Map<string, string>();
  private statusNotices = new Map<string, string[]>();
  private processedMessages = new Map<string, number>();
  private mentionedThreads = new Set<string>();
  private originalMessageTs = new Map<string, { ts: string; channelId: string }>();
  private ephemeralMessageTs = new Map<string, string[]>();
  private pinnedMessageTs = new Map<string, string>();

  constructor(private config: MercuryConfig) {
    super();
  }

  private reloadConfig(): void {
    try {
      this.config = loadConfig();
    } catch {
      // keep using in-memory config if disk read fails
    }
  }

  setChatCommandContext(ctx: import('../capabilities/registry.js').ChatCommandContext): void {
    this.chatCommandContext = ctx;
  }

  usesTaskBuffering(): boolean {
    return true;
  }

  supportsStreaming(): boolean {
    return true;
  }

  beginTask(targetId?: string): void {
    const key = targetId || 'notification';
    this.taskActive.set(key, true);
    this.deferredResponses.delete(key);
    this.statusNotices.delete(key);
  }

  endTask(targetId?: string): void {
    const key = targetId || 'notification';
    this.taskActive.set(key, false);
  }

  isTaskActive(targetId?: string): boolean {
    const key = targetId || 'notification';
    return this.taskActive.get(key) ?? false;
  }

  popDeferredResponse(targetId?: string): string | undefined {
    const key = targetId || 'notification';
    const text = this.deferredResponses.get(key);
    this.deferredResponses.delete(key);
    return text;
  }

  setOnPermissionMode(handler: (mode: PermissionMode, channelId: string) => void): void {
    this.onPermissionMode = handler;
  }

  getPermissionMode(channelId: string): PermissionMode {
    return this.permissionModes.get(channelId) ?? 'ask-me';
  }

  async start(): Promise<void> {
    if (this.app) return;

    const botToken = this.config.channels.slack.botToken;
    const appToken = this.config.channels.slack.appToken;
    const signingSecret = this.config.channels.slack.signingSecret;
    const mode = this.config.channels.slack.mode;

    if (!botToken) {
      logger.warn('Slack bot token not set — skipping');
      return;
    }

    if (mode === 'socket' && !appToken) {
      logger.warn('Slack app token (xapp-) required for Socket Mode — skipping');
      return;
    }

    if (mode === 'http' && !signingSecret) {
      logger.warn('Slack signing secret required for HTTP mode — skipping');
      return;
    }

    let receiver: SocketModeReceiver | HTTPReceiver;
    if (mode === 'socket') {
      receiver = new SocketModeReceiver({
        appToken,
        autoReconnectEnabled: true,
        clientPingTimeout: 15_000,
      });
    } else {
      receiver = new HTTPReceiver({
        signingSecret,
        endpoints: '/slack/events',
      });
    }

    const app = new App({
      token: botToken,
      receiver,
      ignoreSelf: false,
    });

    try {
      const authTest = await app.client.auth.test({ token: botToken });
      this.botUserId = authTest.user_id as string;
      this.teamId = authTest.team_id as string;
      logger.info({ botUserId: this.botUserId, teamId: this.teamId }, 'Slack auth.test successful');
    } catch (err: any) {
      logger.error({ err: err.message }, 'Slack auth.test failed — bot token may be invalid');
      return;
    }

    app.event('app_mention', async ({ event, client }) => {
      try {
        await this.handleMessageEvent(event as any, client, true);
      } catch (err: any) {
        logger.error({ err: err.message }, 'Slack app_mention handler error');
      }
    });

    app.event('message', async ({ event, client }) => {
      const msgEvent = event as any;
      if (msgEvent.subtype || msgEvent.bot_id) return;
      if (msgEvent.channel_type === 'channel' || msgEvent.channel_type === 'group') {
        if (!msgEvent.text || !msgEvent.text.includes(`<@${this.botUserId}>`)) return;
        try {
          await this.handleMessageEvent(msgEvent, client, msgEvent.channel_type === 'group');
        } catch (err: any) {
          logger.error({ err: err.message }, 'Slack message handler error (channel/group)');
        }
        return;
      }
      try {
        await this.handleMessageEvent(msgEvent, client, false);
      } catch (err: any) {
        logger.error({ err: err.message }, 'Slack message handler error (DM)');
      }
    });

    app.action(new RegExp(`^${ACCESS_ACTION_PREFIX}:`), async ({ action, ack, respond, body }) => {
      await ack();
      try {
        await this.handleAccessBlockAction(action as any, body as any, respond);
      } catch (err: any) {
        logger.error({ err: err.message }, 'Slack access action handler error');
      }
    });

    app.action(new RegExp(`^${MEMORY_ACTION_PREFIX}:`), async ({ action, ack, body, client }) => {
      await ack();
      try {
        await this.handleMemoryBlockAction(action as any, body as any, client);
      } catch (err: any) {
        logger.error({ err: err.message }, 'Slack memory action handler error');
      }
    });

    app.action(/^feedback:/, async ({ action, ack, body }) => {
      await ack();
      try {
        const actionId: string = (action as any).action_id || '';
        const resolver = this.pendingApprovals.get(actionId);
        if (resolver) {
          this.pendingApprovals.delete(actionId);
          resolver();
        }
      } catch (err: any) {
        logger.error({ err: err.message }, 'Slack feedback action handler error');
      }
    });

    app.error(async (error) => {
      logger.error({ err: (error as any).message }, 'Slack Bolt global error');
    });

    this.app = app;

    try {
      await app.start();
      this.ready = true;
      logger.info({ mode }, 'Slack bot started — connection active');
    } catch (err: any) {
      logger.error({ err: err.message }, 'Slack bot start failed');
      this.app = null;
    }
  }

  async stop(): Promise<void> {
    if (this.app) {
      try {
        await this.app.stop();
      } catch {
        // ignore stop errors
      }
      this.app = null;
    }
    this.ready = false;
  }

  private async handleMessageEvent(event: any, client: any, isMention: boolean): Promise<void> {
    const userId = event.user;
    const channelId = event.channel;
    const text = (event.text || '').trim();
    const threadTs = event.thread_ts || event.ts;

    if (event.bot_id || userId === this.botUserId) return;

    const dedupeKey = `${event.ts}:${channelId}`;
    const now = Date.now();
    const lastSeen = this.processedMessages.get(dedupeKey);
    if (lastSeen && now - lastSeen < 30_000) return;
    this.processedMessages.set(dedupeKey, now);
    if (this.processedMessages.size > 1000) {
      const cutoff = now - 60_000;
      for (const [k, t] of this.processedMessages) {
        if (t < cutoff) this.processedMessages.delete(k);
      }
    }

    const command = this.getCommandName(text);

    if (command === '/start' || command === 'start' || command === '/pair' || command === 'pair') {
      await this.handleAccessRequest(userId, channelId, event.username || userId, threadTs, client);
      return;
    }

    const approvedUser = findSlackApprovedUser(this.config, userId);
    if (!approvedUser) {
      this.reloadConfig();
      const recheckedUser = findSlackApprovedUser(this.config, userId);
      if (recheckedUser) {
        this.emitMessage(event, recheckedUser, client);
        return;
      }

      const pending = findSlackPendingRequest(this.config, userId);
      if (pending) {
        await this.sendToChannel(channelId, threadTs, client, this.getPendingStatusMessage(pending));
      } else {
        await this.sendToChannel(channelId, threadTs, client, 'This bot is not available to you. Send /start to request access.');
      }
      return;
    }

    if (command === '/memory') {
      if (!this.chatCommandContext) {
        await this.sendToChannel(channelId, threadTs, client, 'Memory not available.');
        return;
      }
      await this.sendMemoryKeyboard(channelId, threadTs, client);
      return;
    }

    if (command === '/unpair') {
      if (!this.isAdminUser(userId)) {
        await this.sendToChannel(channelId, threadTs, client, 'Only Slack admins can reset Slack access.');
        return;
      }
      clearSlackAccess(this.config);
      saveConfig(this.config);
      await this.sendToChannel(channelId, threadTs, client, 'Slack access reset. New users can send /start to request access. The first request must be approved from the Mercury CLI.');
      return;
    }

    if (command === '/permissions') {
      this.askPermissionMode(`slack:${channelId}`).then((mode) => {
        this.permissionModes.set(channelId, mode);
        if (this.onPermissionMode) {
          this.onPermissionMode(mode, channelId);
        }
      }).catch(() => {});
      return;
    }

    const isChannel = event.channel_type === 'channel' || event.channel_type === 'group';
    if (isChannel) {
      if (this.config.channels.slack.ignoredChannels.includes(channelId)) return;

      if (this.config.channels.slack.requireMention &&
          !this.config.channels.slack.freeResponseChannels.includes(channelId)) {
        if (!isMention && !this.mentionedThreads.has(threadTs)) {
          return;
        }
      }

      if (isMention && this.config.channels.slack.threadFollow) {
        this.mentionedThreads.add(threadTs);
      }
    }

    if (!this.permissionModes.has(channelId) && this.onPermissionMode) {
      this.askPermissionMode(`slack:${channelId}`).then((mode) => {
        this.permissionModes.set(channelId, mode);
        if (this.onPermissionMode) {
          this.onPermissionMode(mode, channelId);
        }
      }).catch(() => {});
      this.permissionModes.set(channelId, 'ask-me');
    }

    if (this.config.channels.slack.reactions) {
      await this.addReaction(channelId, event.ts, 'eyes', client).catch(() => {});
    }

    this.originalMessageTs.set(`slack:${channelId}`, { ts: event.ts, channelId });

    const senderRole = this.isAdminUser(userId) ? 'admin' as const : 'member' as const;
    const cleanText = text.replace(/<@[^>]+>/g, '').trim();
    const msg: ChannelMessage = {
      id: event.ts,
      channelId: `slack:${channelId}`,
      channelType: 'slack',
      senderId: userId,
      senderName: event.username || userId,
      senderRole,
      content: cleanText,
      timestamp: Math.floor(parseFloat(event.ts) * 1000),
      metadata: { channelId, threadTs, eventTs: event.ts },
    };
    this.emit(msg);
  }

  private emitMessage(event: any, approvedUser: SlackAccessUser, client: any): void {
    const userId = event.user;
    const channelId = event.channel;
    const threadTs = event.thread_ts || event.ts;
    const text = (event.text || '').trim();
    const senderRole = this.isAdminUser(userId) ? 'admin' as const : 'member' as const;
    const cleanText = text.replace(/<@[^>]+>/g, '').trim();

    const isChannel = event.channel_type === 'channel' || event.channel_type === 'group';
    if (isChannel && this.config.channels.slack.ignoredChannels.includes(channelId)) return;

    if (isChannel && this.config.channels.slack.requireMention &&
        !this.config.channels.slack.freeResponseChannels.includes(channelId)) {
      const isMention = text.includes(`<@${this.botUserId}>`);
      if (!isMention && !this.mentionedThreads.has(threadTs)) return;
      if (isMention && this.config.channels.slack.threadFollow) {
        this.mentionedThreads.add(threadTs);
      }
    }

    const msg: ChannelMessage = {
      id: event.ts,
      channelId: `slack:${channelId}`,
      channelType: 'slack',
      senderId: userId,
      senderName: event.username || userId,
      senderRole,
      content: cleanText,
      timestamp: Math.floor(parseFloat(event.ts) * 1000),
      metadata: { channelId, threadTs, eventTs: event.ts },
    };
    this.emit(msg);
  }

  async send(content: string, targetId?: string, elapsedMs?: number): Promise<void> {
    const { channelId, threadTs } = this.resolveTarget(targetId);
    if (!channelId || !this.app) return;

    const key = targetId || 'notification';
    logger.debug({ targetId, key, contentLength: content.length, taskActive: this.taskActive.get(key) }, 'Slack send()');

    if (this.taskActive.get(key)) {
      const timeSuffix = elapsedMs != null ? ` (${(elapsedMs / 1000).toFixed(1)}s)` : '';
      const fullContent = content + timeSuffix;
      if (!fullContent.trim()) return;

      const isSystemNotice = content.startsWith('☿ ') || content.startsWith('⚠') || content.startsWith('  [') || content.length < 200;
      if (isSystemNotice) {
        const notices = this.statusNotices.get(key) || [];
        const truncated = fullContent.length > 80 ? fullContent.slice(0, 77) + '...' : fullContent;
        notices.push(truncated);
        this.statusNotices.set(key, notices);
        await this.refreshStatusCard(targetId);
      } else {
        this.deferredResponses.set(key, fullContent);
      }
      return;
    }

    const timeSuffix = elapsedMs != null ? `\n${(elapsedMs / 1000).toFixed(1)}s` : '';
    const fullContent = content + timeSuffix;
    if (!fullContent.trim()) return;

    const md = mdToSlack(fullContent);
    const chunks = this.splitMessage(md, MAX_MESSAGE_LENGTH);

    for (const chunk of chunks) {
      try {
        await this.app.client.chat.postMessage({
          channel: channelId,
          text: chunk,
          thread_ts: threadTs || undefined,
          unfurl_links: false,
          unfurl_media: false,
        });
      } catch (err: any) {
        logger.error({ err: err.message, channelId }, 'Slack send failed');
      }
    }
  }

  async sendFile(filePath: string, targetId?: string): Promise<void> {
    const { channelId, threadTs } = this.resolveTarget(targetId);
    if (!channelId || !this.app) return;

    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      await this.send(`File not found: ${filePath}`, targetId);
      return;
    }

    try {
      const filename = path.basename(resolved);
      const uploadArgs: any = {
        channel_id: channelId,
        initial_comment: filename,
        file: fs.createReadStream(resolved),
        filename,
      };
      if (threadTs) {
        uploadArgs.thread_ts = threadTs;
      }
      await this.app.client.files.uploadV2(uploadArgs);
      logger.info({ file: resolved, channelId }, 'File sent via Slack');
    } catch (err: any) {
      logger.error({ err: err.message, file: resolved, channelId }, 'Slack sendFile failed');
      await this.send(`Failed to send file: ${err.message}`, targetId);
    }
  }

  async stream(content: AsyncIterable<string>, targetId?: string): Promise<string> {
    const { channelId, threadTs } = this.resolveTarget(targetId);
    if (!channelId || !this.app) return '';

    let full = '';
    for await (const chunk of content) {
      full += chunk;
    }

    const key = targetId || 'notification';
    if (this.taskActive.get(key)) {
      this.deferredResponses.set(key, full);
      return full;
    }

    await this.deleteStatusMessage(targetId);

    const md = mdToSlack(full);
    const chunks = this.splitMessage(md, MAX_MESSAGE_LENGTH);
    for (const chunk of chunks) {
      try {
        await this.app.client.chat.postMessage({
          channel: channelId,
          text: chunk,
          thread_ts: threadTs || undefined,
          unfurl_links: false,
          unfurl_media: false,
        });
      } catch (err: any) {
        logger.error({ err: err.message, channelId }, 'Slack stream final send failed');
      }
    }
    return full;
  }

  async sendStreamToChat(channelId: string, textStream: AsyncIterable<string>): Promise<string> {
    if (!this.app) return '';

    const activeKey = this.findActiveTaskKey(channelId);
    if (activeKey) {
      let full = '';
      for await (const chunk of textStream) {
        full += chunk;
      }
      this.deferredResponses.set(activeKey, full);
      return full;
    }

    const STREAM_EDIT_INTERVAL = 1500;
    const STREAM_MIN_LENGTH = 20;

    try {
      let full = '';
      let messageTs: string | null = null;
      let lastEditTime = 0;
      let lastEditLength = 0;

      for await (const chunk of textStream) {
        full += chunk;

        const now = Date.now();
        const timeSinceLastEdit = now - lastEditTime;
        const charsSinceLastEdit = full.length - lastEditLength;

        if (!messageTs && full.length >= STREAM_MIN_LENGTH) {
          try {
            const result = await this.app.client.chat.postMessage({
              channel: channelId,
              text: full + ' |',
              unfurl_links: false,
              unfurl_media: false,
            });
            messageTs = result.ts as string;
            lastEditTime = now;
            lastEditLength = full.length;
          } catch {
            messageTs = null;
          }
        } else if (messageTs && timeSinceLastEdit >= STREAM_EDIT_INTERVAL && charsSinceLastEdit >= 20) {
          try {
            await this.app.client.chat.update({
              channel: channelId,
              ts: messageTs,
              text: full + ' |',
            });
            lastEditTime = now;
            lastEditLength = full.length;
          } catch {
            // edit failed — rate limited
          }
        }
      }

      if (messageTs) {
        const md = mdToSlack(full);
        try {
          await this.app.client.chat.update({
            channel: channelId,
            ts: messageTs,
            text: md,
          });
        } catch {
          // final edit failed
        }
      } else if (full.trim()) {
        const md = mdToSlack(full);
        const chunks = this.splitMessage(md, MAX_MESSAGE_LENGTH);
        for (const chunk of chunks) {
          try {
            await this.app.client.chat.postMessage({
              channel: channelId,
              text: chunk,
              unfurl_links: false,
              unfurl_media: false,
            });
          } catch {
            // send failed
          }
        }
      }

      return full;
    } finally {
      // cleanup if needed
    }
  }

  async typing(targetId?: string): Promise<void> {
    // Slack doesn't have a direct typing indicator API
    // Use reactions as visual indicator instead (handled in handleMessageEvent)
  }

  async askToContinue(question: string, targetId?: string): Promise<boolean> {
    const { channelId, threadTs } = this.resolveTarget(targetId);
    if (!channelId || !this.app) return false;

    const id = `loop_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const blocks: any[] = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: question },
      },
      {
        type: 'actions',
        elements: [
          { type: 'button', text: { type: 'plain_text', text: 'Continue' }, action_id: `${id}:yes`, style: 'primary' },
          { type: 'button', text: { type: 'plain_text', text: 'Stop' }, action_id: `${id}:no`, style: 'danger' },
        ],
      },
    ];

    let sentTs: string | undefined;
    try {
      const result = await this.app.client.chat.postMessage({
        channel: channelId,
        text: question,
        thread_ts: threadTs || undefined,
        blocks,
      });
      sentTs = result.ts as string;
    } catch {
      return false;
    }

    return new Promise((resolve) => {
      const cleanup = (result: boolean) => {
        this.pendingApprovals.delete(`${id}:yes`);
        this.pendingApprovals.delete(`${id}:no`);
        this.deleteMessage(channelId, sentTs);
        resolve(result);
      };
      this.pendingApprovals.set(`${id}:yes`, () => cleanup(true));
      this.pendingApprovals.set(`${id}:no`, () => cleanup(false));

      setTimeout(() => {
        this.pendingApprovals.delete(`${id}:yes`);
        this.pendingApprovals.delete(`${id}:no`);
        this.deleteMessage(channelId, sentTs);
        resolve(false);
      }, 300_000);
    });
  }

  async askPermissionMode(targetId?: string): Promise<PermissionMode> {
    const { channelId, threadTs } = this.resolveTarget(targetId);
    if (!channelId || !this.app) return 'ask-me';

    const blocks: any[] = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '*Permission Mode*\nHow should Mercury handle risky actions this session?' },
      },
      {
        type: 'actions',
        elements: [
          { type: 'button', text: { type: 'plain_text', text: '🔒 Ask Me' }, action_id: `perm_mode_ask:${channelId}`, value: 'ask-me' },
          { type: 'button', text: { type: 'plain_text', text: '✅ Allow All' }, action_id: `perm_mode_allow:${channelId}`, value: 'allow-all', style: 'primary' },
        ],
      },
    ];

    let sentTs: string | undefined;
    try {
      const result = await this.app.client.chat.postMessage({
        channel: channelId,
        text: 'Permission Mode',
        thread_ts: threadTs || undefined,
        blocks,
      });
      sentTs = result.ts as string;
    } catch {
      return 'ask-me';
    }

    return new Promise((resolve) => {
      const askHandler = async ({ action, ack }: any) => {
        await ack();
        const value = (action?.value || (action?.action_id?.includes('allow') ? 'allow-all' : 'ask-me')) as PermissionMode;
        resolve(value);
      };

      this.app?.action(/^perm_mode_/, askHandler as any);

      setTimeout(() => {
        this.deleteMessage(channelId, sentTs);
        resolve('ask-me');
      }, 300_000);
    });
  }

  async askPermission(prompt: string, targetId?: string): Promise<string> {
    const { channelId, threadTs } = this.resolveTarget(targetId);
    if (!channelId || !this.app) return 'no';

    const id = `perm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const blocks: any[] = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: prompt },
      },
      {
        type: 'actions',
        elements: [
          { type: 'button', text: { type: 'plain_text', text: 'Allow' }, action_id: `${id}:yes`, style: 'primary' },
          { type: 'button', text: { type: 'plain_text', text: 'Always' }, action_id: `${id}:always` },
          { type: 'button', text: { type: 'plain_text', text: 'Deny' }, action_id: `${id}:no`, style: 'danger' },
        ],
      },
    ];

    let sentTs: string | undefined;
    try {
      const result = await this.app.client.chat.postMessage({
        channel: channelId,
        text: prompt,
        thread_ts: threadTs || undefined,
        blocks,
      });
      sentTs = result.ts as string;
    } catch (err: any) {
      logger.error({ err: err.message }, 'Slack askPermission send failed');
      return 'no';
    }

    return new Promise((resolve) => {
      const cleanup = (result: string) => {
        this.pendingApprovals.delete(`${id}:yes`);
        this.pendingApprovals.delete(`${id}:always`);
        this.pendingApprovals.delete(`${id}:no`);
        this.deleteMessage(channelId, sentTs);
        resolve(result);
      };
      this.pendingApprovals.set(`${id}:yes`, () => cleanup('yes'));
      this.pendingApprovals.set(`${id}:always`, () => cleanup('always'));
      this.pendingApprovals.set(`${id}:no`, () => cleanup('no'));

      setTimeout(() => {
        this.pendingApprovals.delete(`${id}:yes`);
        this.pendingApprovals.delete(`${id}:always`);
        this.pendingApprovals.delete(`${id}:no`);
        this.deleteMessage(channelId, sentTs);
        resolve('no');
      }, 300_000);
    });
  }

  async requestChoice(question: string, choices: string[], targetId?: string): Promise<string> {
    const { channelId, threadTs } = this.resolveTarget(targetId);
    if (!channelId || !this.app) return choices[0] ?? '';

    if (choices.length <= 5) {
      return this.requestChoiceButtons(question, choices, channelId, threadTs);
    }

    const id = `choice_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const options = choices.map((c, i) => ({
      text: { type: 'plain_text', text: c.length > 75 ? c.slice(0, 72) + '...' : c },
      value: String(i),
    }));

    const blocks: any[] = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: question },
        accessory: {
          type: 'static_select',
          action_id: id,
          placeholder: { type: 'plain_text', text: 'Choose an option' },
          options,
        },
      },
    ];

    try {
      await this.app.client.chat.postMessage({
        channel: channelId,
        text: question,
        thread_ts: threadTs || undefined,
        blocks,
      });
    } catch {
      return choices[0] ?? '';
    }

    return new Promise((resolve) => {
      const handler = async ({ action, ack }: any) => {
        await ack();
        const idx = parseInt(action?.selected_option?.value ?? '0', 10);
        resolve(choices[idx] ?? choices[0]);
      };

      this.app?.action(id, handler as any);

      setTimeout(() => {
        resolve(choices[0] ?? '');
      }, 120_000);
    });
  }

  private async requestChoiceButtons(question: string, choices: string[], channelId: string, threadTs?: string): Promise<string> {
    const id = `choice_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const elements = choices.map((c) => ({
      type: 'button' as const,
      text: { type: 'plain_text' as const, text: c.length > 75 ? c.slice(0, 72) + '...' : c },
      action_id: `${id}:${c}`,
    }));

    const blocks: any[] = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: question },
      },
      {
        type: 'actions',
        elements,
      },
    ];

    try {
      await this.app!.client.chat.postMessage({
        channel: channelId,
        text: question,
        thread_ts: threadTs || undefined,
        blocks,
      });
    } catch {
      return choices[0];
    }

    return new Promise((resolve) => {
      for (const choice of choices) {
        this.pendingApprovals.set(`${id}:${choice}`, () => {
          for (const c of choices) {
            this.pendingApprovals.delete(`${id}:${c}`);
          }
          resolve(choice);
        });
      }

      setTimeout(() => {
        for (const choice of choices) {
          this.pendingApprovals.delete(`${id}:${choice}`);
        }
        resolve(choices[0]);
      }, 120_000);
    });
  }

  async sendToolFeedback(toolName: string, args: Record<string, any>, targetId?: string): Promise<void> {
    const key = targetId || 'notification';
    const step = (this.stepCounters.get(key) || 0) + 1;
    this.stepCounters.set(key, step);
    const label = formatToolStep(toolName, args);

    const history = this.stepHistory.get(key) || [];
    const recentHistory = history.slice(-5);
    const blocks = this.buildStatusBlocks(step, recentHistory, label);
    await this.updateStatusMessage(blocks, targetId);

    if (step === PIN_STEP_THRESHOLD) {
      await this.pinStatusMessage(targetId);
    }
  }

  async sendStepDone(toolName: string, result: unknown, targetId?: string): Promise<void> {
    const key = targetId || 'notification';
    const step = this.stepCounters.get(key) || 0;
    const summary = formatToolResult(toolName, result);
    const label = formatToolStep(toolName, {} as any);
    const doneLine = summary ? `${label} - ${summary}` : label;

    const history = this.stepHistory.get(key) || [];
    history.push(doneLine);
    this.stepHistory.set(key, history);

    const recentHistory = history.slice(-5);
    const blocks = this.buildStatusBlocks(step, recentHistory);
    await this.updateStatusMessage(blocks, targetId);
  }

  async sendCompletion(elapsedMs: number, stepCount: number, targetId?: string, meta?: { provider: string; model: string; inputTokens: number; outputTokens: number; totalTokens: number; budgetUsed: number; budgetTotal: number; budgetPercentage: number }): Promise<void> {
    const secs = Math.floor(elapsedMs / 1000);
    const mins = Math.floor(secs / 60);
    const remSecs = secs % 60;
    const timeStr = mins > 0 ? `${mins}m ${remSecs}s` : `${secs}s`;
    const stepsStr = stepCount > 0 ? `${stepCount} step${stepCount !== 1 ? 's' : ''}` : '';
    const parts = [stepsStr, timeStr].filter(Boolean).join(' - ');

    const key = targetId || 'notification';
    const { channelId, threadTs } = this.resolveTarget(targetId);

    await this.deleteStatusMessage(targetId);
    await this.cleanupEphemeralMessages(targetId);
    this.endTask(targetId);

    const deferred = this.deferredResponses.get(key);
    if (deferred && deferred.trim()) {
      this.deferredResponses.delete(key);
      const deferredMd = mdToSlack(deferred);
      const chunks = this.splitMessage(deferredMd, MAX_MESSAGE_LENGTH);
      for (const chunk of chunks) {
        try {
          await this.app?.client.chat.postMessage({
            channel: channelId,
            text: chunk,
            thread_ts: threadTs || undefined,
            unfurl_links: false,
            unfurl_media: false,
          });
        } catch {
          // send failed
        }
      }
    }

    const completionBlocks: any[] = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Task complete* (${parts})` },
      },
    ];

    if (meta) {
      const formatTokens = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
      const pct = Math.round(meta.budgetPercentage);
      const barLen = 15;
      const filled = Math.round((pct / 100) * barLen);
      const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(barLen - filled);
      completionBlocks.push({
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Model:* ${meta.model} via ${meta.provider}` },
          { type: 'mrkdwn', text: `*Tokens:* ${formatTokens(meta.totalTokens)}` },
          { type: 'mrkdwn', text: `*Budget:* ${bar} ${pct}%` },
        ],
      });
    }

    const history = this.stepHistory.get(key) || [];
    const recentHistory = history.slice(-5);
    if (recentHistory.length > 0) {
      completionBlocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*Steps:*\n${recentHistory.map(h => `\u2713 ${h}`).join('\n')}` },
      });
    }

    try {
      await this.app?.client.chat.postMessage({
        channel: channelId,
        text: `Task complete (${parts})`,
        thread_ts: threadTs || undefined,
        blocks: completionBlocks,
      });
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Slack sendCompletion failed');
    }

    if (this.config.channels.slack.reactions) {
      const orig = this.originalMessageTs.get(key);
      if (orig && this.app) {
        try {
          await this.app.client.reactions.add({
            channel: orig.channelId,
            timestamp: orig.ts,
            name: 'white_check_mark',
          });
        } catch {
          // reaction failed
        }
      }
    }

    this.stepCounters.delete(key);
    this.stepHistory.delete(key);
    this.statusNotices.delete(key);
  }

  resetStepCounter(targetId?: string): void {
    const key = targetId || 'notification';
    this.stepCounters.delete(key);
    this.stepHistory.delete(key);
    this.statusNotices.delete(key);
    this.endTask(targetId);
    this.deleteStatusMessage(targetId);
    this.originalMessageTs.delete(key);
  }

  async cleanupEphemeralMessages(targetId?: string): Promise<void> {
    if (!this.app) return;
    const key = targetId || 'notification';
    const tsList = this.ephemeralMessageTs.get(key) || [];
    const { channelId } = this.resolveTarget(targetId);
    for (const ts of tsList) {
      this.deleteMessage(channelId, ts);
    }
    this.ephemeralMessageTs.delete(key);
  }

  // ─── Private helpers ───────────────────────────────────────

  private buildStatusBlocks(step: number, history: string[], current?: string): any[] {
    const blocks: any[] = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Mercury working* (step ${step})` },
      },
    ];

    if (history.length > 0) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*Completed:*\n${history.slice(-5).map(h => `\u2705 ${h}`).join('\n')}` },
      });
    }
    if (current) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*Current:* \u23f3 ${current}...` },
      });
    }
    return blocks;
  }

  private async updateStatusMessage(blocks: any[], targetId?: string): Promise<void> {
    const { channelId, threadTs } = this.resolveTarget(targetId);
    if (!channelId || !this.app) return;

    const key = targetId || 'notification';
    const existingTs = this.statusMessageTs.get(key);

    if (existingTs) {
      try {
        await this.app.client.chat.update({
          channel: channelId,
          ts: existingTs,
          text: `Mercury working...`,
          blocks,
        });
        return;
      } catch {
        this.statusMessageTs.delete(key);
      }
    }

    try {
      const result = await this.app.client.chat.postMessage({
        channel: channelId,
        text: 'Mercury working...',
        thread_ts: threadTs || undefined,
        blocks,
      });
      this.statusMessageTs.set(key, result.ts as string);
    } catch (err: any) {
      logger.warn({ err: err.message, channelId }, 'Failed to send Slack status message');
    }
  }

  private async deleteStatusMessage(targetId?: string): Promise<void> {
    if (!this.app) return;
    const key = targetId || 'notification';
    const ts = this.statusMessageTs.get(key);
    if (!ts) return;

    await this.unpinStatusMessage(targetId);
    const { channelId } = this.resolveTarget(targetId);
    this.deleteMessage(channelId, ts);
    this.statusMessageTs.delete(key);
  }

  private async pinStatusMessage(targetId?: string): Promise<void> {
    if (!this.app) return;
    const key = targetId || 'notification';
    const ts = this.statusMessageTs.get(key);
    if (!ts) return;

    const { channelId } = this.resolveTarget(targetId);

    const existingPin = this.pinnedMessageTs.get(key);
    if (existingPin && existingPin !== ts) {
      await this.app.client.pins.remove({ channel: channelId, timestamp: existingPin }).catch(() => {});
      this.pinnedMessageTs.delete(key);
    }

    if (existingPin === ts) return;

    try {
      await this.app.client.pins.add({ channel: channelId, timestamp: ts });
      this.pinnedMessageTs.set(key, ts);
      logger.info({ channelId, ts }, 'Pinned Slack status message');
    } catch (err: any) {
      logger.warn({ err: err.message, channelId }, 'Failed to pin Slack status message');
    }
  }

  private async unpinStatusMessage(targetId?: string): Promise<void> {
    if (!this.app) return;
    const key = targetId || 'notification';
    const ts = this.pinnedMessageTs.get(key);
    if (!ts) return;

    const { channelId } = this.resolveTarget(targetId);
    await this.app.client.pins.remove({ channel: channelId, timestamp: ts }).catch(() => {});
    this.pinnedMessageTs.delete(key);
  }

  private async refreshStatusCard(targetId?: string): Promise<void> {
    const key = targetId || 'notification';
    const step = this.stepCounters.get(key) || 0;
    const history = this.stepHistory.get(key) || [];
    const notices = this.statusNotices.get(key) || [];

    const recentHistory = history.slice(-5);
    const recentNotices = notices.slice(-3);

    const blocks: any[] = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Mercury working* (step ${step})` },
      },
    ];

    if (recentHistory.length > 0) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*Completed:*\n${recentHistory.map(h => `\u2705 ${h}`).join('\n')}` },
      });
    }

    if (recentNotices.length > 0) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*Notices:*\n${recentNotices.map(n => `\u2139 ${n}`).join('\n')}` },
      });
    }

    await this.updateStatusMessage(blocks, targetId);
  }

  private async handleAccessRequest(
    userId: string,
    channelId: string,
    username: string,
    threadTs: string,
    client: any,
  ): Promise<void> {
    logger.info({ userId, username, channelId }, 'Slack access request received');
    this.reloadConfig();
    const approvedUser = findSlackApprovedUser(this.config, userId);
    if (approvedUser) {
      const role = this.isAdminUser(userId) ? 'admin' : 'member';
      await this.sendToChannel(channelId, threadTs, client, `You are already approved as a Slack ${role}.\n\nSlack access: ${getSlackAccessSummary(this.config)}`);
      return;
    }

    const existingRequest = findSlackPendingRequest(this.config, userId);
    if (existingRequest) {
      const msg = this.getPendingStatusMessage(existingRequest);
      await this.sendToChannel(channelId, threadTs, client, msg);
      return;
    }

    if (!hasSlackAdmins(this.config) && this.config.channels.slack.pending.length > 0) {
      await this.sendToChannel(channelId, threadTs, client, 'Initial Slack pairing is already in progress for another user.');
      return;
    }

    const request = addSlackPendingRequest(this.config, {
      id: userId,
      username,
      channelId,
      teamId: this.teamId,
      pairingCode: hasSlackAdmins(this.config) ? undefined : this.generatePairingCode(),
    });
    saveConfig(this.config);
    logger.info({ userId, username, channelId }, 'Slack access request recorded');

    const msg = this.getPendingStatusMessage(request);
    await this.sendToChannel(channelId, threadTs, client, msg);

    if (hasSlackAdmins(this.config)) {
      await this.notifyAdminsOfPendingRequest(request);
    }
  }

  private async notifyAdminsOfPendingRequest(request: SlackPendingRequest): Promise<void> {
    if (!this.app) return;

    const usernameStr = request.username ? ` (${request.username})` : '';
    const blocks: any[] = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Slack access request pending approval.*\nUser ID: ${request.id}${usernameStr}\nRequested: ${new Date(request.requestedAt).toLocaleString()}` },
      },
      {
        type: 'actions',
        elements: [
          { type: 'button', text: { type: 'plain_text', text: 'Approve' }, action_id: `${ACCESS_ACTION_PREFIX}:approve:${request.id}`, style: 'primary' },
          { type: 'button', text: { type: 'plain_text', text: 'Reject' }, action_id: `${ACCESS_ACTION_PREFIX}:reject:${request.id}`, style: 'danger' },
        ],
      },
    ];

    for (const admin of getSlackAdmins(this.config)) {
      try {
        await this.app.client.chat.postMessage({
          channel: admin.id,
          text: 'Slack access request pending approval.',
          blocks,
        });
      } catch (err: any) {
        logger.warn({ err: err.message, adminId: admin.id }, 'Failed to notify Slack admin via DM');
      }
    }
  }

  private async handleAccessBlockAction(action: any, body: any, respond: any): Promise<void> {
    const actorUserId = body.user?.id;
    if (!actorUserId || !this.isAdminUser(actorUserId)) {
      await respond({ text: 'Admins only', replace_original: false, response_type: 'ephemeral' });
      return;
    }

    const actionId: string = action.action_id || '';
    const parts = actionId.split(':');
    if (parts.length < 3) return;

    const [, act, rawUserId] = parts;
    if (!rawUserId) return;

    const request = findSlackPendingRequest(this.config, rawUserId);
    if (!request) {
      await respond({ text: 'Already handled', replace_original: true });
      return;
    }

    if (act === 'approve') {
      const approved = approveSlackPendingRequest(this.config, rawUserId, 'member');
      if (!approved) {
        await respond({ text: 'Already handled', replace_original: true });
        return;
      }
      saveConfig(this.config);
      await respond({ text: `Approved Slack access for ${request.username || request.id}.`, replace_original: true });

      if (request.channelId && this.app) {
        try {
          await this.app.client.chat.postMessage({
            channel: request.channelId,
            text: `Slack access approved. You can now chat with Mercury.\n\nSlack access: ${getSlackAccessSummary(this.config)}`,
          });
        } catch {
          // notify failed
        }
      }
      return;
    }

    if (act === 'reject') {
      const rejected = rejectSlackPendingRequest(this.config, rawUserId);
      if (!rejected) {
        await respond({ text: 'Already handled', replace_original: true });
        return;
      }
      saveConfig(this.config);
      await respond({ text: `Rejected Slack access for ${request.username || request.id}.`, replace_original: true });

      if (request.channelId && this.app) {
        try {
          await this.app.client.chat.postMessage({
            channel: request.channelId,
            text: 'Your Slack access request was rejected.',
          });
        } catch {
          // notify failed
        }
      }
      return;
    }
  }

  private async handleMemoryBlockAction(action: any, body: any, client: any): Promise<void> {
    if (!this.app || !this.chatCommandContext) return;

    const actionId: string = action.action_id || '';
    const subAction = actionId.slice(`${MEMORY_ACTION_PREFIX}:`.length);
    const channelId = body.channel?.id;
    const messageTs = body.message?.ts;
    const threadTs = body.message?.thread_ts || messageTs;

    if (!channelId) return;

    if (subAction === 'overview') {
      const summary = this.chatCommandContext.memorySummary();
      const lines = [
        '*Memory Overview*',
        `Total memories: ${summary.total}`,
        `Learning: ${summary.learningPaused ? '⏸ PAUSED' : '✅ ACTIVE'}`,
      ];
      if (summary.profileSummary) {
        lines.push(`\n_Profile: ${summary.profileSummary}_`);
      }
      if (summary.activeSummary) {
        lines.push(`_Active: ${summary.activeSummary}_`);
      }
      const typeEntries = Object.entries(summary.byType);
      if (typeEntries.length > 0) {
        lines.push('\n*By type:*');
        for (const [type, count] of typeEntries) {
          lines.push(`  ${type}: ${count}`);
        }
      }
      try {
        await this.app.client.chat.postMessage({
          channel: channelId,
          text: lines.join('\n'),
          thread_ts: threadTs || undefined,
        });
      } catch {
        // send failed
      }
      return;
    }

    if (subAction === 'recent') {
      const recent = this.chatCommandContext.memoryRecent(10);
      if (recent.length === 0) {
        try {
          await this.app.client.chat.postMessage({
            channel: channelId,
            text: 'No memories yet.',
            thread_ts: threadTs || undefined,
          });
        } catch { /* */ }
        return;
      }
      const lines = ['*Recent Memories:*\n'];
      for (const r of recent) {
        const scope = r.scope === 'active' ? '⏳' : '📌';
        lines.push(`${scope} [${r.type}] ${r.summary}`);
        lines.push(`   Confidence: ${r.confidence.toFixed(2)} | Evidence: ${r.evidenceKind} | Seen: ${r.evidenceCount}x`);
      }
      try {
        await this.app.client.chat.postMessage({
          channel: channelId,
          text: lines.join('\n'),
          thread_ts: threadTs || undefined,
        });
      } catch {
        // send failed
      }
      return;
    }

    if (subAction === 'toggle_learning') {
      const currentSummary = this.chatCommandContext.memorySummary();
      const currentlyPaused = currentSummary.learningPaused;
      this.chatCommandContext.memorySetLearningPaused(!currentlyPaused);
      const msg = currentlyPaused
        ? 'Learning resumed. Mercury will remember new things from conversations.'
        : 'Learning paused. Mercury will not store new memories until resumed.';
      try {
        await this.app.client.chat.postMessage({
          channel: channelId,
          text: msg,
          thread_ts: threadTs || undefined,
        });
      } catch {
        // send failed
      }
      await this.sendMemoryKeyboard(channelId, threadTs, client);
      return;
    }

    if (subAction === 'clear_confirm') {
      const blocks: any[] = [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: '⚠️ Are you sure you want to clear *all* memories? This cannot be undone.' },
        },
        {
          type: 'actions',
          elements: [
            { type: 'button', text: { type: 'plain_text', text: '🗑 Yes, clear everything' }, action_id: `${MEMORY_ACTION_PREFIX}:clear_yes`, style: 'danger' },
            { type: 'button', text: { type: 'plain_text', text: '✖ Cancel' }, action_id: `${MEMORY_ACTION_PREFIX}:clear_no` },
          ],
        },
      ];
      try {
        await this.app.client.chat.postMessage({
          channel: channelId,
          text: '⚠️ Are you sure you want to clear all memories?',
          thread_ts: threadTs || undefined,
          blocks,
        });
      } catch {
        // send failed
      }
      return;
    }

    if (subAction === 'clear_yes') {
      const cleared = this.chatCommandContext.memoryClear();
      try {
        await this.app.client.chat.postMessage({
          channel: channelId,
          text: `Cleared ${cleared} memories.`,
          thread_ts: threadTs || undefined,
        });
      } catch {
        // send failed
      }
      return;
    }

    if (subAction === 'clear_no') {
      try {
        await this.app.client.chat.postMessage({
          channel: channelId,
          text: 'Clear cancelled.',
          thread_ts: threadTs || undefined,
        });
      } catch {
        // send failed
      }
      return;
    }
  }

  private async sendMemoryKeyboard(channelId: string, threadTs: string | undefined, client: any): Promise<void> {
    if (!this.app || !this.chatCommandContext) return;

    const summary = this.chatCommandContext.memorySummary();
    const lines = [
      '*Memory Overview*',
      `Total memories: ${summary.total}`,
      `Learning: ${summary.learningPaused ? '⏸ PAUSED' : '✅ ACTIVE'}`,
    ];
    if (summary.profileSummary) {
      lines.push(`\n_Profile: ${summary.profileSummary}_`);
    }
    const typeEntries = Object.entries(summary.byType);
    if (typeEntries.length > 0) {
      lines.push('\n*By type:*');
      for (const [type, count] of typeEntries) {
        lines.push(`  ${type}: ${count}`);
      }
    }

    const learningLabel = summary.learningPaused ? '▶ Resume' : '⏸ Pause';
    const blocks: any[] = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: lines.join('\n') },
      },
      {
        type: 'actions',
        elements: [
          { type: 'button', text: { type: 'plain_text', text: '📋 Overview' }, action_id: `${MEMORY_ACTION_PREFIX}:overview` },
          { type: 'button', text: { type: 'plain_text', text: '🔍 Recent' }, action_id: `${MEMORY_ACTION_PREFIX}:recent` },
          { type: 'button', text: { type: 'plain_text', text: learningLabel }, action_id: `${MEMORY_ACTION_PREFIX}:toggle_learning` },
          { type: 'button', text: { type: 'plain_text', text: '🗑 Clear All' }, action_id: `${MEMORY_ACTION_PREFIX}:clear_confirm`, style: 'danger' },
        ],
      },
    ];

    try {
      await this.app.client.chat.postMessage({
        channel: channelId,
        text: 'Memory Overview',
        thread_ts: threadTs || undefined,
        blocks,
      });
    } catch {
      // send failed
    }
  }

  private getPendingStatusMessage(request?: SlackPendingRequest): string {
    if (!hasSlackAdmins(this.config)) {
      const pairingCode = request?.pairingCode ?? 'unknown';
      return [
        'Your Slack pairing request has been recorded.',
        '',
        `Pairing code: \`${pairingCode}\``,
        '',
        'Enter this code in the Mercury terminal to finish setup.',
      ].join('\n');
    }
    return 'Your Slack access request has been recorded and is waiting for approval from a Slack admin.';
  }

  private isAdminUser(userId: string): boolean {
    return !!findSlackAdmin(this.config, userId);
  }

  private getCommandName(text: string): string {
    const stripped = text.replace(/<@[^>]+>/g, '').trim();
    return stripped.split(/\s+/)[0]?.toLowerCase() || '';
  }

  private generatePairingCode(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  private splitMessage(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      let splitAt = maxLen;
      if (remaining.length > maxLen) {
        const lastNewline = remaining.lastIndexOf('\n', maxLen);
        if (lastNewline > maxLen * 0.5) {
          splitAt = lastNewline + 1;
        }
      }
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt);
    }
    return chunks;
  }

  private async sendToChannel(channelId: string, threadTs: string | undefined, client: any, content: string): Promise<void> {
    const md = mdToSlack(content);
    const chunks = this.splitMessage(md, MAX_MESSAGE_LENGTH);
    for (const chunk of chunks) {
      try {
        if (this.app) {
          await this.app.client.chat.postMessage({
            channel: channelId,
            text: chunk,
            thread_ts: threadTs || undefined,
            unfurl_links: false,
            unfurl_media: false,
          });
        }
      } catch (err: any) {
        logger.error({ err: err.message, channelId }, 'Slack sendToChannel failed');
      }
    }
  }

  private resolveTarget(targetId?: string): { channelId: string; threadTs?: string } {
    if (!targetId || targetId === 'notification') {
      const ids = getSlackApprovedUserIds(this.config);
      return { channelId: ids[0] || '', threadTs: undefined };
    }

    if (targetId.startsWith('slack:')) {
      const parts = targetId.slice(6).split(':');
      return { channelId: parts[0], threadTs: parts[1] || undefined };
    }

    return { channelId: targetId, threadTs: undefined };
  }

  private findActiveTaskKey(channelId: string): string | undefined {
    for (const [key, active] of this.taskActive) {
      if (!active) continue;
      if (key === 'notification') return key;
      const chPart = key.startsWith('slack:') ? key.split(':')[1] : key;
      if (chPart === channelId) return key;
    }
    return undefined;
  }

  private async addReaction(channel: string, ts: string, name: string, client?: any): Promise<void> {
    if (!this.app) return;
    try {
      await this.app.client.reactions.add({ channel, timestamp: ts, name });
    } catch {
      // reaction may already exist or emoji may not be available
    }
  }

  private async deleteMessage(channelId: string, ts?: string): Promise<void> {
    if (!this.app || !ts) return;
    try {
      await this.app.client.chat.delete({ channel: channelId, ts });
    } catch {
      // message may already be deleted
    }
  }

  private trackEphemeral(targetId: string | undefined, ts: string): void {
    const key = targetId || 'notification';
    const list = this.ephemeralMessageTs.get(key) || [];
    list.push(ts);
    this.ephemeralMessageTs.set(key, list);
  }

  async reactError(targetId?: string): Promise<void> {
    const key = targetId || 'notification';
    const orig = this.originalMessageTs.get(key);
    if (orig && this.app) {
      try {
        await this.app.client.reactions.add({
          channel: orig.channelId,
          timestamp: orig.ts,
          name: 'x',
        });
      } catch {
        // reaction failed
      }
    }
  }

  async reactSuccess(targetId?: string): Promise<void> {
    const key = targetId || 'notification';
    const orig = this.originalMessageTs.get(key);
    if (orig && this.app) {
      try {
        await this.app.client.reactions.add({
          channel: orig.channelId,
          timestamp: orig.ts,
          name: 'white_check_mark',
        });
      } catch {
        // reaction failed
      }
    }
  }

  async sendFeedbackRequest(feedbackId: string, boardName: string, cardTask: string, question: string, options?: string[]): Promise<string | null> {
    if (!this.app) return null;

    const admin = this.getAdminUser();
    if (!admin) return null;

    const elements: any[] = [];
    if (options && options.length > 0) {
      for (const opt of options) {
        elements.push({
          type: 'button',
          text: { type: 'plain_text', text: opt.length > 75 ? opt.slice(0, 72) + '...' : opt },
          action_id: `feedback:${feedbackId}:${opt}`,
        });
      }
    }
    elements.push({
      type: 'button',
      text: { type: 'plain_text', text: 'Type custom response' },
      action_id: `feedback:${feedbackId}:__custom__`,
    });

    const blocks: any[] = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `\uD83D\uDD14 *Feedback Required*\n\n*Board:* ${boardName}\n*Card:* ${cardTask}\n\n${question}` },
      },
      { type: 'actions', elements },
    ];

    try {
      await this.app.client.chat.postMessage({
        channel: admin.id,
        text: 'Feedback Required',
        blocks,
      });
    } catch {
      return null;
    }
    return null;
  }

  private getAdminUser(): { id: string } | null {
    if (this.config.channels.slack.admins.length === 0) return null;
    return { id: this.config.channels.slack.admins[0].id };
  }
}