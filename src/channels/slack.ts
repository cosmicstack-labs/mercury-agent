import fs from 'node:fs';
import path from 'node:path';
import { App } from '@slack/bolt';
import type { ChannelMessage } from '../types/channel.js';
import { BaseChannel, type PermissionMode } from './base.js';
import type { MercuryConfig } from '../utils/config.js';
import type { SlackAccessUser } from '../types/channel.js';
import {
  addSlackPendingRequest,
  approveSlackPendingRequest,
  findSlackAdmin,
  findSlackApprovedUser,
  findSlackPendingRequest,
  getSlackAccessSummary,
  getSlackAdmins,
  hasSlackAdmins,
  rejectSlackPendingRequest,
  removeSlackUser,
  saveConfig,
} from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { mdToSlack } from '../utils/markdown.js';
import { formatToolStep, formatToolResult } from '../utils/tool-label.js';

const SLACK_DM_PREFIX = 'slack:dm';
const SLACK_CHANNEL_PREFIX = 'slack';

type ApprovalResolver = () => void;

export class SlackChannel extends BaseChannel {
  readonly type = 'slack' as const;
  private app: App | null = null;
  private lastActiveChannelId: string | null = null;
  private chatCommandContext?: import('../capabilities/registry.js').ChatCommandContext;
  private pendingApprovals: Map<string, ApprovalResolver> = new Map();
  private permissionModes = new Map<string, PermissionMode>();
  private onPermissionMode?: (mode: PermissionMode, channelId: string) => void;

  private statusMessageIds = new Map<string, string>();
  private statusMessageChannels = new Map<string, string>();
  private stepCounters = new Map<string, number>();
  private stepHistory = new Map<string, string[]>();
  private taskActive = new Map<string, boolean>();
  private deferredResponses = new Map<string, string>();
  private statusNotices = new Map<string, string[]>();
  private static readonly MAX_STATUS_NOTICES = 3;

  private userLastMessageTime = new Map<string, number>();
  private static readonly USER_RATE_LIMIT_MS = 30_000;
  private static readonly BUSY_COOLDOWN_MS = 15_000;
  private lastBusyReplyTime = new Map<string, number>();

  private lastMessageMetadata: { isDM: boolean; isAdmin: boolean } | null = null;

  constructor(private config: MercuryConfig) {
    super();
  }

  setChatCommandContext(ctx: import('../capabilities/registry.js').ChatCommandContext): void {
    this.chatCommandContext = ctx;
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
    return this.deferredResponses.get(key);
  }

  resetStepCounter(targetId?: string): void {
    const key = targetId || 'notification';
    this.stepCounters.delete(key);
    this.stepHistory.delete(key);
    this.deleteStatusMessage(key);
  }

  setOnPermissionMode(fn: (mode: PermissionMode, channelId: string) => void): void {
    this.onPermissionMode = fn;
  }

  async start(): Promise<void> {
    const slackConfig = this.config.channels.slack;
    if (!slackConfig.botToken || !slackConfig.appToken) {
      throw new Error('Slack bot token and app token are required');
    }

    this.app = new App({
      token: slackConfig.botToken,
      socketMode: true,
      appToken: slackConfig.appToken,
    });

    this.registerHandlers();

    await this.app.start();
    this.ready = true;
    logger.info('Slack channel started (Socket Mode)');
  }

  async stop(): Promise<void> {
    if (this.app) {
      await this.app.stop();
      this.app = null;
    }
    this.ready = false;
  }

