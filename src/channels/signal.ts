import fs from 'node:fs';
import path from 'node:path';
import type { ChannelMessage } from '../types/channel.js';
import { BaseChannel, type PermissionMode } from './base.js';
import type { MercuryConfig, SignalAccessUser, SignalPendingRequest } from '../utils/config.js';
import {
  addSignalPendingRequest,
  approveSignalPendingRequest,
  clearSignalAccess,
  findSignalAdmin,
  findSignalApprovedUser,
  findSignalPendingRequest,
  getSignalAccessSummary,
  getSignalAdmins,
  hasSignalAdmins,
  rejectSignalPendingRequest,
  saveConfig,
} from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { formatToolStep, formatToolResult } from '../utils/tool-label.js';

const MAX_MESSAGE_LENGTH = 4000;

type PendingReply = {
  resolve: (value: string) => void;
  timeout: NodeJS.Timeout;
};

export class SignalChannel extends BaseChannel {
  readonly type = 'signal' as const;
  private pollController: AbortController | null = null;
  private polling = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 20;
  private baseReconnectDelay = 2000;
  private shouldReconnect = true;

  // Pairing mode: allows messages to trigger pairing
  private pairingMode = false;
  private pairingHandler?: (source: string, text: string, groupId?: string) => void;

  // Permission / continuation prompts — keyed by sender phone number
  private pendingReplies = new Map<string, PendingReply>();
  private permissionModes = new Map<string, PermissionMode>();

  // Task progress tracking
  private stepCounters = new Map<string, number>();
  private stepHistory = new Map<string, string[]>();
  private taskActive = new Map<string, boolean>();
  private deferredResponses = new Map<string, string>();
  private statusNotices = new Map<string, string[]>();
  private static readonly MAX_STATUS_NOTICES = 3;

  constructor(private config: MercuryConfig) {
    super();
  }

  /** Enable pairing mode — allows messages and routes them to a handler */
  enablePairingMode(handler: (source: string, text: string, groupId?: string) => void): void {
    this.pairingMode = true;
    this.pairingHandler = handler;
  }

  /** Disable pairing mode — self-messages are filtered again */
  disablePairingMode(): void {
    this.pairingMode = false;
    this.pairingHandler = undefined;
  }

  // ─── Lifecycle ───────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.polling) return;

    const { apiUrl, number } = this.config.channels.signal;
    if (!apiUrl || !number) {
      logger.warn('Signal API URL or number not set — skipping');
      return;
    }

