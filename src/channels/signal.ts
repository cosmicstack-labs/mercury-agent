import fs from 'node:fs';
import path from 'node:path';
import type { ChannelMessage } from '../types/channel.js';
import { BaseChannel, type PermissionMode } from './base.js';
import type { MercuryConfig } from '../utils/config.js';
import {
  addSignalPendingRequest,
  approveSignalPendingRequestByPairingCode,
  clearSignalAccess,
  findSignalAdmin,
  findSignalApprovedUser,
  findSignalPendingRequest,
  getSignalAccessSummary,
  hasSignalAdmins,
  loadConfig,
  saveConfig,
} from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { mdToSignal } from '../utils/markdown.js';
import { formatToolStep, formatToolResult } from '../utils/tool-label.js';
import { redactPhone } from '../utils/redact.js';
import { JsonRpcClient } from '../signal/jsonrpc.js';
import type { JsonRpcEnvelope } from '../signal/process.js';
import { ensureSignalCli, getSignalCliCommand } from '../signal/binary.js';

const MAX_MESSAGE_LENGTH = 4000;
const INTER_MESSAGE_DELAY_MS = 350;

const AFFIRMATIVE = new Set(['yes', 'y', 'ok', 'okay', 'sure', 'allow', 'approve', 'yeah', 'yep', 'yup']);
const NEGATIVE = new Set(['no', 'n', 'nope', 'deny', 'stop', 'cancel', 'never']);
const ALWAYS_WORDS = new Set(['always', 'all', 'allow-all', 'allow all', 'forever']);

function normalizeReply(raw: string): string {
  const cleaned = raw.trim().toLowerCase().replace(/[.!]/g, '');
  if (ALWAYS_WORDS.has(cleaned)) return 'always';
  if (AFFIRMATIVE.has(cleaned)) return 'yes';
  if (NEGATIVE.has(cleaned)) return 'no';
  if (/^\d+$/.test(cleaned)) return cleaned;
  if (AFFIRMATIVE.has(cleaned.split(/\s+/)[0])) return 'yes';
  return cleaned || 'no';
}

type PendingReply = {
  resolve: (value: string) => void;
  timeout: NodeJS.Timeout;
};

const UNPAIRED_RESPONSE = 'Pair Mercury by sending /pair and then entering the code in the Mercury terminal.';

export class SignalChannel extends BaseChannel {
  readonly type = 'signal' as const;
  private rpc: JsonRpcClient | null = null;
  private binaryPath: string | null = null;
  private _running = false;
  get running(): boolean { return this._running; }
  private chatCommandContext?: import('../capabilities/registry.js').ChatCommandContext;

  private processedMessages = new Map<string, number>();
  private static readonly DEDUP_TTL = 60_000;
  private static readonly DEDUP_MAX_SIZE = 10000;
  private dedupCleanupInterval: NodeJS.Timeout | null = null;

  private pendingReplies = new Map<string, PendingReply>();
  private permissionModes = new Map<string, PermissionMode>();
  private onPermissionMode?: (mode: PermissionMode, source: string) => void;

  private stepCounters = new Map<string, number>();
  private stepHistory = new Map<string, string[]>();
  private taskActive = new Map<string, boolean>();
  private deferredResponses = new Map<string, string>();
  private statusNotices = new Map<string, string[]>();
  private static readonly MAX_STATUS_NOTICES = 3;

  constructor(private config: MercuryConfig) {
    super();
  }

  async listGroups(): Promise<{ groupId: string; groupName: string } | null> {
    if (!this.rpc) throw new Error('Signal RPC client not running');
    const phoneNumber = this.config.channels.signal.phoneNumber;
    const groups = await this.rpc.listGroups({ account: phoneNumber }) as any[];
    if (!Array.isArray(groups)) return null;
    logger.debug({ groups: groups.map(g => ({ id: g.groupId || g.id, name: g.name || g.groupName })) }, 'Signal: listGroups response');
    for (const group of groups) {
      const name = (group.name || group.groupName || '').toLowerCase().trim();
      if (name === 'mercury') {
        return {
          groupId: group.groupId || group.id,
          groupName: group.name || group.groupName || 'Mercury',
        };
      }
    }
    return null;
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
    const text = this.deferredResponses.get(key);
    this.deferredResponses.delete(key);
    return text;
  }