  private registerHandlers(): void {
    if (!this.app) return;

    this.app.event('message', async ({ payload }) => {
      const msg = payload as any;
      if (msg.bot_id || msg.subtype) return;

      const userId = msg.user;
      if (!userId) return;

      const channelId = msg.channel;
      if (!channelId.startsWith('D')) return;

      await this.handleDMMessage(msg);
    });

    this.app.event('app_mention', async ({ payload }) => {
      const userId = payload.user;
      if (!userId) return;

      const channelId = payload.channel;
      if (this.config.channels.slack.channelId && channelId !== this.config.channels.slack.channelId) {
        return;
      }

      const text = (payload.text || '').replace(/<@[^>]+>\s*/, '').trim();
      if (!text) return;

      const isAdmin = !!findSlackAdmin(this.config, userId);

      if (!isAdmin) {
        const now = Date.now();
        const lastTime = this.userLastMessageTime.get(userId) || 0;
        if (now - lastTime < SlackChannel.USER_RATE_LIMIT_MS) {
          const remaining = Math.ceil((SlackChannel.USER_RATE_LIMIT_MS - (now - lastTime)) / 1000);
          await this.sendEphemeral(channelId, userId, `Please wait ${remaining}s before sending another message.`);
          return;
        }
        this.userLastMessageTime.set(userId, now);
      }

      this.lastActiveChannelId = channelId;
      this.lastMessageMetadata = { isDM: false, isAdmin };

      if (!this.permissionModes.has(channelId)) {
      this.askPermissionMode(channelId).catch(() => {});
        this.permissionModes.set(channelId, 'ask-me');
      }

      this.emit({
        id: payload.ts,
        channelId: `slack:${channelId}`,
        channelType: 'slack',
        senderId: userId,
        senderName: payload.user,
        content: text,
        timestamp: Math.floor(parseFloat(payload.ts) * 1000),
        metadata: { slackChannelId: channelId, isDM: false, isAdmin },
      });
    });

    this.app.action(/^(slack_perm_|slack_loop_|slack_mode_|slack_access:)/, async ({ ack, body, client }) => {
      await ack();
      if (body.type !== 'block_actions') return;
      const action = (body as any).actions?.[0];
      if (!action) return;

      const actionId: string = action.action_id || action.actionId || '';
      const userId = body.user.id;
      const channel = (body as any).channel?.id;
      const messageTs = (body as any).message?.ts;

      if (actionId.startsWith('slack_access:')) {
        await this.handleAccessButton(actionId, userId, channel, client);
        return;
      }

      const resolver = this.pendingApprovals.get(actionId);
      if (resolver) {
        this.pendingApprovals.delete(actionId);
        for (const suffix of [':yes', ':always', ':no', ':ask-me', ':allow-all']) {
          this.pendingApprovals.delete(actionId.replace(/:(yes|always|no|ask-me|allow-all)$/, suffix));
        }
        resolver();

        if (messageTs && channel) {
          try {
            await client.chat.delete({ channel, ts: messageTs });
          } catch {}
        }
      } else {
        try {
          await client.chat.postEphemeral({
            channel: channel || body.user.id,
            user: userId,
            text: '_This action has expired._',
          });
        } catch {}
      }
    });

    this.app.command('/mercury', async ({ command, ack, client }) => {
      await ack();
      const userId = command.user_id;
      const channelId = command.channel_id;
      const args = (command.text || '').trim();

      if (args === 'start' || args === 'pair') {
        await this.handleStartCommand(userId, channelId, client);
      } else {
        const isAdmin = !!findSlackAdmin(this.config, userId);
        const content = args ? `/mercury ${args}` : '/mercury';
        this.emit({
          id: `slack-cmd-${Date.now()}`,
          channelId: `slack:${channelId}`,
          channelType: 'slack',
          senderId: userId,
          senderName: command.user_name,
          content,
          timestamp: Date.now(),
          metadata: { slackChannelId: channelId, isDM: channelId.startsWith('D'), isAdmin },
        });
        try {
          await client.chat.postEphemeral({
            channel: channelId,
            user: userId,
            text: 'Command received.',
          });
        } catch {}
      }
    });
  }

