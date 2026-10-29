import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import type { MercuryConfig } from '../utils/config.js';
import type { ChannelType } from '../types/channel.js';
import { logger } from '../utils/logger.js';
import { BaseChannel } from './base.js';

/**
 * A native ntfy channel: Mercury's alerts become phone notifications (ADR-031).
 *
 * Every other channel is a two-way chat — Discord wants a bot token, a guild, an
 * admin role and a pairing dance before it can say anything, and it puts bot alerts
 * in the middle of a conversation. ntfy is the opposite: one HTTP request to
 * `<url>/<topic>`, the phone shows a notification, and nothing is ever read back.
 *
 * Deliberately one-way. `noBroadcast` keeps ordinary replies out (a push per
 * assistant message would be noise), and nothing inbound is parsed: ntfy is a
 * doorbell, not a chat.
 */
export class NtfyChannel extends BaseChannel {
  readonly type: ChannelType = 'ntfy';

  /** Not a chat surface: only alerts and scheduled-task notices are published. */
  readonly noBroadcast = true;

  private readonly baseUrl: string;
  private readonly topic: string;
  private readonly token: string;
  private readonly priority: string;
  private readonly tags: string;

  constructor(config: MercuryConfig) {
    super();
    this.baseUrl = config.channels.ntfy.url.trim().replace(/\/+$/, '');
    this.topic = config.channels.ntfy.topic.trim();
    this.token = config.channels.ntfy.token ?? '';
    this.priority = config.channels.ntfy.priority;
    this.tags = config.channels.ntfy.tags;
  }

  async start(): Promise<void> {
    if (!this.baseUrl || !this.topic) {
      logger.warn('NTFY_ENABLED is set but NTFY_URL or NTFY_TOPIC is empty — alerts stay local.');
      this.ready = false;
      return;
    }
    if (!/^https?:\/\//i.test(this.baseUrl)) {
      logger.warn('NTFY_URL must be an http(s) URL — alerts stay local.');
      this.ready = false;
      return;
    }
    // The topic is a path segment: a slash or a query would silently post elsewhere.
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(this.topic)) {
      logger.warn('NTFY_TOPIC must be a single path segment (letters, digits, - and _) — alerts stay local.');
      this.ready = false;
      return;
    }
    this.ready = true;
    logger.info({ host: safeHost(this.baseUrl), topic: this.topic }, 'ntfy ready for alerts');
  }

  async stop(): Promise<void> {
    this.ready = false;
  }

  async send(content: string): Promise<void> {
    if (!this.ready) return;
    const response = await fetch(this.topicUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        Title: 'Mercury',
        Priority: this.priority,
        ...(this.tags ? { Tags: this.tags } : {}),
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      body: content,
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      throw new Error(`ntfy answered HTTP ${response.status}`);
    }
  }

  /**
   * Files go as ntfy attachments (`PUT` with `Filename`), which the phone can open.
   * If the server refuses (attachments disabled, too large) we say the name instead of
   * dropping the alert — an alert about a file is still more useful than silence.
   */
  async sendFile(filePath: string): Promise<void> {
    if (!this.ready) return;
    const name = basename(filePath);
    let bytes: Buffer;
    try {
      bytes = readFileSync(filePath);
    } catch {
      await this.send(`📎 ${name} (introuvable sur le disque)`);
      return;
    }
    const response = await fetch(this.topicUrl(), {
      method: 'PUT',
      headers: {
        Filename: name,
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      body: new Uint8Array(bytes),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      let size = bytes.length;
      try {
        size = statSync(filePath).size;
      } catch {
        /* keep the byte count we already hold */
      }
      await this.send(`📎 ${name} (${Math.round(size / 1024)} KB) — pièce jointe refusée par le serveur ntfy`);
    }
  }

  /** One message at the end: a notification is not a terminal to stream into. */
  async stream(content: AsyncIterable<string>): Promise<string> {
    let full = '';
    for await (const chunk of content) full += chunk;
    if (full.trim()) await this.send(full);
    return full;
  }

  async typing(): Promise<void> {
    // Nothing to type into.
  }

  async askToContinue(): Promise<boolean> {
    // No way to answer through a one-way push; callers fall back to their default.
    return false;
  }

  private topicUrl(): string {
    return `${this.baseUrl}/${this.topic}`;
  }
}

/** Host only — the topic is a path and the URL may carry credentials. */
function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '(invalid url)';
  }
}
