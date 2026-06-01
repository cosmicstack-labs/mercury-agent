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
  hasSignalAdmins,
  rejectSignalPendingRequest,
  saveConfig,
} from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { formatToolStep, formatToolResult } from '../utils/tool-label.js';
import { redactPhone, redactUuid, redactIdentity } from '../utils/redact.js';
import { mdToSignal } from '../utils/markdown.js';

const MAX_MESSAGE_LENGTH = 4000;
const SEND_TIMEOUT_MS = 20_000;
const SEND_MAX_ATTEMPTS = 3;
const INTER_MESSAGE_DELAY_MS = 350;

// How long the server holds an empty /v1/receive request open before returning
// (true long-poll). The client adds a safety margin on top so a wedged TCP
// connection can't hang the loop forever.
const RECEIVE_TIMEOUT_SEC = 30;
const RECEIVE_SAFETY_MS = (RECEIVE_TIMEOUT_SEC + 15) * 1000;
// Guard against signal-cli builds that ignore ?timeout= and return instantly:
// a tiny sleep prevents a hot reconnect loop in that degraded case.
const IDLE_GUARD_MS = 250;

type PendingReply = {
  resolve: (value: string) => void;
  timeout: NodeJS.Timeout;
};

export class SignalChannel extends BaseChannel {
  readonly type = 'signal' as const;
  private pollController: AbortController | null = null;
  private polling = false;
  // Receive transport: json-rpc mode exposes /v1/receive as a WebSocket and
  // delivers in real time; normal/native mode uses an HTTP long-poll. We detect
  // which at start() via /v1/about and pick the matching loop.
  private receiveMode: 'websocket' | 'longpoll' = 'longpoll';
  private ws: WebSocket | null = null;
  // Serialise envelope handling so WS messages are processed in arrival order,
  // matching the sequential behaviour of the HTTP long-poll path.
  private handleChain: Promise<void> = Promise.resolve();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectTimerReject: (() => void) | null = null;
  private reconnectAttempts = 0;
  // Below this many consecutive failures we log each retry at INFO; beyond it
  // we throttle to an occasional WARN so a long outage doesn't flood logs. We
  // never permanently give up — that would silently strand the channel.
  private reconnectLogThreshold = 20;
  private lastReconnectWarn = 0;
  private baseReconnectDelay = 2000;
  private shouldReconnect = true;

  // Permission / continuation prompts — keyed by sender phone number
  private pendingReplies = new Map<string, PendingReply>();
  private permissionModes = new Map<string, PermissionMode>();
  private onPermissionMode?: (mode: PermissionMode, source: string) => void;

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

  // ─── Lifecycle ───────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.polling) return;

    const { apiUrl, number } = this.config.channels.signal;
    if (!apiUrl || !number) {
      logger.warn('Signal API URL or number not set — skipping');
      return;
    }