  setOnPermissionMode(handler: (mode: PermissionMode, source: string) => void): void {
    this.onPermissionMode = handler;
  }

  getPermissionMode(senderPhone: string): PermissionMode {
    return this.permissionModes.get(senderPhone) ?? 'ask-me';
  }

  async start(): Promise<void> {
    if (this._running) return;

    const { phoneNumber, mode } = this.config.channels.signal;
    if (!phoneNumber) {
      throw new Error('Signal phone number not configured');
    }

    try {
      this.binaryPath = await ensureSignalCli();
      const cmd = getSignalCliCommand(this.binaryPath);
      logger.info({ binary: cmd[0], native: cmd.length === 1 }, 'Signal CLI binary located');
    } catch (err: any) {
      throw new Error(`Failed to find or download signal-cli: ${err.message}`);
    }

    this.rpc = new JsonRpcClient({
      binaryPath: this.binaryPath,
      phoneNumber,
    });

    this.rpc.onEnvelope((envelope) => this.handleEnvelope(envelope));
    logger.info('Signal: envelope handler registered on RPC client');

    try {
      await this.rpc.start();
    } catch (err: any) {
      throw new Error(`Failed to start signal-cli daemon: ${err.message}`);
    }

    this._running = true;
    this.ready = true;

    this.dedupCleanupInterval = setInterval(() => this.cleanupDedup(), 30_000);

    if (mode === 'group' && !this.config.channels.signal.groupId) {
      logger.info('Signal group mode: no groupId configured, will auto-detect "Mercury" group');
    }

    logger.info({ mode, phone: redactPhone(phoneNumber) }, 'Signal channel started');
  }

  async stop(): Promise<void> {
    this._running = false;
    this.ready = false;

    if (this.dedupCleanupInterval) {
      clearInterval(this.dedupCleanupInterval);
      this.dedupCleanupInterval = null;
    }

    if (this.rpc) {
      await this.rpc.stop();
      this.rpc = null;
    }

    for (const [, pending] of this.pendingReplies) {
      clearTimeout(pending.timeout);
    }
    this.pendingReplies.clear();

    logger.info('Signal channel stopped');
  }

  private handleEnvelope(envelope: JsonRpcEnvelope): void {
    logger.info({ source: redactPhone(envelope.source), hasData: !!envelope.dataMessage, hasSync: !!envelope.syncMessage, hasTyping: !!envelope.typingMessage, hasReceipt: !!envelope.receiptMessage }, 'Signal: handleEnvelope called');
    try {
      this.handleEnvelopeInner(envelope);
    } catch (err: any) {
      logger.error({ err: err.message, source: redactPhone(envelope.source) }, 'Error handling Signal envelope');
    }
  }