    this.shouldReconnect = true;
    this.startPolling();
  }

  async stop(): Promise<void> {
    this.shouldReconnect = false;
    this.polling = false;
    if (this.pollController) {
      this.pollController.abort();
      this.pollController = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ready = false;
  }

  private startPolling(): void {
    if (this.polling) return;
    this.polling = true;
    this.ready = true;
    this.reconnectAttempts = 0;
    logger.info('Signal: starting HTTP long-poll receive loop');
    this.pollLoop();
  }

  private async pollLoop(): Promise<void> {
    const { apiUrl, number } = this.config.channels.signal;
    const receiveUrl = `${apiUrl}/v1/receive/${encodeURIComponent(number)}`;

    while (this.polling && this.shouldReconnect) {
      this.pollController = new AbortController();
      try {
        const response = await fetch(receiveUrl, {
          signal: this.pollController.signal,
          headers: { 'Content-Type': 'application/json' },
        });

        if (!response.ok) {
          logger.warn({ status: response.status }, 'Signal: receive poll returned error');
          await this.pollBackoff();
          continue;
        }

        const envelopes = await response.json() as any[];
        this.reconnectAttempts = 0; // Reset on success

        if (Array.isArray(envelopes)) {
          for (const envelope of envelopes) {
            try {
              this.handleEnvelope(envelope);
            } catch (err: any) {
              logger.warn({ err: err.message }, 'Signal: error handling envelope');
            }
          }
        }

        // Small delay between polls to avoid hammering when no messages
        if (!envelopes || envelopes.length === 0) {
          await new Promise((r) => setTimeout(r, 1000));
        }
      } catch (err: any) {
        if (err.name === 'AbortError') {
          // Intentional abort (stop() called)
          break;
        }
        logger.error({ err: err.message }, 'Signal: poll request failed');
        await this.pollBackoff();
      }
    }

    this.polling = false;
    this.ready = false;
  }

  private async pollBackoff(): Promise<void> {
    if (!this.shouldReconnect) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('Signal: max reconnect attempts reached, giving up');
      this.polling = false;
      return;
    }

    const delay = Math.min(
      this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts),
      60_000,
    );
    this.reconnectAttempts++;
    logger.info({ attempt: this.reconnectAttempts, delayMs: delay }, 'Signal: backing off before next poll');
    await new Promise((r) => setTimeout(r, delay));
  }

  // ─── Incoming Message Handling ──────────────────────────────

  private handleEnvelope(envelope: any): void {
    // signal-cli-rest-api sends envelopes in format:
    // { envelope: { source, sourceNumber, sourceUuid, sourceName, dataMessage, syncMessage, ... }, account }
    const env = envelope.envelope || envelope;
    // A sender can be identified by phone number (E.164) and/or a Signal ACI (UUID).
    // Prefer the phone number for matching against the approval list, but keep
    // the UUID and display name so we never lose track of WHO is speaking.
    const sourcePhone: string | undefined = env.sourceNumber || (typeof env.source === 'string' && env.source.startsWith('+') ? env.source : undefined);
    const sourceUuid: string | undefined = env.sourceUuid || (typeof env.source === 'string' && !env.source.startsWith('+') ? env.source : undefined);
    const sourceName: string | undefined = env.sourceName;
    // The identifier used for access-control matching and as the per-sender key.
    const source = sourcePhone || sourceUuid || env.source;

    if (!source) return;

    // Extract text and group info from either dataMessage (incoming from others)
    // or syncMessage.sentMessage (self-sent from phone / linked device)
    let text: string | undefined;
    let timestamp: number;
    let groupId: string | undefined;

    if (env.dataMessage) {
      text = env.dataMessage.message?.trim();
      timestamp = env.dataMessage.timestamp || env.timestamp || Date.now();
      groupId = env.dataMessage.groupInfo?.groupId;
    } else if (env.syncMessage?.sentMessage) {
      const sent = env.syncMessage.sentMessage;
      text = sent.message?.trim();
      timestamp = sent.timestamp || env.timestamp || Date.now();
      groupId = sent.groupInfo?.groupId;
    } else {
      return;
    }

    if (!text) return;

    // Group-based filtering:
    // Only process messages from the configured Mercury group.
    // Ignore all DMs, Note to Self, and other groups.
    const configuredGroupId = this.config.channels.signal.groupInternalId;

    if (configuredGroupId) {
      // Group is configured — only accept messages from that group
      if (groupId !== configuredGroupId) {
        // Exception: pairing mode allows messages from the group during setup
        // (but we still require the group match)
        logger.debug({ groupId, configuredGroupId }, 'Signal: ignoring message from non-Mercury group or DM');
        return;
      }
    } else {
      // No group configured yet — only allow pairing mode
      if (this.pairingMode && this.pairingHandler) {
        this.pairingHandler(source, text, groupId);
        return;
      }
      logger.debug('Signal: no group configured and not in pairing mode, ignoring');
      return;
    }

    // Pairing mode: route to pairing handler (for "mercury pair" trigger)
    if (this.pairingMode && this.pairingHandler) {
      this.pairingHandler(source, text, groupId);
      return;
    }

    // Check if this is a reply to a pending prompt
    const pendingReply = this.pendingReplies.get(source);
    if (pendingReply) {
      this.pendingReplies.delete(source);
      clearTimeout(pendingReply.timeout);
      pendingReply.resolve(text.toLowerCase());
      return;
    }

    // Access control
    const approvedUser = findSignalApprovedUser(this.config, source);
    const isAdmin = this.isAdminUser(source);

    // Diagnostic: make every gating decision fully traceable. This is the line
    // to watch when investigating "why did Mercury respond to/ignore X".
    logger.info(
      {
        sourcePhone,
        sourceUuid,
        sourceName,
        matchKey: source,
        approved: !!approvedUser,
        role: approvedUser ? (isAdmin ? 'admin' : 'member') : 'none',
        textPreview: text.slice(0, 40),
      },
      'Signal: access-control decision',
    );

    if (!approvedUser) {
      this.handleUnapprovedMessage(source, text);
      return;
    }

    // Commands
    const command = text.startsWith('/') ? text.split(/\s+/)[0].toLowerCase() : null;

    if (command === '/unpair') {
      if (!this.isAdminUser(source)) {
        this.sendToGroup('Only Signal admins can reset access.');
        return;
      }
      this.resetAccess();
      this.sendToGroup('Signal access reset. New users can message to request access.');
      return;
    }

    if (command === '/permissions') {
      this.askPermissionMode(`signal:${source}`).then((mode) => {
        this.permissionModes.set(source, mode);
      }).catch(() => {});
      return;
    }

    if (command === '/status') {
      const summary = getSignalAccessSummary(this.config);
      this.sendToGroup(`Signal access: ${summary}`);
      return;
    }

    // Admin commands: "approve +number", "/approve +number", "/signal approve +number"
    const adminText = text.replace(/^\/(signal\s+)?/i, '').trim();
    if (/^(approve|reject)\s/i.test(adminText) && this.handleAdminCommand(source, adminText)) {
      return;
    }

    // Normal message — emit to the agent
    const msg: ChannelMessage = {
      id: `signal_${timestamp}_${Math.random().toString(36).slice(2, 8)}`,
      channelId: `signal:${source}`,
      channelType: 'signal',
      senderId: source,
      senderName: approvedUser.name || sourceName || source,
      senderRole: isAdmin ? 'admin' : 'member',
      content: text,
      timestamp,
      metadata: { phoneNumber: sourcePhone, uuid: sourceUuid, groupId },
    };
    this.emit(msg);
  }

  private async handleUnapprovedMessage(source: string, text: string): Promise<void> {
    const pending = findSignalPendingRequest(this.config, source);
    if (pending) {
      await this.sendToGroup(this.getPendingStatusMessage(pending));
      return;
    }

    // New access request
    if (!hasSignalAdmins(this.config) && this.config.channels.signal.pending.length > 0) {
      await this.sendToGroup(
        'Initial Signal pairing is already in progress for another user. Ask the Mercury operator to finish setup or reset Signal access first.',
      );
      return;
    }

    const request = addSignalPendingRequest(this.config, {
      phoneNumber: source,
      pairingCode: hasSignalAdmins(this.config) ? undefined : this.generatePairingCode(),
    });
    saveConfig(this.config);
    logger.info({ source }, 'Signal access request recorded');

    await this.sendToGroup(this.getPendingStatusMessage(request));

    if (hasSignalAdmins(this.config)) {
      await this.notifyAdminsOfPendingRequest(request);
    }
  }

  private async notifyAdminsOfPendingRequest(request: SignalPendingRequest): Promise<void> {
    const message = [
      'Signal access request pending approval.',
      '',
      `Phone: ${request.phoneNumber}`,
      `Requested: ${new Date(request.requestedAt).toLocaleString()}`,
      '',
      `Reply "approve ${request.phoneNumber}" or "reject ${request.phoneNumber}" to respond.`,
    ].join('\n');

    // Notify in the group
    await this.sendToGroup(message);
  }

  // ─── Sending ────────────────────────────────────────────────

  /** Send a message to the configured Mercury group */
  async sendToGroup(message: string): Promise<void> {
    const { apiUrl, number, groupId } = this.config.channels.signal;
    if (!groupId) {
      logger.warn('Signal: no group configured, cannot send');
      return;
    }

    const url = `${apiUrl}/v2/send`;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          number,
          recipients: [groupId],
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        logger.warn({ status: response.status, body }, 'Signal: sendToGroup failed');
      }
    } catch (err: any) {
      logger.error({ err: err.message }, 'Signal: sendToGroup request error');
    }
  }

  async send(content: string, targetId?: string, elapsedMs?: number): Promise<void> {
    const key = targetId || 'notification';

    // During active task, route through status mechanism
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

    const chunks = this.splitMessage(fullContent, MAX_MESSAGE_LENGTH);
    for (const chunk of chunks) {
      await this.sendToGroup(chunk);
    }
  }

  async sendFile(filePath: string, targetId?: string): Promise<void> {
    const { groupId } = this.config.channels.signal;
    if (!groupId) return;

    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      await this.sendToGroup(`File not found: ${filePath}`);
      return;
    }

    const fileBuffer = fs.readFileSync(resolved);
    const base64 = fileBuffer.toString('base64');
    const filename = path.basename(resolved);

    await this.sendWithAttachment(groupId, filename, base64);
  }

  async stream(content: AsyncIterable<string>, targetId?: string): Promise<string> {
    // Signal doesn't support message editing, so accumulate and send
    let full = '';
    for await (const chunk of content) {
      full += chunk;
    }

    const key = targetId || 'notification';
    if (this.taskActive.get(key)) {
      this.deferredResponses.set(key, full);
      return full;
    }

    if (full.trim()) {
      await this.send(full, targetId);
    }
    return full;
  }

  async typing(_targetId?: string): Promise<void> {
    // Signal doesn't support typing indicators via signal-cli-rest-api
  }

  // ─── Permission / Continuation Prompts ──────────────────────

  async askPermission(prompt: string, targetId?: string): Promise<string> {
    // For group-based messaging, we use the source phone number for reply tracking
    const source = targetId?.startsWith('signal:') ? targetId.split(':')[1] : this.config.channels.signal.number;

    const message = `${prompt}\n\nReply: yes / no / always`;
    await this.sendToGroup(message);

    return this.waitForReply(source, 120_000, 'no');
  }

  async askToContinue(question: string, targetId?: string): Promise<boolean> {
    const source = targetId?.startsWith('signal:') ? targetId.split(':')[1] : this.config.channels.signal.number;

    const message = `${question}\n\nReply: yes / no`;
    await this.sendToGroup(message);

    const reply = await this.waitForReply(source, 120_000, 'no');
    return reply === 'yes' || reply === 'y' || reply === 'continue';
  }

  async askPermissionMode(targetId?: string): Promise<PermissionMode> {
    const source = targetId?.startsWith('signal:') ? targetId.split(':')[1] : this.config.channels.signal.number;

    const message = [
      'Permission Mode',
      'How should Mercury handle risky actions this session?',
      '',
      '1. Ask Me — confirm before file writes, commands, and scope changes',
      '2. Allow All — auto-approve everything',
      '',
      'Reply: 1 or 2',
    ].join('\n');
    await this.sendToGroup(message);

    const reply = await this.waitForReply(source, 120_000, '1');
    return reply === '2' || reply === 'allow-all' || reply === 'allow all' ? 'allow-all' : 'ask-me';
  }

  private waitForReply(phoneNumber: string, timeoutMs: number, defaultValue: string): Promise<string> {
    // Cancel any existing pending reply for this number
    const existing = this.pendingReplies.get(phoneNumber);
    if (existing) {
      clearTimeout(existing.timeout);
      existing.resolve(defaultValue);
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingReplies.delete(phoneNumber);
        resolve(defaultValue);
      }, timeoutMs);

      this.pendingReplies.set(phoneNumber, { resolve, timeout });
    });
  }

  // ─── Task Progress (Telegram Parity) ───────────────────────

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

  async sendToolFeedback(toolName: string, args: Record<string, any>, targetId?: string): Promise<void> {
    const key = targetId || 'notification';
    const step = (this.stepCounters.get(key) || 0) + 1;
    this.stepCounters.set(key, step);
    const label = formatToolStep(toolName, args);

    // For Signal, send a compact status message (no edit capability)
    // Only send every 3 steps to avoid spam
    if (step === 1 || step % 3 === 0) {
      const history = this.stepHistory.get(key) || [];
      const recentHistory = history.slice(-3);
      const lines = [
        `⚙️ Mercury working (step ${step})`,
        '',
        ...recentHistory.map(h => `✓ ${h}`),
        `⏳ ${label}…`,
      ];
      await this.sendToGroup(lines.join('\n'));
    }
  }

  async sendStepDone(toolName: string, result: unknown, _targetId?: string): Promise<void> {
    const key = _targetId || 'notification';
    const summary = formatToolResult(toolName, result);
    const label = formatToolStep(toolName, {} as any);
    const doneLine = summary ? `${label} · ${summary}` : label;

    const history = this.stepHistory.get(key) || [];
    history.push(doneLine);
    this.stepHistory.set(key, history);
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

    const lines = [`✅ Task complete (${parts})`];

    if (meta) {
      const formatTokens = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
      lines.push(`☿ ${meta.model} via ${meta.provider} · ${formatTokens(meta.totalTokens)} tokens`);
      const pct = Math.round(meta.budgetPercentage);
      lines.push(`Budget: ${pct}% (${formatTokens(meta.budgetUsed)} / ${formatTokens(meta.budgetTotal)})`);
    }

    if (recentHistory.length > 0) {
      lines.push('');
      lines.push(...recentHistory.map(h => `  ✓ ${h}`));
    }

    // End task so normal send works
    this.endTask(targetId);

    // Flush deferred response first
    const deferred = this.deferredResponses.get(key);
    if (deferred && deferred.trim()) {
      this.deferredResponses.delete(key);
      const chunks = this.splitMessage(deferred, MAX_MESSAGE_LENGTH);
      for (const chunk of chunks) {
        await this.sendToGroup(chunk);
      }
    }

    // Send completion summary
    await this.sendToGroup(lines.join('\n'));

    // Cleanup
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
  }

  // ─── Access Control ─────────────────────────────────────────

  /**
   * Handle admin reply commands: "approve +1234567890" / "reject +1234567890"
   * Called from the main message handler when a message comes from an admin.
   */
  handleAdminCommand(source: string, text: string): boolean {
    if (!this.isAdminUser(source)) return false;

    const lower = text.toLowerCase().trim();

    const approveMatch = lower.match(/^approve\s+(\+?\d+)$/);
    if (approveMatch) {
      const phoneNumber = approveMatch[1].startsWith('+') ? approveMatch[1] : `+${approveMatch[1]}`;
      const approved = approveSignalPendingRequest(this.config, phoneNumber, 'member');
      if (approved) {
        saveConfig(this.config);
        this.sendToGroup(`Approved Signal access for ${phoneNumber}.`);
      } else {
        this.sendToGroup(`No pending request found for ${phoneNumber}.`);
      }
      return true;
    }

    const rejectMatch = lower.match(/^reject\s+(\+?\d+)$/);
    if (rejectMatch) {
      const phoneNumber = rejectMatch[1].startsWith('+') ? rejectMatch[1] : `+${rejectMatch[1]}`;
      const rejected = rejectSignalPendingRequest(this.config, phoneNumber);
      if (rejected) {
        saveConfig(this.config);
        this.sendToGroup(`Rejected Signal access for ${phoneNumber}.`);
      } else {
        this.sendToGroup(`No pending request found for ${phoneNumber}.`);
      }
      return true;
    }

    return false;
  }

  getPermissionMode(phoneNumber: string): PermissionMode {
    return this.permissionModes.get(phoneNumber) ?? 'ask-me';
  }

  // ─── HTTP Helpers (signal-cli-rest-api) ─────────────────────

  private async sendToNumber(recipient: string, message: string): Promise<void> {
    const { apiUrl, number } = this.config.channels.signal;
    const url = `${apiUrl}/v2/send`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          number,
          recipients: [recipient],
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        logger.warn({ status: response.status, body, recipient }, 'Signal: send failed');
      }
    } catch (err: any) {
      logger.error({ err: err.message, recipient }, 'Signal: send request error');
    }
  }

  private async sendWithAttachment(recipient: string, filename: string, base64Data: string): Promise<void> {
    const { apiUrl, number } = this.config.channels.signal;
    const url = `${apiUrl}/v2/send`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: filename,
          number,
          recipients: [recipient],
          base64_attachments: [base64Data],
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        logger.warn({ status: response.status, body, recipient }, 'Signal: sendFile failed');
      } else {
        logger.info({ file: filename, recipient }, 'File sent via Signal');
      }
    } catch (err: any) {
      logger.error({ err: err.message, recipient }, 'Signal: sendFile request error');
    }
  }

  // ─── Resolution / Utilities ─────────────────────────────────

  /**
   * Scan Signal groups and find one matching the given name (case-insensitive).
   * Returns matching groups with their id (for sending) and internal_id (for envelope matching).
   */
  static async findGroupsByName(apiUrl: string, number: string, targetName: string): Promise<Array<{ name: string; id: string; internalId: string; members: string[] }>> {
    try {
      const response = await fetch(`${apiUrl}/v1/groups/${encodeURIComponent(number)}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return [];
      const groups = await response.json() as any[];
      const normalized = targetName.toLowerCase();
      return groups
        .filter((g: any) => g.name?.toLowerCase() === normalized)
        .map((g: any) => ({
          name: g.name,
          id: g.id,
          internalId: g.internal_id,
          members: g.members || [],
        }));
    } catch {
      return [];
    }
  }

  private isAdminUser(phoneNumber: string): boolean {
    return !!findSignalAdmin(this.config, phoneNumber);
  }

  private getPendingStatusMessage(request?: SignalPendingRequest): string {
    if (!hasSignalAdmins(this.config)) {
      const pairingCode = request?.pairingCode ?? 'unknown';
      return [
        'Your Signal pairing request has been recorded.',
        '',
        `Pairing code: ${pairingCode}`,
        '',
        'Enter this code in the Mercury terminal to finish setup.',
      ].join('\n');
    }

    return 'Your Signal access request has been recorded and is waiting for approval from an admin.';
  }

  private resetAccess(): void {
    clearSignalAccess(this.config);
    saveConfig(this.config);
    logger.info('Signal access reset');
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
}
