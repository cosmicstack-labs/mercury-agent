import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import type { AnyMessageContent, WAMessage, ConnectionState, WAVersion, GroupMetadata } from '@whiskeysockets/baileys';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  makeCacheableSignalKeyStore,
  isJidGroup,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import type { ChannelMessage } from '../types/channel.js';
import { BaseChannel, type PermissionMode } from './base.js';
import type { MercuryConfig } from '../utils/config.js';
import { loadConfig, saveConfig } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { WhatsAppRateLimiter } from '../whatsapp/rate-limiter.js';
import { authDirExists, ensureAuthDir as ensureAuthDirFn, deleteAuthDir, validateAuthState } from '../whatsapp/auth.js';

function getAuthDir(): string {
  return ensureAuthDirFn();
}

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

export class WhatsAppChannel extends BaseChannel {
  readonly type = 'whatsapp' as const;
  private sock: ReturnType<typeof makeWASocket> | null = null;
  private rateLimiter = new WhatsAppRateLimiter();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private pairingComplete = false;
  private qrDisplayed = false;
  private pairingResolve: ((success: boolean) => void) | null = null;
  private sentMessageIds = new Set<string>();
  private pendingReplies = new Map<string, PendingReply>();
  private permissionModes = new Map<string, PermissionMode>();
  private onPermissionMode?: (mode: PermissionMode, source: string) => void;
  private configReloadInterval: NodeJS.Timeout | null = null;

  private stepCounters = new Map<string, number>();
  private stepHistory = new Map<string, string[]>();
  private taskActive = new Map<string, boolean>();
  private deferredResponses = new Map<string, string>();
  private statusNotices = new Map<string, string[]>();
  private static readonly MAX_STATUS_NOTICES = 3;

  private chatCommandContext?: import('../capabilities/registry.js').ChatCommandContext;

  private boundConnectionUpdate: (update: Partial<ConnectionState>) => Promise<void>;
  private boundIncomingMessages: (data: { messages: WAMessage[]; type: string }) => void;

  private connecting = false;

  constructor(private config: MercuryConfig) {
    super();
    this.boundConnectionUpdate = this.handleConnectionUpdate.bind(this);
    this.boundIncomingMessages = this.handleIncomingMessages.bind(this);
  }

  setChatCommandContext(ctx: import('../capabilities/registry.js').ChatCommandContext): void {
    this.chatCommandContext = ctx;
  }

  setOnPermissionMode(fn: (mode: PermissionMode, source: string) => void): void {
    this.onPermissionMode = fn;
  }

  beginTask(targetId?: string): void {
    const key = targetId || 'default';
    this.taskActive.set(key, true);
    this.stepCounters.set(key, 0);
    this.stepHistory.set(key, []);
    this.deferredResponses.delete(key);
    this.statusNotices.delete(key);
  }

  endTask(targetId?: string): void {
    const key = targetId || 'default';
    this.taskActive.delete(key);
    this.stepCounters.delete(key);
    this.stepHistory.delete(key);
    this.deferredResponses.delete(key);
    this.statusNotices.delete(key);
  }

  /**
   * Resolve the JID to send messages to.
   * In group mode: the configured WhatsApp group JID.
   * In self mode: the admin's own JID (self-chat).
   */
  private getTargetJid(): string | null {
    const wa = this.config.channels.whatsapp;
    if (wa.mode === 'group') {
      return wa.groupId || null;
    }
    return wa.admin?.jid || null;
  }

  /**
   * Auto-detect a WhatsApp group named "Mercury" (or configured groupName).
   * Called after successful connection. Stores groupId in config if found.
   */
  async detectGroup(): Promise<{ groupId: string; groupName: string } | null> {
    if (!this.sock) return null;
    const wa = this.config.channels.whatsapp;
    const targetName = (wa.groupName || 'Mercury').toLowerCase().trim();
    try {
      const groups = await this.sock.groupFetchAllParticipating();
      for (const [gid, meta] of Object.entries(groups)) {
        const name = (meta.subject || '').toLowerCase().trim();
        if (name === targetName) {
          const freshConfig = loadConfig();
          freshConfig.channels.whatsapp.groupId = gid;
          freshConfig.channels.whatsapp.groupName = meta.subject || 'Mercury';
          saveConfig(freshConfig);
          this.config = freshConfig;
          logger.info({ groupId: gid, groupName: meta.subject }, 'WhatsApp: group detected');
          return { groupId: gid, groupName: meta.subject || 'Mercury' };
        }
      }
      logger.info({ targetName, groupCount: Object.keys(groups).length }, 'WhatsApp: group not found');
    } catch (err) {
      logger.warn({ err }, 'WhatsApp: failed to fetch groups');
    }
    return null;
  }