  private handleEnvelopeInner(envelope: JsonRpcEnvelope): void {
    this.reloadConfigFromDisk();

    const source = envelope.source;
    const timestamp = envelope.timestamp;

    const dedupKey = `${source}:${timestamp}`;
    if (this.processedMessages.has(dedupKey)) {
      logger.debug({ source: redactPhone(source), timestamp }, 'Signal: dedup skipping message');
      return;
    }
    this.processedMessages.set(dedupKey, Date.now());
    if (this.processedMessages.size > SignalChannel.DEDUP_MAX_SIZE) {
      this.cleanupDedup();
    }

    if (envelope.typingMessage) return;
    if (envelope.receiptMessage) return;
    if (envelope.callMessage) return;

    // Convert syncMessage.sentMessage into a dataMessage-like structure
    // so we can process commands sent from the same account (e.g., /pair
    // sent from the linked phone to a group the bot is also in).
    let effectiveDataMessage = envelope.dataMessage;
    let effectiveSource = source;
    let effectiveSourceUuid = envelope.sourceUuid;
    let effectiveSourceName = envelope.sourceName;

    if (!effectiveDataMessage && envelope.syncMessage?.sentMessage) {
      const sent = envelope.syncMessage.sentMessage;
      effectiveDataMessage = {
        timestamp: sent.timestamp,
        message: sent.message,
        groupInfo: sent.groupInfo,
        expiresInSeconds: sent.expiresInSeconds,
        attachments: undefined,
        quote: undefined,
        sticker: undefined,
        remoteDelete: undefined,
      };
      // The source of a sync message is the account itself, which is an admin
      effectiveSource = this.config.channels.signal.phoneNumber || source;
      effectiveSourceUuid = envelope.sourceUuid;
      effectiveSourceName = envelope.sourceName || 'You';
      logger.info({ source: redactPhone(effectiveSource), message: sent.message }, 'Signal: processing syncMessage.sentMessage as dataMessage');
    }

    if (!effectiveDataMessage) {
      logger.debug({ source: redactPhone(source) }, 'Signal: no dataMessage, skipping');
      return;
    }
    const data = effectiveDataMessage;

    if (data.remoteDelete) return;

    const groupId = data.groupInfo?.groupId;
    const groupName = data.groupInfo?.groupName;

    // SOURCE FILTER: Mercury only listens to the configured channel.
    // Everything else is silently dropped before any processing.
    if (this.config.channels.signal.mode === 'private') {
      if (groupId || effectiveSource !== this.config.channels.signal.phoneNumber) {
        return;
      }
    } else {
      if (!groupId) {
        return;
      }
      const configuredGroupId = this.config.channels.signal.groupId;
      if (configuredGroupId && groupId !== configuredGroupId) {
        return;
      }
      if (!configuredGroupId) {
        if (groupName && groupName.toLowerCase().trim() === 'mercury') {
          this.config.channels.signal.groupId = groupId;
          this.config.channels.signal.groupName = groupName;
          saveConfig(this.config);
          logger.info({ groupId, groupName }, 'Signal: auto-detected Mercury group');
        } else {
          return;
        }
      }
    }

    // Private mode: auto-pair account owner as admin on first message
    if (this.config.channels.signal.mode === 'private' && !hasSignalAdmins(this.config)) {
      this.config.channels.signal.admins.push({
        phoneNumber: this.config.channels.signal.phoneNumber,
        role: 'admin',
        pairedAt: new Date().toISOString(),
      });
      saveConfig(this.config);
      logger.info('Signal: auto-paired account owner as admin (private mode)');
    }

    const text = data.message?.trim();
    const hasAttachments = data.attachments && data.attachments.length > 0;
    if (!text && !hasAttachments) return;

    const command = text ? this.getCommandName(text) : '';
    const role = this.getRole(effectiveSource);

    logger.info({ source: redactPhone(effectiveSource), text: text?.substring(0, 50), groupId: groupId ? 'present' : 'none', groupName, command, role }, 'Signal: processing message');

    // Group mode: unpaired user handling (after source filter)
    if (this.config.channels.signal.mode === 'group') {
      if (role === 'unpaired' && command === '/pair') {
        this.handlePairCommand(effectiveSource, effectiveSourceUuid, effectiveSourceName);
        return;
      }
      if (role === 'unpaired') {
        this.sendToTarget(UNPAIRED_RESPONSE, source);
        return;
      }
    }

    if (command === '/pair') {
      if (hasSignalAdmins(this.config)) {
        this.sendToTarget('Mercury is already paired. Only the admin can /unpair.', source);
      } else {
        this.handlePairCommand(source, envelope.sourceUuid, envelope.sourceName);
      }
      return;
    }

    if (command === '/unpair') {
      if (this.isAdmin(source)) {
        clearSignalAccess(this.config);
        saveConfig(this.config);
        this.reloadConfigFromDisk();
        this.sendToTarget('Signal has been unpaired. Send /pair to reconnect.', source);
      } else {
        this.sendToTarget('Only admins can unpair Mercury.', source);
      }
      return;
    }

    if (command === '/memory') {
      if (!this.isAdmin(source)) {
        this.sendToTarget('Memory commands are admin-only.', source);
        return;
      }
      this.handleMemoryCommand(source, text || '');
      return;
    }

    if (command === '/permissions') {
      if (!this.isAdmin(source)) {
        this.sendToTarget('Permission settings are admin-only.', source);
        return;
      }
      this.askPermissionMode(`signal:${source}`).then((mode) => {
        this.permissionModes.set(source, mode);
        if (this.onPermissionMode) this.onPermissionMode(mode, `signal:${source}`);
      }).catch(() => {});
      return;
    }

    if (command === '/help') {
      this.sendHelp(source);
      return;
    }

    if (command === '/status') {
      this.sendStatus(source);
      return;
    }

    if (command === '/skills') {
      this.handleSkillsCommand(source, text || '');
      return;
    }

    if (!this.permissionModes.has(source) && this.onPermissionMode) {
      this.permissionModes.set(source, 'ask-me');
    }

    const pending = this.pendingReplies.get(source);
    if (pending && text) {
      const normalized = normalizeReply(text);
      if (AFFIRMATIVE.has(normalized) || ALWAYS_WORDS.has(normalized) || NEGATIVE.has(normalized)) {
        clearTimeout(pending.timeout);
        this.pendingReplies.delete(source);
        pending.resolve(normalized);
        return;
      }
    }

    let content = text || '';
    if (hasAttachments && data.attachments) {
      const attachmentNames = data.attachments
        .map((a) => a.filename || a.contentType || 'attachment')
        .join(', ');
      if (content) {
        content += `\n[Attachments: ${attachmentNames}]`;
      } else {
        content = `[Attachments: ${attachmentNames}]`;
      }
    }

    if (!content) return;

    const rawId = this.config.channels.signal.mode === 'group'
      ? this.config.channels.signal.groupId || 'unknown'
      : source;
    const channelId = `signal:${rawId}`;

    const msg: ChannelMessage = {
      id: `${envelope.timestamp}`,
      channelId,
      channelType: 'signal',
      senderId: source,
      senderName: envelope.sourceName,
      content,
      timestamp: envelope.timestamp,
      metadata: {
        sourcePhone: source,
        sourceUuid: envelope.sourceUuid,
        sourceName: envelope.sourceName,
        senderRole: role,
        groupId,
        groupName,
      },
    };
    this.emit(msg);
  }