    this.shouldReconnect = true;
    this.receiveMode = await this.detectReceiveMode(apiUrl);
    if (this.receiveMode === 'websocket') {
      this.startWebSocket();
    } else {
      this.startPolling();
    }
  }

  /**
   * signal-cli-rest-api runs in one of two modes. In "json-rpc" mode a single
   * persistent signal-cli daemon streams messages over a WebSocket at
   * /v1/receive — real time, no per-call config-file lock. In "normal"/"native"
   * mode each request spawns a fresh signal-cli that holds a lock, so we fall
   * back to HTTP long-poll. /v1/about reports the active mode.
   */
  private async detectReceiveMode(apiUrl: string): Promise<'websocket' | 'longpoll'> {
    try {
      const res = await fetch(`${apiUrl}/v1/about`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const about = (await res.json()) as { mode?: string };
        if (about?.mode === 'json-rpc') return 'websocket';
      }
    } catch (err: any) {
      logger.debug({ err: err?.message }, 'Signal: could not read /v1/about, defaulting to long-poll');
    }
    return 'longpoll';
  }

  async stop(): Promise<void> {
    this.shouldReconnect = false;
    this.polling = false;
    if (this.pollController) {
      this.pollController.abort();
      this.pollController = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch { /* already closing */ }
      this.ws = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Interrupt an in-flight backoff sleep so shutdown isn't blocked up to 60s.
    if (this.reconnectTimerReject) {
      this.reconnectTimerReject();
      this.reconnectTimerReject = null;
    }
    this.ready = false;
  }

  // ─── WebSocket receive (json-rpc mode) ───────────────────────

  private startWebSocket(): void {
    if (this.polling) return;
    this.polling = true;
    this.ready = true;
    this.reconnectAttempts = 0;
    logger.info('Signal: starting WebSocket receive loop (json-rpc mode)');
    this.webSocketLoop();
  }

  private async webSocketLoop(): Promise<void> {
    const { apiUrl, number } = this.config.channels.signal;
    // http(s)://host -> ws(s)://host, same /v1/receive path.
    const wsUrl = `${apiUrl.replace(/^http/, 'ws')}/v1/receive/${encodeURIComponent(number)}`;

    while (this.polling && this.shouldReconnect) {
      try {
        await this.runWebSocketOnce(wsUrl);
      } catch (err: any) {
        logger.debug({ err: err?.message }, 'Signal: websocket session ended with error');
      }
      if (!this.shouldReconnect) break;
      // Connection dropped (server restart, network blip). Back off and retry
      // indefinitely, exactly like the long-poll path.
      await this.pollBackoff();
    }

    this.polling = false;
    this.ready = false;
  }

  private runWebSocketOnce(wsUrl: string): Promise<void> {
    return new Promise<void>((resolve) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl);
      } catch (err: any) {
        logger.warn({ err: err?.message }, 'Signal: failed to open WebSocket');
        resolve();
        return;
      }
      this.ws = ws;

      ws.onopen = () => {
        this.reconnectAttempts = 0;
        logger.info('Signal: WebSocket receive connected');
      };

      ws.onmessage = (ev: MessageEvent) => {
        let data: any;
        try {
          const raw = typeof ev.data === 'string' ? ev.data : String(ev.data);
          data = JSON.parse(raw);
        } catch {
          return; // ignore non-JSON frames (e.g. keep-alives)
        }
        // Serialise handling to preserve arrival order.
        this.handleChain = this.handleChain
          .then(() => this.handleEnvelope(data))
          .catch((err: any) => logger.warn({ err: err?.message }, 'Signal: error handling envelope'));
      };

      ws.onerror = () => {
        // The close event always follows; let it drive reconnect.
      };

      ws.onclose = () => {
        if (this.ws === ws) this.ws = null;
        if (this.shouldReconnect) {
          logger.warn('Signal: WebSocket receive closed, will reconnect');
        }
        resolve();
      };
    });
  }

  // ─── HTTP long-poll receive (normal/native mode) ─────────────

  private startPolling(): void {
    if (this.polling) return;
    this.polling = true;
    this.ready = true;
    this.reconnectAttempts = 0;
    logger.info({ timeoutSec: RECEIVE_TIMEOUT_SEC }, 'Signal: starting HTTP long-poll receive loop');
    this.pollLoop();
  }

  private async pollLoop(): Promise<void> {
    const { apiUrl, number } = this.config.channels.signal;
    // Server-side long-poll: the API holds the request open up to RECEIVE_TIMEOUT_SEC
    // seconds and returns [] if nothing arrives, instead of returning immediately.
    const receiveUrl = `${apiUrl}/v1/receive/${encodeURIComponent(number)}?timeout=${RECEIVE_TIMEOUT_SEC}`;

    while (this.polling && this.shouldReconnect) {
      this.pollController = new AbortController();
      // Combine the stop() abort with a client-side safety timeout so a hung
      // connection (server never responds) is torn down and retried.
      const safety = AbortSignal.timeout(RECEIVE_SAFETY_MS);
      const signal = AbortSignal.any([this.pollController.signal, safety]);
      try {
        const response = await fetch(receiveUrl, {
          signal,
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
              await this.handleEnvelope(envelope);
            } catch (err: any) {
              logger.warn({ err: err.message }, 'Signal: error handling envelope');
            }
          }
        }

        // With a working long-poll the server already blocked for us. Only pause
        // briefly for builds that ignore ?timeout= and return instantly when empty.
        if (!envelopes || envelopes.length === 0) {
          await new Promise((r) => setTimeout(r, IDLE_GUARD_MS));
        }
      } catch (err: any) {
        if (err.name === 'AbortError' || err.name === 'TimeoutError') {
          if (!this.shouldReconnect) {
            // Intentional abort (stop() called) — leave the loop.
            break;
          }
          // Safety timeout fired on a wedged connection: reconnect immediately
          // without backoff, since this isn't a server/network failure.
          logger.debug('Signal: receive poll exceeded safety timeout, reconnecting');
          continue;
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

    // Exponential backoff capped at 60s. We retry indefinitely — losing the
    // connection should degrade latency, never permanently silence the channel.
    const delay = Math.min(
      this.baseReconnectDelay * Math.pow(2, Math.min(this.reconnectAttempts, 5)),
      60_000,
    );
    this.reconnectAttempts++;

    if (this.reconnectAttempts <= this.reconnectLogThreshold) {
      logger.info({ attempt: this.reconnectAttempts, delayMs: delay }, 'Signal: backing off before next poll');
    } else if (Date.now() - this.lastReconnectWarn > 5 * 60_000) {
      this.lastReconnectWarn = Date.now();
      logger.warn(
        { attempt: this.reconnectAttempts, delayMs: delay },
        'Signal: still retrying receive connection after extended outage',
      );
    }

    // Interruptible sleep: stop() rejects this so shutdown never waits out a 60s delay.
    await new Promise<void>((resolve, reject) => {
      this.reconnectTimerReject = () => {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        reject(new Error('reconnect-aborted'));
      };
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.reconnectTimerReject = null;
        resolve();
      }, delay);
    }).catch(() => {
      // Aborted by stop(); the poll loop's while-condition will exit cleanly.
    });
  }

  // ─── Incoming Message Handling ──────────────────────────────

  private async handleEnvelope(envelope: any): Promise<void> {
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

    // Extract text and group info from either dataMessage (incoming from
    // others) or syncMessage.sentMessage (self-sent from phone).
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

    // Text-only channel (parity with Telegram): ignore messages without text.
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
      // No group configured yet — nothing to route to.
      logger.debug('Signal: no group configured, ignoring');
      return;
    }

    // Check if this is a reply to a pending prompt (text replies only)
    const pendingReply = text ? this.pendingReplies.get(source) : undefined;
    if (pendingReply && text) {
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
        sourcePhone: redactPhone(sourcePhone),
        sourceUuid: redactUuid(sourceUuid),
        sourceName,
        matchKey: redactIdentity(source),
        approved: !!approvedUser,
        role: approvedUser ? (isAdmin ? 'admin' : 'member') : 'none',
        textPreview: (text || '').slice(0, 40),
      },
      'Signal: access-control decision',
    );

    if (!approvedUser) {
      this.handleUnapprovedMessage({ source, sourcePhone, sourceUuid, sourceName }, text || '');
      return;
    }

    // Commands (text messages only)
    const command = text && text.startsWith('/') ? text.split(/\s+/)[0].toLowerCase() : null;

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
        // Propagate to the permission engine so "Allow All" actually takes
        // effect at tool-execution time (mirrors the Telegram wiring).
        this.onPermissionMode?.(mode, source);
      }).catch(() => {});
      return;
    }

    if (command === '/access') {
      const summary = getSignalAccessSummary(this.config);
      this.sendToGroup(`Signal access: ${summary}`);
      return;
    }

    // Admin commands: "approve +number", "/approve +number", "/signal approve +number"
    if (text) {
      const adminText = text.replace(/^\/(signal\s+)?/i, '').trim();
      if (/^(approve|reject)\s/i.test(adminText) && this.handleAdminCommand(source, adminText)) {
        return;
      }
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

  private async handleUnapprovedMessage(
    identity: { source: string; sourcePhone?: string; sourceUuid?: string; sourceName?: string },
    text: string,
  ): Promise<void> {
    const { source, sourcePhone, sourceUuid, sourceName } = identity;
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
      // Store the phone number when we have one; otherwise fall back to the
      // UUID so the request still has a stable, matchable identifier.
      phoneNumber: sourcePhone || source,
      uuid: sourceUuid,
      name: sourceName,
      pairingCode: hasSignalAdmins(this.config) ? undefined : this.generatePairingCode(),
    });
    saveConfig(this.config);
    logger.info(
      { source: redactIdentity(source), sourcePhone: redactPhone(sourcePhone), sourceUuid: redactUuid(sourceUuid) },
      'Signal access request recorded',
    );

    await this.sendToGroup(this.getPendingStatusMessage(request));

    if (hasSignalAdmins(this.config)) {
      await this.notifyAdminsOfPendingRequest(request);
    }
  }

  private async notifyAdminsOfPendingRequest(request: SignalPendingRequest): Promise<void> {
    // Prefer the phone number as the approve/reject token, but fall back to the
    // UUID for members who joined the group without sharing their number.
    const token = request.phoneNumber || request.uuid || '';
    const who = request.name ? `${request.name} (${token})` : token;
    const message = [
      'Signal access request pending approval.',
      '',
      `From: ${who}`,
      `Requested: ${new Date(request.requestedAt).toLocaleString()}`,
      '',
      `Reply "approve ${token}" or "reject ${token}" to respond.`,
    ].join('\n');

    // Notify in the group
    await this.sendToGroup(message);
  }

  // ─── Sending ────────────────────────────────────────────────

  /**
   * Resilient POST to the signal-cli-rest-api /v2/send endpoint.
   * Adds a timeout and retries with exponential backoff on network errors,
   * 5xx, and 429 (rate limit). Returns true on success.
   */
  private async signalPost(payload: Record<string, unknown>, label: string): Promise<boolean> {
    const { apiUrl } = this.config.channels.signal;
    const url = `${apiUrl}/v2/send`;

    // Render native Signal formatting (bold/italic/monospace/etc.) for every
    // send path. signal-cli interprets the message markup in "styled" mode.
    const requestBody = JSON.stringify({ text_mode: 'styled', ...payload });

    let lastError = '';
    for (let attempt = 1; attempt <= SEND_MAX_ATTEMPTS; attempt++) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: requestBody,
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });

        if (response.ok) return true;

        const body = await response.text().catch(() => '');
        lastError = `${response.status} ${body}`;

        // Retry on rate limit and server errors; give up on client errors (4xx).
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable) {
          logger.warn({ status: response.status, body, label }, `Signal: ${label} failed (no retry)`);
          return false;
        }
      } catch (err: any) {
        lastError = err?.message || String(err);
      }

      if (attempt < SEND_MAX_ATTEMPTS) {
        const delay = 500 * Math.pow(2, attempt - 1); // 500ms, 1s
        logger.debug({ label, attempt, delay, lastError }, `Signal: ${label} retrying`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    logger.error({ label, attempts: SEND_MAX_ATTEMPTS, lastError }, `Signal: ${label} failed after retries`);
    return false;
  }

  /** Send a message to the configured Mercury group */
  async sendToGroup(message: string): Promise<void> {
    const { number, groupId } = this.config.channels.signal;
    if (!groupId) {
      logger.warn('Signal: no group configured, cannot send');
      return;
    }
    await this.signalPost({ message: mdToSignal(message), number, recipients: [groupId] }, 'sendToGroup');
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
    for (let i = 0; i < chunks.length; i++) {
      await this.sendToGroup(chunks[i]);
      // Light rate limiting between chunks to avoid flooding signal-cli-rest-api.
      if (i < chunks.length - 1) {
        await new Promise((r) => setTimeout(r, INTER_MESSAGE_DELAY_MS));
      }
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

    const fileBuffer = await fs.promises.readFile(resolved);
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
    const target = this.resolvePromptTarget(targetId);
    if (!target) return 'no'; // No one to ask → safe default.

    const message = `${prompt}\n\n@${target.name}, reply: yes / no / always`;
    await this.sendToGroup(message);

    return this.waitForReply(target.source, 120_000, 'no');
  }

  async askToContinue(question: string, targetId?: string): Promise<boolean> {
    const target = this.resolvePromptTarget(targetId);
    if (!target) return false; // No one to ask → safe default.

    const message = `${question}\n\n@${target.name}, reply: yes / no`;
    await this.sendToGroup(message);

    const reply = await this.waitForReply(target.source, 120_000, 'no');
    return reply === 'yes' || reply === 'y' || reply === 'continue';
  }

  async askPermissionMode(targetId?: string): Promise<PermissionMode> {
    const target = this.resolvePromptTarget(targetId);
    if (!target) return 'ask-me'; // No one to ask → safest mode.

    const message = [
      'Permission Mode',
      `@${target.name}, how should Mercury handle risky actions this session?`,
      '',
      '1. Ask Me — confirm before file writes, commands, and scope changes',
      '2. Allow All — auto-approve everything',
      '',
      'Reply: 1 or 2',
    ].join('\n');
    await this.sendToGroup(message);

    const reply = await this.waitForReply(target.source, 120_000, '1');
    return reply === '2' || reply === 'allow-all' || reply === 'allow all' ? 'allow-all' : 'ask-me';
  }

  /**
   * Resolve who a permission/continuation prompt should be bound to.
   * - If a specific sender triggered the task (targetId = signal:<source>),
   *   bind the prompt to THAT person so only they can answer.
   * - Otherwise fall back to the first admin (owner) — NEVER the bot's own
   *   number, which would make the prompt impossible to answer (silent timeout).
   * - If there is no one to ask, return null so the caller uses a safe default.
   */
  private resolvePromptTarget(targetId?: string): { source: string; name: string } | null {
    if (targetId?.startsWith('signal:')) {
      const source = targetId.split(':')[1];
      if (source) {
        const user = findSignalApprovedUser(this.config, source);
        return { source, name: user?.name || source };
      }
    }
    const admins = this.config.channels.signal.admins;
    if (admins.length > 0) {
      const owner = admins[0];
      const source = owner.phoneNumber || owner.uuid;
      if (source) return { source, name: owner.name || source };
    }
    return null;
  }

  /**
   * Interactive single-choice prompt. Signal has no inline buttons, so we send
   * a numbered list and wait for the user to reply with a number (text
   * equivalent of Telegram's inline keyboard). Returns the chosen label.
   */
  async requestChoice(question: string, choices: string[], targetId?: string): Promise<string> {
    if (choices.length === 0) return '';
    const target = this.resolvePromptTarget(targetId);
    if (!target) return choices[0];

    const message = [
      question,
      '',
      ...choices.map((c, i) => `${i + 1}. ${c}`),
      '',
      `Reply: 1${choices.length > 1 ? `-${choices.length}` : ''}`,
    ].join('\n');
    await this.sendToGroup(message);

    const reply = await this.waitForReply(target.source, 120_000, '1');
    const index = parseInt(reply.trim(), 10);
    if (!isNaN(index) && index >= 1 && index <= choices.length) {
      return choices[index - 1];
    }
    // Allow replying with the option text itself.
    const byLabel = choices.find((c) => c.toLowerCase() === reply.trim().toLowerCase());
    return byLabel ?? choices[0];
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

  usesTaskBuffering(): boolean {
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

    // Surface any system notices (budget warnings, scope changes, etc.) that
    // were buffered during the task instead of silently dropping them.
    const notices = this.statusNotices.get(key) || [];
    if (notices.length > 0) {
      lines.push('');
      lines.push(...notices.map(n => `  ${n}`));
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

    const trimmed = text.trim();

    // Token may be a phone number (+1555…) or a Signal UUID/ACI (8-4-4-4-12 hex).
    const approveMatch = trimmed.match(/^approve\s+(\+?[\d-]+|[0-9a-f-]{36})$/i);
    if (approveMatch) {
      const token = this.normalizeAccessToken(approveMatch[1]);
      const approved = approveSignalPendingRequest(this.config, token, 'member');
      if (approved) {
        saveConfig(this.config);
        this.sendToGroup(`Approved Signal access for ${approved.name || token}.`);
      } else {
        this.sendToGroup(`No pending request found for ${token}.`);
      }
      return true;
    }

    const rejectMatch = trimmed.match(/^reject\s+(\+?[\d-]+|[0-9a-f-]{36})$/i);
    if (rejectMatch) {
      const token = this.normalizeAccessToken(rejectMatch[1]);
      const rejected = rejectSignalPendingRequest(this.config, token);
      if (rejected) {
        saveConfig(this.config);
        this.sendToGroup(`Rejected Signal access for ${rejected.name || token}.`);
      } else {
        this.sendToGroup(`No pending request found for ${token}.`);
      }
      return true;
    }

    return false;
  }

  /**
   * Normalize an approve/reject token. Phone numbers get a leading "+";
   * UUIDs are lowercased and left otherwise untouched.
   */
  private normalizeAccessToken(raw: string): string {
    const isUuid = /^[0-9a-f-]{36}$/i.test(raw);
    if (isUuid) return raw.toLowerCase();
    return raw.startsWith('+') ? raw : `+${raw}`;
  }

  getPermissionMode(phoneNumber: string): PermissionMode {
    return this.permissionModes.get(phoneNumber) ?? 'ask-me';
  }

  setOnPermissionMode(handler: (mode: PermissionMode, source: string) => void): void {
    this.onPermissionMode = handler;
  }

  // ─── HTTP Helpers (signal-cli-rest-api) ─────────────────────

  private async sendToNumber(recipient: string, message: string): Promise<void> {
    const { number } = this.config.channels.signal;
    await this.signalPost({ message: mdToSignal(message), number, recipients: [recipient] }, 'sendToNumber');
  }

  private async sendWithAttachment(recipient: string, filename: string, base64Data: string): Promise<void> {
    const { number } = this.config.channels.signal;
    const ok = await this.signalPost(
      { message: filename, number, recipients: [recipient], base64_attachments: [base64Data] },
      'sendWithAttachment',
    );
    if (ok) logger.info({ file: filename, recipient: redactIdentity(recipient) }, 'File sent via Signal');
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