  private async handleDMMessage(msg: any): Promise<void> {
    const userId = msg.user;
    if (!userId) return;
    const channelId = msg.channel;
    const text = (msg.text || '').replace(/<@[^>]+>\s*/, '').trim();

    if (text === '/start' || text === '/pair' || text === '/mercury start') {
      await this.handleStartCommand(userId, channelId, this.app!.client);
      return;
    }

    if (text === '/unpair') {
      const isAdmin = !!findSlackAdmin(this.config, userId);
      if (isAdmin) {
        const { clearSlackAccess } = await import('../utils/config.js');
        clearSlackAccess(this.config);
        saveConfig(this.config);
        await this.sendDM(userId, 'All Slack access data has been reset.');
      }
      return;
    }

    const isApproved = !!findSlackApprovedUser(this.config, userId);
    if (!isApproved) {
      const existing = findSlackPendingRequest(this.config, userId);
      if (existing) {
        await this.sendDM(userId, 'Your access request is pending. An admin will approve it shortly.');
      } else {
        await this.sendDM(userId, 'You are not authorized. Send `/mercury start` to request access.');
      }
      return;
    }

    const isAdmin = !!findSlackAdmin(this.config, userId);
    this.lastActiveChannelId = channelId;
    this.lastMessageMetadata = { isDM: true, isAdmin };

    this.emit({
      id: msg.ts,
      channelId: `slack:dm:${userId}`,
      channelType: 'slack',
      senderId: userId,
      senderName: msg.user,
      content: text,
      timestamp: Math.floor(parseFloat(msg.ts) * 1000),
      metadata: { slackChannelId: channelId, isDM: true, isAdmin },
    });
  }