  async send(content: string, targetId?: string, elapsedMs?: number): Promise<void> {
    const target = this.resolveTarget(targetId);
    if (!target || !this.rpc) {
      logger.warn({ targetId }, 'Signal send: no valid target');
      return;
    }

    const key = targetId || 'notification';

    if (this.taskActive.get(key)) {
      const timeSuffix = elapsedMs != null ? ` (${(elapsedMs / 1000).toFixed(1)}s)` : '';
      const fullContent = content + timeSuffix;
      if (!fullContent.trim()) return;

      const isSystemNotice = content.startsWith('☿ ') || content.startsWith('⚠') || content.startsWith('  [') || content.length < 200;
      if (isSystemNotice) {
        const notices = this.statusNotices.get(key) || [];
        const truncated = fullContent.length > 80 ? fullContent.slice(0, 77) + '…' : fullContent;
        notices.push(truncated);
        this.statusNotices.set(key, notices);
      } else {
        this.deferredResponses.set(key, fullContent);
      }
      return;
    }

    const timeSuffix = elapsedMs != null ? `\n⏱ ${(elapsedMs / 1000).toFixed(1)}s` : '';
    const fullContent = content + timeSuffix;
    if (!fullContent.trim()) return;

    const formatted = mdToSignal(fullContent);
    const chunks = this.splitMessage(formatted, MAX_MESSAGE_LENGTH);

    for (const chunk of chunks) {
      await this.sendRaw(chunk, target);
      if (chunks.length > 1) {
        await this.delay(INTER_MESSAGE_DELAY_MS);
      }
    }
  }

  async sendFile(filePath: string, targetId?: string): Promise<void> {
    const target = this.resolveTarget(targetId);
    if (!target || !this.rpc) {
      logger.warn({ targetId }, 'Signal sendFile: no valid target');
      return;
    }

    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      await this.send(`File not found: ${filePath}`, targetId);
      return;
    }

    const { phoneNumber, mode, groupId } = this.config.channels.signal;