  /**
   * List all groups the account participates in (for CLI display).
   */
  async listGroups(): Promise<{ groupId: string; groupName: string }[]> {
    if (!this.sock) return [];
    try {
      const groups = await this.sock.groupFetchAllParticipating();
      return Object.entries(groups).map(([gid, meta]) => ({
        groupId: gid,
        groupName: meta.subject || '(unnamed)',
      }));
    } catch {
      return [];
    }
  }

  private allowPairing = false;

  async start(): Promise<void> {
    if (this.ready || this.connecting) {
      logger.info({ ready: this.ready, connecting: this.connecting }, 'WhatsApp: start() called but already running/connecting, skipping');
      return;
    }
    this.connecting = true;
    const freshConfig = loadConfig();
    this.config = freshConfig;

    if (!freshConfig.channels.whatsapp.enabled) {
      logger.info('WhatsApp: channel disabled, not starting');
      return;
    }

    if (!freshConfig.channels.whatsapp.phoneNumber) {
      logger.warn('WhatsApp: no phone number configured, not starting');
      return;
    }

    // If paired but auth data is missing/invalid, mark as unpaired
    if (freshConfig.channels.whatsapp.paired && !validateAuthState()) {
      logger.warn('WhatsApp: config says paired but auth data missing/invalid, marking as unpaired');
      freshConfig.channels.whatsapp.paired = false;
      freshConfig.channels.whatsapp.admin = null;
      saveConfig(freshConfig);
      this.config = freshConfig;
    }

    // If not paired and not explicitly pairing, skip — don't show QR on daemon start
    if (!freshConfig.channels.whatsapp.paired && !this.allowPairing) {
      logger.info('WhatsApp: not paired, skipping channel start (run "mercury whatsapp pair" to pair)');
      return;
    }

    // Ensure auth directory exists (needed for both fresh pairing and reconnection)
    ensureAuthDirFn();
    this.qrDisplayed = false;
    this.pairingComplete = false;
    await this.connectToWhatsApp();
    this.startConfigReload();
    this.connecting = false;
    logger.info('WhatsApp: channel started');
  }

  /**
   * Start in pairing mode — will show QR code even if not paired.
   * Used by `mercury whatsapp pair` and the onboarding flow.
   */
  async startForPairing(): Promise<void> {
    this.allowPairing = true;
    await this.start();
  }