  private async handleStartCommand(userId: string, channelId: string, client: any): Promise<void> {
    const existingApproved = findSlackApprovedUser(this.config, userId);
    if (existingApproved) {
      const role = findSlackAdmin(this.config, userId) ? 'admin' : 'member';
      await this.sendDM(userId, `You are already authorized as a ${role}.`);
      return;
    }

    const existingPending = findSlackPendingRequest(this.config, userId);
    if (existingPending) {
      await this.sendDM(userId, 'You already have a pending request. An admin will approve it shortly.');
      return;
    }

    if (!hasSlackAdmins(this.config)) {
      const approved = approveSlackPendingRequest(this.config, userId, 'admin');
      if (!approved) {
        addSlackPendingRequest(this.config, { userId });
        const approvedAgain = approveSlackPendingRequest(this.config, userId, 'admin');
        if (approvedAgain) {
          saveConfig(this.config);
        }
      } else {
        saveConfig(this.config);
      }
      await this.sendDM(userId, ':white_check_mark: You have been approved as the *first admin*! You can now message Mercury.');
      return;
    }

    addSlackPendingRequest(this.config, { userId });
    saveConfig(this.config);

    const admins = getSlackAdmins(this.config);
    for (const admin of admins) {
      try {
        await client.chat.postMessage({
          channel: admin.userId,
          text: `:bell: New Slack access request from <@${userId}>`,
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: `:bell: *New Slack access request*\nFrom: <@${userId}>` } },
            { type: 'actions', elements: [
              { type: 'button', text: { type: 'plain_text', text: 'Approve as Admin' }, action_id: `slack_access:approve_admin:${userId}`, style: 'primary' },
              { type: 'button', text: { type: 'plain_text', text: 'Approve as Member' }, action_id: `slack_access:approve_member:${userId}` },
              { type: 'button', text: { type: 'plain_text', text: 'Reject' }, action_id: `slack_access:reject:${userId}`, style: 'danger' },
            ] },
          ],
        });
      } catch (e) {
        logger.warn({ err: e, adminId: admin.userId }, 'Failed to notify Slack admin');
      }
    }
    await this.sendDM(userId, 'Your access request has been sent to the admins. You will be notified when approved.');
  }

  private async handleAccessButton(actionId: string, clickedByUserId: string, channelId: string | undefined, client: any): Promise<void> {
    const parts = actionId.split(':');
    if (parts.length < 3) return;
    const action = parts[1];
    const targetUserId = parts.slice(2).join(':');

    const isAdmin = !!findSlackAdmin(this.config, clickedByUserId);
    if (!isAdmin) {
      if (channelId) {
        await client.chat.postEphemeral({ channel: channelId, user: clickedByUserId, text: 'Only admins can approve access requests.' });
      }
      return;
    }

    if (action === 'approve_admin') {
      const approved = approveSlackPendingRequest(this.config, targetUserId, 'admin');
      if (approved) {
        saveConfig(this.config);
        await this.sendDM(targetUserId, `:white_check_mark: You have been approved as an *admin*! You can now message Mercury.`);
      }
    } else if (action === 'approve_member') {
      const approved = approveSlackPendingRequest(this.config, targetUserId, 'member');
      if (approved) {
        saveConfig(this.config);
        await this.sendDM(targetUserId, `:white_check_mark: You have been approved as a *member*! You can now message Mercury.`);
      }
    } else if (action === 'reject') {
      rejectSlackPendingRequest(this.config, targetUserId);
      saveConfig(this.config);
      await this.sendDM(targetUserId, 'Your access request has been declined.');
    }
  }

  async send(content: string, targetId?: string, _elapsedMs?: number): Promise<void> {
    const channel = this.resolveTargetChannel(targetId);
    if (!channel) return;

    const key = targetId || 'notification';

    if (this.isTaskActive(targetId)) {
      this.deferredResponses.set(key, content);
      return;
    }

    const converted = mdToSlack(content);
    const chunks = this.splitMessage(converted);

    for (const chunk of chunks) {
      try {
        await this.app!.client.chat.postMessage({
          channel,
          text: chunk,
          unfurl_links: false,
          unfurl_media: false,
        });
      } catch (e) {
        logger.warn({ err: e }, 'Slack send failed');
      }
    }
  }

  async sendFile(filePath: string, targetId?: string): Promise<void> {
    const channel = this.resolveTargetChannel(targetId);
    if (!channel) return;

    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      await this.send(`File not found: ${filePath}`, targetId);
      return;
    }

    const filename = path.basename(resolved);
    const stat = fs.statSync(resolved);

    try {
      const uploadUrlResult = await this.app!.client.files.getUploadURLExternal({
        filename,
        length: stat.size,
      });

      const uploadUrl = (uploadUrlResult as any).upload_url;
      const fileId = (uploadUrlResult as any).file_id;

      const fileBuffer = fs.readFileSync(resolved);
      const response = await fetch(uploadUrl, {
        method: 'POST',
        body: fileBuffer,
        headers: { 'Content-Type': 'application/octet-stream' },
      });

      if (!response.ok) {
        throw new Error(`Upload failed: ${response.status}`);
      }

      await this.app!.client.files.completeUploadExternal({
        files: [{ id: fileId }],
        channel_id: channel,
        initial_comment: `📄 ${filename}`,
      });
    } catch (e) {
      logger.warn({ err: e }, 'Slack file upload failed');
      await this.send(`Failed to send file: ${(e as Error).message}`, targetId);
    }
  }

  async stream(content: AsyncIterable<string>, targetId?: string): Promise<string> {
    const key = targetId || 'notification';

    if (this.isTaskActive(targetId)) {
      let full = '';
      for await (const chunk of content) {
        full += chunk;
      }
      this.deferredResponses.set(key, full);
      return full;
    }

    if (!this.config.channels.slack.streaming) {
      let full = '';
      for await (const chunk of content) {
        full += chunk;
      }
      await this.send(full, targetId);
      return full;
    }

    const channel = this.resolveTargetChannel(targetId);
    if (!channel) {
      let full = '';
      for await (const chunk of content) { full += chunk; }
      return full;
    }

    this.deleteStatusMessage(key);

    let full = '';
    let streamTs: string | null = null;
    let lastEditTime = 0;
    const STREAM_MIN_LENGTH = 20;
    const STREAM_EDIT_INTERVAL = 2000;

    for await (const chunk of content) {
      full += chunk;
      const now = Date.now();

      if (!streamTs && full.length >= STREAM_MIN_LENGTH) {
        try {
          const threadTs = this.lastMessageTs;
          const postArgs: any = {
            channel,
            text: mdToSlack(full) + ' ▌',
            unfurl_links: false,
            unfurl_media: false,
          };
          if (threadTs) {
            postArgs.thread_ts = threadTs;
          }
          const result = await this.app!.client.chat.postMessage(postArgs);
          streamTs = (result as any).ts;
          lastEditTime = now;
        } catch (e) {
          logger.warn({ err: e }, 'Slack stream initial post failed');
        }
      } else if (streamTs && now - lastEditTime >= STREAM_EDIT_INTERVAL) {
        try {
          await this.app!.client.chat.update({
            channel,
            ts: streamTs,
            text: mdToSlack(full) + ' ▌',
          });
          lastEditTime = now;
        } catch (e) {
          // edit failed, may be rate limited
        }
      }
    }

    if (streamTs) {
      const finalChunks = this.splitMessage(mdToSlack(full));
      if (finalChunks.length <= 1) {
        try {
          await this.app!.client.chat.update({
            channel,
            ts: streamTs,
            text: mdToSlack(full),
          });
        } catch (e) {
          logger.warn({ err: e }, 'Slack stream final update failed');
        }
      } else {
        try {
          await this.app!.client.chat.delete({ channel, ts: streamTs });
        } catch {}
        for (const c of finalChunks) {
          try {
            const threadTs = this.lastMessageTs;
            const postArgs: any = { channel, text: c, unfurl_links: false, unfurl_media: false };
            if (threadTs) { postArgs.thread_ts = threadTs; }
            await this.app!.client.chat.postMessage(postArgs);
          } catch (e) {
            logger.warn({ err: e }, 'Slack stream chunk send failed');
          }
        }
      }
    } else {
      const chunks = this.splitMessage(mdToSlack(full));
      for (const c of chunks) {
        try {
          const threadTs = this.lastMessageTs;
          const postArgs: any = { channel, text: c, unfurl_links: false, unfurl_media: false };
          if (threadTs) { postArgs.thread_ts = threadTs; }
          await this.app!.client.chat.postMessage(postArgs);
        } catch (e) {
          logger.warn({ err: e }, 'Slack stream fallback send failed');
        }
      }
    }

    return full;
  }

  async typing(_targetId?: string): Promise<void> {
    // Slack has no direct typing indicator; handled via "Thinking..." in stream
  }

  async askPermission(prompt: string, targetId?: string): Promise<string> {
    const channel = this.resolveTargetChannel(targetId);
    if (!channel) return 'no';

    const id = `slack_perm_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const isDM = targetId?.startsWith(SLACK_DM_PREFIX);
    const isAdmin = this.lastMessageMetadata?.isAdmin ?? false;

    if (isDM || isAdmin) {
      return new Promise<string>((resolve) => {
        for (const suffix of [':yes', ':always', ':no']) {
          this.pendingApprovals.set(`${id}${suffix}`, () => resolve(suffix.slice(1)));
        }

        const blocks: any[] = [
          { type: 'section', text: { type: 'mrkdwn', text: mdToSlack(prompt) } },
          { type: 'actions', elements: [
            { type: 'button', text: { type: 'plain_text', text: 'Allow' }, action_id: `${id}:yes`, style: 'primary' },
            { type: 'button', text: { type: 'plain_text', text: 'Always' }, action_id: `${id}:always` },
            { type: 'button', text: { type: 'plain_text', text: 'Deny' }, action_id: `${id}:no`, style: 'danger' },
          ] },
        ];

        this.app!.client.chat.postMessage({ channel, blocks, text: mdToSlack(prompt) }).catch(() => {});

        setTimeout(() => {
          for (const suffix of [':yes', ':always', ':no']) {
            this.pendingApprovals.delete(`${id}${suffix}`);
          }
          resolve('no');
        }, 120_000);
      });
    }

    return 'no';
  }

  async askToContinue(question: string, targetId?: string): Promise<boolean> {
    const channel = this.resolveTargetChannel(targetId);
    if (!channel) return false;

    const id = `slack_loop_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    return new Promise<boolean>((resolve) => {
      this.pendingApprovals.set(`${id}:yes`, () => resolve(true));
      this.pendingApprovals.set(`${id}:no`, () => resolve(false));

      const blocks: any[] = [
        { type: 'section', text: { type: 'mrkdwn', text: mdToSlack(question) } },
        { type: 'actions', elements: [
          { type: 'button', text: { type: 'plain_text', text: 'Continue' }, action_id: `${id}:yes`, style: 'primary' },
          { type: 'button', text: { type: 'plain_text', text: 'Stop' }, action_id: `${id}:no`, style: 'danger' },
        ] },
      ];

      this.app!.client.chat.postMessage({ channel, blocks, text: mdToSlack(question) }).catch(() => {});

      setTimeout(() => {
        this.pendingApprovals.delete(`${id}:yes`);
        this.pendingApprovals.delete(`${id}:no`);
        resolve(false);
      }, 120_000);
    });
  }

  async askPermissionMode(targetId?: string): Promise<PermissionMode> {
    const userId = this.lastMessageMetadata?.isDM
      ? targetId?.replace('slack:dm:', '')
      : undefined;

    if (!userId) return 'ask-me';

    const channel = this.resolveTargetChannel(targetId);
    if (!channel) return 'ask-me';

    const id = `slack_mode_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    return new Promise<PermissionMode>((resolve) => {
      this.pendingApprovals.set(`${id}:ask-me`, () => resolve('ask-me'));
      this.pendingApprovals.set(`${id}:allow-all`, () => resolve('allow-all'));

      const blocks: any[] = [
        { type: 'section', text: { type: 'mrkdwn', text: '*Permission Mode*\nHow should Mercury handle risky actions this session?\n\n:lock: *Ask Me* — confirm before file writes, commands, and scope changes\n:white_check_mark: *Allow All* — auto-approve everything' } },
        { type: 'actions', elements: [
          { type: 'button', text: { type: 'plain_text', text: ':lock: Ask Me' }, action_id: `${id}:ask-me` },
          { type: 'button', text: { type: 'plain_text', text: ':white_check_mark: Allow All' }, action_id: `${id}:allow-all`, style: 'primary' },
        ] },
      ];

      this.app!.client.chat.postMessage({ channel, blocks, text: 'Permission Mode' }).catch(() => {});

      setTimeout(() => {
        this.pendingApprovals.delete(`${id}:ask-me`);
        this.pendingApprovals.delete(`${id}:allow-all`);
        resolve('ask-me');
      }, 120_000);
    });
  }

  async sendToolFeedback(toolName: string, args: Record<string, any>, targetId?: string): Promise<void> {
    const key = targetId || 'notification';
    const counter = (this.stepCounters.get(key) || 0) + 1;
    this.stepCounters.set(key, counter);

    const label = formatToolStep(toolName, args);
    const history = this.stepHistory.get(key) || [];
    const recentHistory = history.slice(-5);

    const descriptionLines = [
      ...recentHistory.map((h) => `:white_check_mark: ${h}`),
      `:hourglass: ${label}…`,
    ];

    this.updateStatusBlock(key, `:gear: Mercury working (step ${counter})`, descriptionLines.join('\n'));
  }

  async sendStepDone(toolName: string, result: any, targetId?: string): Promise<void> {
    const key = targetId || 'notification';
    const counter = this.stepCounters.get(key) || 0;
    const label = formatToolStep(toolName, {});
    const summary = formatToolResult(toolName, result);
    const doneLine = summary ? `${label} · ${summary}` : label;

    const history = this.stepHistory.get(key) || [];
    history.push(doneLine);
    this.stepHistory.set(key, history);

    const recentHistory = history.slice(-5);
    const descriptionLines = recentHistory.map((h) => `:white_check_mark: ${h}`);

    this.updateStatusBlock(key, `:gear: Mercury working (${counter} steps done)`, descriptionLines.join('\n'));
  }

  async sendCompletion(elapsedMs: number, stepCount: number, targetId?: string, meta?: { provider?: string; model?: string; inputTokens?: number; outputTokens?: number; totalTokens?: number; budgetUsed?: number; budgetTotal?: number; budgetPercentage?: number }): Promise<void> {
    const key = targetId || 'notification';
    this.endTask(targetId);
    await this.deleteStatusMessage(key);

    const deferred = this.deferredResponses.get(key);
    if (deferred) {
      this.deferredResponses.delete(key);
      await this.send(deferred, targetId);
    }

    if (!meta || stepCount < 2) {
      this.resetStepCounter(targetId);
      return;
    }

    const channel = this.resolveTargetChannel(targetId);
    if (!channel) { this.resetStepCounter(targetId); return; }

    const seconds = (elapsedMs / 1000).toFixed(1);
    const fields: any[] = [
      { type: 'mrkdwn', text: `*Provider:* ${meta.provider || 'unknown'}` },
      { type: 'mrkdwn', text: `*Model:* ${meta.model || 'unknown'}` },
    ];

    if (meta.totalTokens) {
      fields.push({ type: 'mrkdwn', text: `*Tokens:* ${meta.totalTokens.toLocaleString()}` });
    }
    if (meta.budgetUsed !== undefined) {
      fields.push({ type: 'mrkdwn', text: `*Budget:* ${meta.budgetPercentage?.toFixed(1)}% used` });
    }

    try {
      await this.app!.client.chat.postMessage({
        channel,
        text: `:white_check_mark: *Done* — ${stepCount} steps in ${seconds}s`,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `:white_check_mark: *Done* — ${stepCount} steps in ${seconds}s` } },
          { type: 'section', fields: fields.map((f) => ({ type: 'mrkdwn', text: f.text })) },
        ],
        unfurl_links: false,
        unfurl_media: false,
      });
    } catch (e) {
      logger.warn({ err: e }, 'Slack sendCompletion failed');
    }

    this.resetStepCounter(targetId);
  }

  private async updateStatusBlock(key: string, title: string, description: string): Promise<void> {
    const channel = this.statusMessageChannels.get(key) || this.lastActiveChannelId || this.config.channels.slack.channelId;
    if (!channel) return;

    const existingTs = this.statusMessageIds.get(key);

    const blocks: any[] = [
      { type: 'section', text: { type: 'mrkdwn', text: `*${title}*\n${description}` } },
    ];

    if (existingTs) {
      try {
        await this.app!.client.chat.update({
          channel,
          ts: existingTs,
          blocks,
          text: title,
        });
        return;
      } catch {
        this.statusMessageIds.delete(key);
      }
    }

    try {
      const result = await this.app!.client.chat.postMessage({
        channel,
        blocks,
        text: title,
        unfurl_links: false,
        unfurl_media: false,
      });
      this.statusMessageIds.set(key, (result as any).ts);
      this.statusMessageChannels.set(key, channel);
    } catch (e) {
      logger.warn({ err: e }, 'Slack status block post failed');
    }
  }

  private async deleteStatusMessage(key: string): Promise<void> {
    const ts = this.statusMessageIds.get(key);
    const channel = this.statusMessageChannels.get(key);
    if (ts && channel) {
      try {
        await this.app!.client.chat.delete({ channel, ts });
      } catch {}
    }
    this.statusMessageIds.delete(key);
    this.statusMessageChannels.delete(key);
  }

  private async sendDM(userId: string, text: string): Promise<void> {
    try {
      const im = await this.app!.client.conversations.open({ users: userId });
      const dmChannel = (im as any).channel?.id;
      if (dmChannel) {
        await this.app!.client.chat.postMessage({ channel: dmChannel, text, unfurl_links: false, unfurl_media: false });
      }
    } catch (e) {
      logger.warn({ err: e, userId }, 'Slack sendDM failed');
    }
  }

  private async sendEphemeral(channel: string, userId: string, text: string): Promise<void> {
    try {
      await this.app!.client.chat.postEphemeral({ channel, user: userId, text });
    } catch (e) {
      logger.warn({ err: e }, 'Slack sendEphemeral failed');
    }
  }

  private resolveTargetChannel(targetId?: string): string | null {
    if (!targetId || targetId === 'notification') {
      return this.lastActiveChannelId || this.config.channels.slack.channelId || null;
    }

    if (targetId.startsWith(SLACK_DM_PREFIX)) {
      const userId = targetId.slice(SLACK_DM_PREFIX.length + 1);
      return userId;
    }

    if (targetId.startsWith('slack:')) {
      return targetId.slice(6);
    }

    return targetId;
  }

  private splitMessage(text: string, maxLength: number = 40000): string[] {
    if (text.length <= maxLength) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }

      let splitAt = remaining.lastIndexOf('\n', maxLength);
      if (splitAt <= 0) {
        splitAt = remaining.lastIndexOf(' ', maxLength);
      }
      if (splitAt <= 0) {
        splitAt = maxLength;
      }

      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trimStart();
    }

    return chunks;
  }

  private get lastMessageTs(): string | undefined {
    return this._lastMessageTs;
  }

  private _lastMessageTs: string | undefined;
}