    try {
      await this.rpc.sendMessage({
        account: phoneNumber,
        message: path.basename(resolved),
        recipients: mode === 'group' && groupId ? undefined : [target],
        groupId: mode === 'group' && groupId ? groupId : undefined,
        attachments: [resolved],
      });
      logger.info({ file: resolved, target }, 'File sent via Signal');
    } catch (err: any) {
      logger.error({ err: err.message, file: resolved, target }, 'Signal sendFile failed');
      await this.send(`Failed to send file: ${err.message}`, targetId);
    }
  }

  async stream(content: AsyncIterable<string>, targetId?: string): Promise<string> {
    const key = targetId || 'notification';

    let full = '';
    for await (const chunk of content) {
      full += chunk;
    }

    if (this.taskActive.get(key)) {
      this.deferredResponses.set(key, full);
      return full;
    }

    const formatted = mdToSignal(full);
    const target = this.resolveTarget(targetId);
    if (target && this.rpc) {
      const chunks = this.splitMessage(formatted, MAX_MESSAGE_LENGTH);
      for (const chunk of chunks) {
        await this.sendRaw(chunk, target);
        if (chunks.length > 1) {
          await this.delay(INTER_MESSAGE_DELAY_MS);
        }
      }
    }
    return full;
  }

  async typing(targetId?: string): Promise<void> {
    if (!this.rpc) return;
    const { phoneNumber, mode, groupId } = this.config.channels.signal;

    try {
      const params: { account: string; recipient?: string; groupId?: string } = { account: phoneNumber };
      if (mode === 'group' && groupId) {
        params.groupId = groupId;
      }
      await this.rpc.sendTyping(params);
    } catch {
      // typing indicator is best-effort
    }
  }

  async askPermission(prompt: string, targetId?: string): Promise<string> {
    const target = this.resolveTarget(targetId);
    if (!target || !this.rpc) return 'no';

    const formatted = mdToSignal(prompt);
    const question = `${formatted}\n\nReply "yes" to allow, "no" to deny, or "always" to auto-approve.`;

    await this.sendRaw(question, target);

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingReplies.delete(target);
        resolve('no');
      }, 120_000);

      this.pendingReplies.set(target, { resolve, timeout });
    });
  }

  async askToContinue(question: string, targetId?: string): Promise<boolean> {
    const target = this.resolveTarget(targetId);
    if (!target || !this.rpc) return false;

    const formatted = mdToSignal(question);
    const prompt = `${formatted}\n\nReply "yes" to continue or "no" to stop.`;

    await this.sendRaw(prompt, target);

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingReplies.delete(target);
        resolve(false);
      }, 120_000);

      this.pendingReplies.set(target, {
        resolve: (val: string) => resolve(AFFIRMATIVE.has(val) || ALWAYS_WORDS.has(val)),
        timeout,
      });
    });
  }

  async askPermissionMode(targetId?: string): Promise<PermissionMode> {
    const target = this.resolveTarget(targetId);
    if (!target || !this.rpc) return 'ask-me';

    const prompt = `Permission Mode\nHow should Mercury handle risky actions?\n\n🔒 "ask-me" — confirm before file writes, commands, and scope changes\n✅ "allow-all" — auto-approve everything\n\nReply "ask-me" or "allow-all".`;

    await this.sendRaw(prompt, target);

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingReplies.delete(target);
        resolve('ask-me');
      }, 120_000);

      this.pendingReplies.set(target, {
        resolve: (val: string) => {
          const mode = ALWAYS_WORDS.has(val) ? 'allow-all' : 'ask-me';
          resolve(mode as PermissionMode);
          return mode;
        },
        timeout,
      });
    });
  }

  private getRole(senderPhone: string): 'admin' | 'member' | 'unpaired' {
    if (findSignalAdmin(this.config, senderPhone)) return 'admin';
    if (findSignalApprovedUser(this.config, senderPhone)) return 'member';
    return 'unpaired';
  }

  private isAdmin(senderPhone: string): boolean {
    return this.getRole(senderPhone) === 'admin';
  }

  private handlePairCommand(senderPhone: string, senderUuid: string | undefined, senderName: string | undefined): void {
    if (hasSignalAdmins(this.config)) {
      this.sendToTarget('Mercury is already paired. Only the admin can /unpair.', senderPhone);
      return;
    }

    const existing = findSignalPendingRequest(this.config, senderPhone);
    if (existing) {
      this.sendToTarget(`Pairing already in progress. Your code is: ${existing.pairingCode}\nEnter this code in the Mercury terminal.`, senderPhone);
      return;
    }

    const pairingCode = this.generatePairingCode();
    addSignalPendingRequest(this.config, {
      phoneNumber: senderPhone,
      pairingCode,
      uuid: senderUuid,
      name: senderName,
    });
    saveConfig(this.config);

    this.sendToTarget(
      `Pairing initiated. Your code is: *${pairingCode}*\nEnter this code in the Mercury terminal to complete setup.`,
      senderPhone,
    );

    logger.info({ phone: redactPhone(senderPhone) }, 'Signal pairing request received');
  }

  private sendHelp(senderPhone: string): void {
    const isAdmin = this.isAdmin(senderPhone);
    const lines = [
      '*Mercury Commands:*',
      '',
      '/pair — Start pairing (first user becomes admin)',
      '/status — Show Mercury status',
      '/skills — Browse skills',
      '/help — Show this help',
    ];

    if (isAdmin) {
      lines.push('', '*Admin only:*');
      lines.push('/unpair — Reset all Signal access');
      lines.push('/memory — View and manage memory');
      lines.push('/permissions — Change permission mode');
    }

    this.sendToTarget(lines.join('\n'), senderPhone);
  }

  private sendStatus(senderPhone: string): void {
    const isAdmin = this.isAdmin(senderPhone);
    const { mode, groupId, groupName } = this.config.channels.signal;
    const summary = getSignalAccessSummary(this.config);

    const lines = [
      '*Mercury Status*',
      '',
      `Mode: ${mode}`,
      `Paired: ${hasSignalAdmins(this.config) ? 'Yes' : 'No'}`,
      `Access: ${summary}`,
    ];

    if (mode === 'group') {
      lines.push(`Group: ${groupName || groupId || 'Not set'}`);
    }

    if (isAdmin) {
      const permMode = this.permissionModes.get(senderPhone) || 'ask-me';
      lines.push(`Your permissions: ${permMode}`);
    } else {
      lines.push('Your role: member');
    }

    this.sendToTarget(lines.join('\n'), senderPhone);
  }

  private handleMemoryCommand(senderPhone: string, text: string): void {
    if (!this.chatCommandContext) {
      this.sendToTarget('Memory not available.', senderPhone);
      return;
    }

    const parts = text.trim().split(/\s+/).slice(1);
    const sub = (parts[0] || 'overview').toLowerCase();

    switch (sub) {
      case 'overview': {
        const summary = this.chatCommandContext.memorySummary();
        const lines = [
          '*Memory Overview*',
          `Conscious memories: ${summary.total}`,
          `Subconscious memories: ${summary.subconsciousTotal}`,
          `Learning: ${summary.learningPaused ? '⏸ PAUSED' : '✅ ACTIVE'}`,
        ];
        this.sendToTarget(lines.join('\n'), senderPhone);
        return;
      }
      case 'recent': {
        const recent = this.chatCommandContext.memoryRecent(10);
        if (recent.length === 0) {
          this.sendToTarget('No memories yet.', senderPhone);
          return;
        }
        const lines = recent.map((r) => {
          const scope = r.scope === 'active' ? '⏳' : r.scope === 'subconscious' ? '💤' : '📌';
          return `${scope} [${r.type}] ${r.summary} (conf: ${r.confidence.toFixed(2)}, seen: ${r.evidenceCount}x)`;
        });
        this.sendToTarget('*Recent Memories:*\n' + lines.join('\n'), senderPhone);
        return;
      }
      case 'toggle':
      case 'pause':
      case 'resume': {
        const currentSummary = this.chatCommandContext.memorySummary();
        const currentlyPaused = currentSummary.learningPaused;
        this.chatCommandContext.memorySetLearningPaused(!currentlyPaused);
        this.sendToTarget(
          currentlyPaused ? 'Learning resumed.' : 'Learning paused.',
          senderPhone,
        );
        return;
      }
      case 'clear': {
        this.sendToTarget(
          '⚠️ Are you sure you want to clear ALL memories? Reply "yes" to confirm.',
          senderPhone,
        );
        const timeout = setTimeout(() => {
          this.pendingReplies.delete(senderPhone);
        }, 60_000);
        this.pendingReplies.set(senderPhone, {
          resolve: (val: string) => {
            if (val === 'yes') {
              const cleared = this.chatCommandContext!.memoryClear();
              this.sendToTarget(`Cleared ${cleared} memories.`, senderPhone);
            } else {
              this.sendToTarget('Memory clear cancelled.', senderPhone);
            }
          },
          timeout,
        });
        return;
      }
      case 'subconscious': {
        const subconsciousMemories = this.chatCommandContext.memoryGetSubconscious(5);
        const subconsciousTotal = this.chatCommandContext.memorySummary().subconsciousTotal;
        if (subconsciousMemories.length === 0) {
          this.sendToTarget('No subconscious memories yet.', senderPhone);
          return;
        }
        const lines = subconsciousMemories.map((r) => `💤 [${r.type}] ${r.summary}`);
        this.sendToTarget('*Subconscious Memory:*\n' + lines.join('\n'), senderPhone);
        return;
      }
      case 'shared': {
        this.sendToTarget('Shared memory feature is not yet available on Signal.', senderPhone);
        return;
      }
      default:
        this.sendToTarget(
          '/memory overview — view memory summary\n/memory recent — recent memories\n/memory toggle — pause/resume learning\n/memory clear — clear all memories\n/memory subconscious — view subconscious\n/memory shared — shared memories',
          senderPhone,
        );
    }
  }

  private handleSkillsCommand(senderPhone: string, text: string): void {
    const parts = text.trim().split(/\s+/).slice(1);
    const sub = (parts[0] || 'list').toLowerCase();
    const arg = parts.slice(1).join(' ').trim();

    if (sub === 'help' || sub === '-h' || sub === '--help') {
      this.sendToTarget(
        '*Skills Commands:*\n/skills — list installed skills\n/skills search <query> — search registry\n/skills view <id> — show details\n/skills install <id> — admin only\n/skills remove <id> — admin only',
        senderPhone,
      );
      return;
    }

    if (sub === 'list') {
      const loader = new (require('../skills/loader.js').SkillLoader)();
      const installed = loader.getAllSkills();
      if (installed.length === 0) {
        this.sendToTarget('No skills installed.', senderPhone);
        return;
      }
      const lines = installed.slice(0, 25).map((s: any) => `• ${s.name} — ${s.active ? 'active' : 'inactive'}${s.description ? ` — ${s.description}` : ''}`);
      this.sendToTarget(`*Installed skills (${installed.length})*\n\n${lines.join('\n')}`, senderPhone);
      return;
    }

    this.sendToTarget('Full skills browsing via Signal is coming soon. Use the Mercury terminal for now.', senderPhone);
  }

  async sendToolFeedback(toolName: string, args: Record<string, any>, targetId?: string): Promise<void> {
    const key = targetId || 'notification';
    const step = (this.stepCounters.get(key) || 0) + 1;
    this.stepCounters.set(key, step);
    const label = formatToolStep(toolName, args);

    const history = this.stepHistory.get(key) || [];
    const recentHistory = history.slice(-5);
    const lines = [
      `⚙️ *Mercury working* (step ${step})`,
      '',
      ...recentHistory.map(h => `✅ ${h}`),
      `⏳ ${label}…`,
    ];
    await this.send(lines.join('\n'), targetId);
  }

  async sendStepDone(toolName: string, result: unknown, targetId?: string): Promise<void> {
    const key = targetId || 'notification';
    const step = this.stepCounters.get(key) || 0;
    const summary = formatToolResult(toolName, result);
    const label = formatToolStep(toolName, {} as any);
    const doneLine = summary ? `${label} · ${summary}` : label;

    const history = this.stepHistory.get(key) || [];
    history.push(doneLine);
    this.stepHistory.set(key, history);

    const recentHistory = history.slice(-5);
    const lines = [
      `⚙️ *Mercury working* (${step} steps done)`,
      '',
      ...recentHistory.map(h => `✅ ${h}`),
    ];
    await this.send(lines.join('\n'), targetId);
  }

  resetStepCounter(targetId?: string): void {
    const key = targetId || 'notification';
    this.stepCounters.delete(key);
    this.stepHistory.delete(key);
    this.statusNotices.delete(key);
    this.endTask(targetId);
  }

  async sendCompletion(elapsedMs: number, stepCount: number, targetId?: string, meta?: { provider: string; model: string; inputTokens: number; outputTokens: number; totalTokens: number; budgetUsed: number; budgetTotal: number; budgetPercentage: number }): Promise<void> {
    const secs = Math.floor(elapsedMs / 1000);
    const mins = Math.floor(secs / 60);
    const remSecs = secs % 60;
    const timeStr = mins > 0 ? `${mins}m ${remSecs}s` : `${secs}s`;
    const stepsStr = stepCount > 0 ? `${stepCount} step${stepCount !== 1 ? 's' : ''}` : '';
    const parts = [stepsStr, timeStr].filter(Boolean).join(' · ');

    const key = targetId || 'notification';
    const history = this.stepHistory.get(key) || [];
    const recentHistory = history.slice(-5);

    const lines = [`✅ *Task complete* (${parts})`];

    if (meta) {
      const formatTokens = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
      lines.push(`☿ ${meta.model} via ${meta.provider} · ${formatTokens(meta.totalTokens)} tokens`);
      const pct = Math.round(meta.budgetPercentage);
      const barLen = 15;
      const filled = Math.round((pct / 100) * barLen);
      const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled);
      lines.push(`Budget: ${bar} ${pct}% (${formatTokens(meta.budgetUsed)} / ${formatTokens(meta.budgetTotal)})`);
    }

    if (recentHistory.length > 0) {
      lines.push('');
      lines.push(...recentHistory.map(h => `  ✓ ${h}`));
    }

    this.endTask(targetId);

    const deferred = this.deferredResponses.get(key);
    if (deferred && deferred.trim()) {
      this.deferredResponses.delete(key);
      await this.send(deferred, targetId);
    }

    await this.send(lines.join('\n'), targetId);

    this.stepCounters.delete(key);
    this.stepHistory.delete(key);
    this.statusNotices.delete(key);
  }

  async sendGoodbyeMessage(): Promise<void> {
    const { mode, groupId, phoneNumber } = this.config.channels.signal;
    if (!this.rpc) return;

    const message = 'Mercury has been unregistered from this conversation. It will no longer respond here. To reconnect, the admin needs to set up Signal again with: mercury doctor';

    try {
      if (mode === 'group' && groupId) {
        await this.rpc.sendMessage({
          account: phoneNumber,
          message,
          groupId,
        });
      } else {
        const admins = this.config.channels.signal.admins;
        if (admins.length > 0) {
          await this.rpc.sendMessage({
            account: phoneNumber,
            message,
            recipients: [admins[0].phoneNumber],
          });
        }
      }
    } catch (err: any) {
      logger.error({ err: err.message }, 'Failed to send Signal goodbye message');
    }
  }

  private resolveTarget(targetId?: string): string | null {
    const { mode, groupId, phoneNumber } = this.config.channels.signal;

    if (!targetId || targetId === 'notification') {
      if (mode === 'group' && groupId) {
        return groupId;
      }
      const admins = this.config.channels.signal.admins;
      if (admins.length > 0) return admins[0].phoneNumber;
      return null;
    }

    if (targetId.startsWith('signal:')) {
      return targetId.slice(7);
    }
    return targetId;
  }

  private async sendRaw(text: string, target: string): Promise<boolean> {
    if (!this.rpc) return false;

    const { phoneNumber, mode, groupId } = this.config.channels.signal;

    try {
      await this.rpc.sendMessage({
        account: phoneNumber,
        message: text,
        recipients: mode === 'group' && groupId ? undefined : [target],
        groupId: mode === 'group' && groupId ? groupId : undefined,
      });
      return true;
    } catch (err: any) {
      logger.error({ err: err.message, target: redactPhone(target) }, 'Signal send failed');
      return false;
    }
  }

  private async sendToTarget(text: string, target: string): Promise<void> {
    const formatted = mdToSignal(text);
    const chunks = this.splitMessage(formatted, MAX_MESSAGE_LENGTH);
    for (const chunk of chunks) {
      await this.sendRaw(chunk, target);
      if (chunks.length > 1) {
        await this.delay(INTER_MESSAGE_DELAY_MS);
      }
    }
  }

  private async sendToGroup(text: string): Promise<void> {
    const { mode, groupId } = this.config.channels.signal;
    if (mode === 'group' && groupId) {
      await this.sendRaw(mdToSignal(text), groupId);
    }
  }

  private getCommandName(text: string): string {
    return text.trim().split(/\s+/)[0]?.toLowerCase() || '';
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

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private reloadConfigFromDisk(): void {
    try {
      this.config = loadConfig();
    } catch {
      // keep using in-memory copy
    }
  }

  private cleanupDedup(): void {
    const now = Date.now();
    for (const [key, ts] of this.processedMessages) {
      if (now - ts > SignalChannel.DEDUP_TTL) {
        this.processedMessages.delete(key);
      }
    }
  }
}