  private async connectToWhatsApp(): Promise<void> {
    try {
      // Clean up old socket before creating a new one
      if (this.sock) {
        try {
          this.sock.ev.off('connection.update', this.boundConnectionUpdate);
          this.sock.ev.off('messages.upsert', this.boundIncomingMessages);
          await this.sock.end(new Error('Reconnecting'));
        } catch {
          // ignore cleanup errors
        }
        this.sock = null;
      }

      const { state, saveCreds } = await useMultiFileAuthState(getAuthDir());
      let version: WAVersion | undefined;
      try {
        const versionResult = await fetchLatestBaileysVersion();
        version = versionResult.version;
        logger.info({ version: version.join('.') }, 'WhatsApp: fetched latest version');
      } catch (err) {
        logger.warn({ err }, 'WhatsApp: could not fetch latest version, using default');
      }

      const baileysLogger = pino({ level: 'fatal' }, pino.destination(1));

      this.sock = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
        },
        browser: Browsers.macOS('Desktop'),
        connectTimeoutMs: 60_000,
        keepAliveIntervalMs: 25_000,
        qrTimeout: 60_000,
        markOnlineOnConnect: true,
        syncFullHistory: true,
        printQRInTerminal: false,
        getMessage: async () => undefined,
        logger: baileysLogger,
      });

      this.sock.ev.on('connection.update', this.boundConnectionUpdate);
      this.sock.ev.on('creds.update', saveCreds);
      this.sock.ev.on('messages.upsert', this.boundIncomingMessages);
    } catch (err) {
      logger.error({ err }, 'WhatsApp: failed to connect');
      this.ready = false;
    }
  }

  private async handleConnectionUpdate(update: Partial<ConnectionState>): Promise<void> {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !this.pairingComplete && !this.qrDisplayed) {
      this.qrDisplayed = true;
      logger.info('WhatsApp: QR code received, displaying...');
      qrcode.generate(qr, { small: true });
      console.log('\n  Scan this QR code with WhatsApp > Linked Devices > Link a device\n');
    }

    if (connection === 'open') {
      logger.info('WhatsApp: connected successfully');
      this.pairingComplete = true;
      this.qrDisplayed = false;
      this.reconnectAttempts = 0;
      this.ready = true;

      // Mark as paired (device linked) — admin is set via /pair command in the group
      if (this.sock?.user) {
        const freshConfig = loadConfig();
        freshConfig.channels.whatsapp.paired = true;
        freshConfig.channels.whatsapp.registered = true;
        saveConfig(freshConfig);
        this.config = freshConfig;
        logger.info({ jid: this.sock.user.id }, 'WhatsApp: device linked');
      }

      // Auto-detect group in group mode (delayed to allow group metadata sync)
      if (this.config.channels.whatsapp.mode === 'group' && !this.config.channels.whatsapp.groupId) {
        setTimeout(() => this.detectGroup().then((detected) => {
          if (detected) {
            logger.info({ groupId: detected.groupId, groupName: detected.groupName }, 'WhatsApp: group auto-detected');
          } else {
            // Retry once more after a longer delay (group sync can be slow)
            setTimeout(() => this.detectGroup().then((d) => {
              if (d) {
                logger.info({ groupId: d.groupId, groupName: d.groupName }, 'WhatsApp: group auto-detected (retry)');
              } else {
                logger.info('WhatsApp: no group named "Mercury" found. Create one and restart Mercury.');
              }
            }), 10000);
          }
        }), 5000);
      }

      if (this.pairingResolve) {
        this.pairingResolve(true);
        this.pairingResolve = null;
      }
    }

    if (connection === 'close') {
      this.ready = false;
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;

      if (statusCode === DisconnectReason.loggedOut || statusCode === DisconnectReason.forbidden) {
        logger.error('WhatsApp: permanent disconnect (logged out or forbidden), not reconnecting');
        const freshConfig = loadConfig();
        freshConfig.channels.whatsapp.paired = false;
        freshConfig.channels.whatsapp.admin = null;
        saveConfig(freshConfig);
        this.config = freshConfig;

        if (this.pairingResolve) {
          this.pairingResolve(false);
          this.pairingResolve = null;
        }
        return;
      }

      if (statusCode === DisconnectReason.restartRequired) {
        logger.info('WhatsApp: restart required (515), reconnecting...');
        this.reconnectAttempts = 0;
        setTimeout(() => this.connectToWhatsApp(), 1000);
        return;
      }

      const shouldReconnect = statusCode !== DisconnectReason.loggedOut
        && statusCode !== DisconnectReason.forbidden;

      if (shouldReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30_000) + Math.random() * 5000;
        logger.info({ attempt: this.reconnectAttempts, delay: Math.round(delay), statusCode }, 'WhatsApp: reconnecting...');
        setTimeout(() => this.connectToWhatsApp(), delay);
      } else if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        logger.error('WhatsApp: max reconnect attempts reached, giving up');
        if (this.pairingResolve) {
          this.pairingResolve(false);
          this.pairingResolve = null;
        }
      }
    }
  }

  private async handleIncomingMessages({ messages, type }: { messages: WAMessage[]; type: string }): Promise<void> {
    if (type !== 'notify' && type !== 'append') return;

    const wa = this.config.channels.whatsapp;
    const targetJid = this.getTargetJid();
    if (!targetJid) return;

    for (const msg of messages) {
      const remoteJid = msg.key.remoteJid || '';
      const msgId = msg.key.id || '';

      // Skip messages we sent (Mercury's own replies)
      if (this.sentMessageIds.has(msgId)) continue;

      if (wa.mode === 'group') {
        // Group mode: only accept messages from the configured group
        if (remoteJid !== targetJid) continue;
      } else {
        // Self mode: accept fromMe messages (not groups, not broadcast)
        if (isJidGroup(remoteJid)) continue;
        if (remoteJid === 'status@broadcast') continue;
        if (!msg.key.fromMe) continue;
      }

      const text = this.extractText(msg);
      if (!text) continue;

      // Handle /pair command — record sender as admin
      const trimmed = text.trim().toLowerCase();
      if (trimmed === '/pair' || trimmed === '/start') {
        await this.handlePairCommand(msg, targetJid);
        continue;
      }

      // If admin hasn't paired yet, tell user to pair
      if (!wa.adminPaired || !wa.admin) {
        await this.send('⚠️ Not paired yet. Send /pair to register as admin.', targetJid);
        continue;
      }

      const channelMsg: ChannelMessage = {
        id: msg.key.id || String(Date.now()),
        channelId: `whatsapp:${targetJid}`,
        channelType: 'whatsapp',
        senderId: targetJid,
        senderName: this.config.channels.whatsapp.admin?.name || 'You',
        content: text,
        timestamp: typeof msg.messageTimestamp === 'number' ? msg.messageTimestamp : Date.now() / 1000,
        metadata: { key: msg.key },
      };

      this.emit(channelMsg);
    }
  }

  private async handlePairCommand(msg: WAMessage, targetJid: string): Promise<void> {
    // Get the sender's JID (the participant in the group)
    const senderJid = msg.key.participant || msg.key.remoteJid || '';
    if (!senderJid) {
      await this.send('❌ Could not determine your WhatsApp ID. Please try again.', targetJid);
      return;
    }

    // Get sender name from push name if available
    const senderName = (msg.pushName || undefined) as string | undefined;

    const freshConfig = loadConfig();
    const phoneNumber = freshConfig.channels.whatsapp.phoneNumber;
    freshConfig.channels.whatsapp.admin = {
      jid: senderJid,
      phoneNumber,
      name: senderName,
      pairedAt: new Date().toISOString(),
    };
    freshConfig.channels.whatsapp.paired = true;
    freshConfig.channels.whatsapp.registered = true;
    freshConfig.channels.whatsapp.adminPaired = true;
    saveConfig(freshConfig);
    freshConfig.channels.whatsapp.registered = true;
    saveConfig(freshConfig);
    this.config = freshConfig;

    logger.info({ senderJid, senderName }, 'WhatsApp: admin paired via /pair command');
    await this.send('✅ You are now the admin. Mercury is ready — send any message to chat.', targetJid);
  }

  private extractText(msg: WAMessage): string {
    if (!msg.message) return '';
    const m = msg.message;
    return m.conversation
      || m.extendedTextMessage?.text
      || m.imageMessage?.caption
      || m.videoMessage?.caption
      || m.documentMessage?.caption
      || m.buttonsResponseMessage?.selectedDisplayText
      || m.templateButtonReplyMessage?.selectedDisplayText
      || m.listResponseMessage?.title
      || '';
  }

  async waitForPairing(timeoutMs = 180_000): Promise<boolean> {
    if (this.pairingComplete) return true;
    return new Promise<boolean>((resolve) => {
      this.pairingResolve = resolve;
      setTimeout(() => {
        if (this.pairingResolve === resolve) {
          this.pairingResolve = null;
          resolve(false);
        }
      }, timeoutMs);
    });
  }

  /**
   * Wait for the user to send /pair in the WhatsApp group.
   * Polls config every 3 seconds for adminPaired to become true.
   * Returns true if admin paired, false if timed out.
   */
  async waitForAdminPairing(timeoutMs = 180_000): Promise<boolean> {
    const wa = this.config.channels.whatsapp;
    if (wa.adminPaired && wa.admin) return true;

    const interval = 3000;
    const maxChecks = Math.floor(timeoutMs / interval);

    for (let i = 0; i < maxChecks; i++) {
      await this.sleep(interval);
      const freshConfig = loadConfig();
      if (freshConfig.channels.whatsapp.adminPaired && freshConfig.channels.whatsapp.admin) {
        this.config = freshConfig;
        return true;
      }
    }
    return false;
  }

  async stop(): Promise<void> {
    this.configReloadInterval && clearInterval(this.configReloadInterval);
    this.rateLimiter.reset();
    if (this.sock) {
      try {
        await this.sock.end(new Error('Graceful shutdown'));
      } catch {
        // ignore
      }
      this.sock = null;
    }
    this.ready = false;
    logger.info('WhatsApp: channel stopped');
  }

  async send(content: string, targetId?: string, elapsedMs?: number): Promise<void> {
    const targetJid = this.getTargetJid();
    if (!targetJid) {
      logger.warn('WhatsApp: no target JID, cannot send');
      return;
    }

    const jid: string = targetId?.replace('whatsapp:', '') || targetJid;
    const chunks = this.splitMessage(content);

    for (const chunk of chunks) {
      const check = this.rateLimiter.checkRateLimit(jid);
      if (!check.allowed) {
        logger.warn({ jid, reason: check.reason }, 'WhatsApp: rate limited');
        continue;
      }

      await this.rateLimiter.enqueue(async () => {
        const sent = await this.sock!.sendMessage(jid, { text: chunk });
        const msgId = sent?.key?.id;
        if (msgId) {
          this.sentMessageIds.add(msgId);
          setTimeout(() => this.sentMessageIds.delete(msgId), 300_000);
        }
        this.rateLimiter.recordSend(jid);
      });

      if (chunks.length > 1) {
        await this.sleep(INTER_MESSAGE_DELAY_MS);
      }
    }
  }

  async sendFile(filePath: string, targetId?: string): Promise<void> {
    const targetJid = this.getTargetJid();
    if (!targetJid) {
      logger.warn('WhatsApp: no target JID, cannot send file');
      return;
    }

    const jid: string = targetId?.replace('whatsapp:', '') || targetJid;
    if (!fs.existsSync(filePath)) {
      logger.error({ filePath }, 'WhatsApp: file not found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const check = this.rateLimiter.checkRateLimit(jid);
    if (!check.allowed) {
      logger.warn({ jid, reason: check.reason }, 'WhatsApp: rate limited, cannot send file');
      await this.send(`⚠️ Rate limited, could not send file: ${path.basename(filePath)}`, targetId);
      return;
    }

    await this.rateLimiter.enqueue(async () => {
      let message: AnyMessageContent;
      const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
      const videoExts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
      const audioExts = ['.mp3', '.ogg', '.wav', '.m4a', '.flac'];

      if (imageExts.includes(ext)) {
        message = { image: { url: filePath }, caption: path.basename(filePath) };
      } else if (videoExts.includes(ext)) {
        message = { video: { url: filePath }, caption: path.basename(filePath) };
      } else if (audioExts.includes(ext)) {
        message = { audio: { url: filePath }, mimetype: 'audio/ogg' };
      } else {
        message = { document: { url: filePath }, fileName: path.basename(filePath), mimetype: 'application/octet-stream' };
      }

      const sent = await this.sock!.sendMessage(jid, message);
      const msgId = sent?.key?.id;
      if (msgId) {
        this.sentMessageIds.add(msgId);
        setTimeout(() => this.sentMessageIds.delete(msgId), 300_000);
      }
      this.rateLimiter.recordSend(jid);
    });
  }

  async stream(content: AsyncIterable<string>, targetId?: string): Promise<string> {
    const chunks: string[] = [];
    let currentMessageId: string | null = null;
    const targetJid = this.getTargetJid();
    if (!targetJid) return '';
    const jid: string = targetId?.replace('whatsapp:', '') || targetJid;

    let buffer = '';
    let lastEditTime = 0;
    const EDIT_INTERVAL_MS = 2500;
    const MAX_EDIT_LENGTH = 4096;

    for await (const token of content) {
      buffer += token;
      chunks.push(token);
      const now = Date.now();

      if (!currentMessageId && buffer.length > 20) {
        const check = this.rateLimiter.checkRateLimit(jid);
        if (check.allowed) {
          await this.rateLimiter.enqueue(async () => {
            const sent = await this.sock!.sendMessage(jid, { text: buffer.slice(0, MAX_EDIT_LENGTH) });
            const msgId = sent?.key?.id;
            if (msgId) {
              currentMessageId = msgId;
              this.sentMessageIds.add(msgId);
              setTimeout(() => this.sentMessageIds.delete(msgId), 300_000);
            }
            this.rateLimiter.recordSend(jid);
          });
        }
        lastEditTime = now;
      } else if (currentMessageId && now - lastEditTime > EDIT_INTERVAL_MS && buffer.length <= MAX_EDIT_LENGTH) {
        await this.sock!.sendMessage(jid, { text: buffer, edit: currentMessageId });
        lastEditTime = now;
      }
    }

    if (currentMessageId && buffer.length <= MAX_EDIT_LENGTH) {
      await this.sock!.sendMessage(jid, { text: buffer, edit: currentMessageId });
    } else if (!currentMessageId) {
      await this.send(buffer, targetId);
    } else {
      const remainder = buffer.slice(MAX_EDIT_LENGTH);
      if (remainder) await this.send(remainder, targetId);
    }

    return chunks.join('');
  }

  async typing(targetId?: string): Promise<void> {
    const targetJid = this.getTargetJid();
    if (!targetJid || !this.sock) return;
    const jid = targetId?.replace('whatsapp:', '') || targetJid;
    try {
      await this.sock.sendPresenceUpdate('composing', jid);
    } catch {
      // ignore presence errors
    }
  }

  async askToContinue(question: string, targetId?: string): Promise<boolean> {
    const targetJid = this.getTargetJid();
    if (!targetJid) return false;
    const jid = targetId?.replace('whatsapp:', '') || targetJid;

    await this.send(`❓ ${question}\n_Reply **yes** to continue or **no** to stop._`, targetId);

    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), 120_000);
      this.pendingReplies.set(jid, {
        resolve: (reply: string) => {
          clearTimeout(timeout);
          this.pendingReplies.delete(jid);
          const normalized = normalizeReply(reply);
          resolve(normalized === 'yes' || normalized === 'always');
        },
        timeout,
      });
    });
  }

  async askPermissionMode(): Promise<PermissionMode> {
    const targetJid = this.getTargetJid();
    if (!targetJid) return 'ask-me';
    return this.permissionModes.get(targetJid) || 'ask-me';
  }

  private splitMessage(text: string): string[] {
    if (text.length <= MAX_MESSAGE_LENGTH) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= MAX_MESSAGE_LENGTH) {
        chunks.push(remaining);
        break;
      }
      let splitAt = remaining.lastIndexOf('\n', MAX_MESSAGE_LENGTH);
      if (splitAt < MAX_MESSAGE_LENGTH * 0.5) splitAt = remaining.lastIndexOf(' ', MAX_MESSAGE_LENGTH);
      if (splitAt < MAX_MESSAGE_LENGTH * 0.5) splitAt = MAX_MESSAGE_LENGTH;
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trimStart();
    }
    return chunks;
  }

  private startConfigReload(): void {
    this.configReloadInterval = setInterval(() => {
      try {
        this.config = loadConfig();
      } catch {
        // ignore reload errors
      }
    }, 30_000);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getStatus(): { enabled: boolean; phoneNumber: string; paired: boolean; connected: boolean; admin: string | null; mode: string; groupId: string | null; groupName: string | null; rateLimit: { hourlyGlobal: number; dailyGlobal: number } } {
    const stats = this.rateLimiter.getStats();
    const wa = this.config.channels.whatsapp;
    return {
      enabled: wa.enabled,
      phoneNumber: wa.phoneNumber,
      paired: wa.paired,
      connected: this.ready,
      admin: wa.admin?.phoneNumber || null,
      mode: wa.mode,
      groupId: wa.groupId || null,
      groupName: wa.groupName || null,
      rateLimit: { hourlyGlobal: stats.hourlyGlobal, dailyGlobal: stats.dailyGlobal },
    };
  }
}