import type { MercuryConfig } from '../utils/config.js';
import { saveConfig } from '../utils/config.js';
import https from 'node:https';

/**
 * IPv4-only fetch wrapper. Node's built-in fetch (undici) fails on Cloudflare
 * domains when IPv6 is unreachable — it doesn't gracefully fall back to IPv4.
 * This uses the native https module with family:4 to avoid the issue.
 */
function ipv4Fetch(url: string, options: { method: string; headers: Record<string, string>; body?: string }): Promise<Response> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method: options.method,
      family: 4,
      headers: {
        ...options.headers,
        ...(options.body ? { 'Content-Length': Buffer.byteLength(options.body).toString() } : {}),
      },
      timeout: 15000,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        resolve(new Response(body, {
          status: res.statusCode ?? 500,
          statusText: res.statusMessage ?? '',
          headers: res.headers as Record<string, string>,
        }));
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

type EventHandler = (data: unknown) => void;

export interface RelayUser {
  username: string;
  display_name: string | null;
}

export interface FriendInfo {
  username: string;
  display_name: string | null;
  friends_since: number;
}

export interface PendingRequestInfo {
  request_id: string;
  created_at: number;
  target_user: RelayUser;
}

export interface FriendsResponse {
  friends: FriendInfo[];
  pending_sent: PendingRequestInfo[];
  pending_received: PendingRequestInfo[];
}

export interface MessageResult {
  delivered: boolean;
  sent_at?: number;
  to_user?: RelayUser;
  error?: string;
}

export interface MemoryQueryResult {
  forwarded: boolean;
  request_id?: string;
  error?: string;
}

export interface MemoryResponseResult {
  delivered: boolean;
  error?: string;
}

export interface MemoryResultItem {
  type: string;
  category: string;
  summary: string;
  detail?: string | null;
  confidence: number;
  importance: number;
}

export interface MemoryQueryEvent {
  type: 'MEMORY_QUERY';
  from_user: string;
  from_display_name: string | null;
  request_id: string;
  query: string;
}

export interface MemoryResponseEvent {
  type: 'MEMORY_RESPONSE';
  from_user: string;
  from_display_name: string | null;
  request_id: string;
  query: string;
  results: MemoryResultItem[];
}

export interface FriendRequestResult {
  request_id: string;
  status: string;
  target_online: boolean;
  target_user: RelayUser;
}

export const USERNAME_REGEX = /^[a-z0-9_]+$/;

export function validateUsernameLocal(username: string): { valid: boolean; error?: string } {
  const normalized = username.toLowerCase().trim();
  if (!normalized || normalized.length < 3) {
    return { valid: false, error: 'Username must be at least 3 characters' };
  }
  if (normalized.length > 20) {
    return { valid: false, error: 'Username must be at most 20 characters' };
  }
  if (!USERNAME_REGEX.test(normalized)) {
    return { valid: false, error: 'Username can only contain lowercase letters, numbers, and underscores' };
  }
  return { valid: true };
}

export class RelayClient {
  private ws: WebSocket | null = null;
  private url: string;
  private apiKey: string;
  private baseUrl: string;
  private config: () => MercuryConfig;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private handlers: Map<string, Set<EventHandler>> = new Map();
  private intentionalDisconnect = false;

  constructor(config: () => MercuryConfig) {
    this.config = config;
    const cfg = config();
    this.apiKey = cfg.relay?.apiKey ?? '';

    let url = (cfg.relay?.url ?? '').trim();
    url = url.replace(/^https?:\/\//, (m) => m === 'https://' ? 'wss://' : 'ws://');
    if (!url.endsWith('/v1/ws')) url = url.replace(/\/$/, '') + '/v1/ws';
    this.url = url;
    this.baseUrl = this.url.replace(/\/v1\/ws$/, '').replace(/^wss?/, 'https');
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  isRegistered(): boolean {
    return this.apiKey.length > 0;
  }

  isReconnecting(): boolean {
    return !this.intentionalDisconnect && this.reconnectTimer !== null;
  }

  async checkUsername(username: string): Promise<{ available: boolean; error?: string }> {
    const normalized = username.toLowerCase().trim();
    const res = await this.httpPost('/v1/check-username', { username: normalized });
    if (!res.ok) {
      const err = await res.json() as { error: string };
      return { available: false, error: err.error };
    }
    const data = await res.json() as { available: boolean };
    return { available: data.available };
  }

  async lookupChannel(type: string, id: string): Promise<{ registered: boolean }> {
    try {
      const res = await this.httpPost('/v1/lookup-channel', { type, id });
      if (!res.ok) return { registered: false };
      const data = await res.json() as { registered: boolean };
      return { registered: data.registered };
    } catch {
      // Network error — can't determine, assume not registered
      return { registered: false };
    }
  }

  async recover(username: string, displayName?: string, channels?: Array<{ type: string; id: string }>): Promise<{ apiKey: string; user: RelayUser }> {
    const res = await this.httpPost('/v1/recover', {
      username: username.toLowerCase().trim(),
      display_name: displayName || undefined,
      channels: channels || undefined,
    });
    if (!res.ok) {
      const err = await res.json() as { error: string };
      throw new Error(err.error || 'Recovery failed');
    }
    const data = await res.json() as { api_key: string; user: RelayUser };
    this.apiKey = data.api_key;

    const cfg = this.config();
    cfg.relay!.apiKey = data.api_key;
    cfg.relay!.username = data.user.username;
    saveConfig(cfg);

    return { apiKey: data.api_key, user: data.user };
  }

  async register(username: string, displayName?: string, channels?: Array<{ type: string; id: string }>): Promise<{ apiKey: string; user: RelayUser; recovered: boolean }> {
    const res = await this.httpPost('/v1/register', {
      username: username.toLowerCase().trim(),
      display_name: displayName || undefined,
      channels: channels || undefined,
    });
    if (!res.ok) {
      const err = await res.json() as { error: string };
      throw new Error(err.error || 'Registration failed');
    }
    const data = await res.json() as { api_key: string; user: RelayUser; recovered?: boolean };
    this.apiKey = data.api_key;

    // Use the server-returned username (may differ from input if account was recovered)
    const actualUsername = data.user.username || username.toLowerCase().trim();

    const cfg = this.config();
    cfg.relay!.apiKey = data.api_key;
    cfg.relay!.username = actualUsername;
    saveConfig(cfg);

    return { apiKey: data.api_key, user: data.user, recovered: !!data.recovered };
  }

  connect(): Promise<boolean> {
    if (!this.apiKey) return Promise.resolve(false);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve(true);

    this.intentionalDisconnect = false;

    return new Promise((resolve) => {
      let resolved = false;
      try {
        const fullUrl = `${this.url}?api_key=${this.apiKey}`;
        const ws = new WebSocket(fullUrl);

        const timeout = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            ws.close(1000, 'Connection timeout');
            resolve(false);
          }
        }, 30000);

        ws.onopen = () => {
          if (resolved) {
            ws.close(1000, 'Stale connection');
            return;
          }
          resolved = true;
          clearTimeout(timeout);
          this.ws = ws;
          this.reconnectAttempts = 0;
          this.startPing();
          this.emit('connected', null);

          ws.onmessage = (event) => {
            if (event.data === 'pong') return;
            try {
              const msg = JSON.parse(event.data as string);
              this.handleMessage(msg);
            } catch {}
          };

          ws.onclose = () => {
            this.ws = null;
            this.stopPing();
            this.emit('disconnected', null);
            if (!this.intentionalDisconnect) {
              this.scheduleReconnect();
            }
          };

          ws.onerror = () => {};

          resolve(true);
        };

        ws.onerror = () => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            resolve(false);
          }
        };
      } catch {
        if (!resolved) {
          resolved = true;
          resolve(false);
        }
      }
    });
  }

  disconnect(): void {
    this.intentionalDisconnect = true;
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.emit('disconnected', null);
  }

  on(event: string, handler: EventHandler): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);
  }

  off(event: string, handler: EventHandler): void {
    this.handlers.get(event)?.delete(handler);
  }

  async sendFriendRequest(username: string): Promise<FriendRequestResult> {
    const target = username.toLowerCase().trim().replace(/^@/, '');

    const res = await this.authedPost('/v1/friend-request', { to_user: target });
    if (!res.ok) {
      const err = await res.json() as { error: string; target_user?: RelayUser };
      throw Object.assign(new Error(err.error), { target_user: err.target_user });
    }
    return await res.json() as FriendRequestResult;
  }

  async approveRequest(fromUser: string): Promise<{ status: string; target_user: RelayUser }> {
    const res = await this.authedPost('/v1/approve-request', { from_user: fromUser });
    if (!res.ok) {
      const err = await res.json() as { error: string };
      throw new Error(err.error);
    }
    return await res.json() as { status: string; target_user: RelayUser };
  }

  async rejectRequest(fromUser: string): Promise<{ status: string; target_user: RelayUser }> {
    const res = await this.authedPost('/v1/reject-request', { from_user: fromUser });
    if (!res.ok) {
      const err = await res.json() as { error: string };
      throw new Error(err.error);
    }
    return await res.json() as { status: string; target_user: RelayUser };
  }

  async cancelRequest(toUser: string): Promise<{ status: string; target_user: RelayUser }> {
    const res = await this.authedPost('/v1/cancel-request', { to_user: toUser });
    if (!res.ok) {
      const err = await res.json() as { error: string };
      throw new Error(err.error);
    }
    return await res.json() as { status: string; target_user: RelayUser };
  }

  async deleteFriend(friendUser: string): Promise<{ status: string; target_user: RelayUser }> {
    const res = await this.authedPost('/v1/delete-friend', { friend_user: friendUser });
    if (!res.ok) {
      const err = await res.json() as { error: string };
      throw new Error(err.error);
    }
    return await res.json() as { status: string; target_user: RelayUser };
  }

  async sendMessage(toUser: string, content: string): Promise<MessageResult> {
    const res = await this.authedPost('/v1/message', { to_user: toUser, content });
    const data = await res.json() as MessageResult & { error?: string };
    if (!res.ok) {
      throw new Error(data.error || 'Failed to send message');
    }
    return data;
  }

  async sendMemoryQuery(toUser: string, query: string): Promise<MemoryQueryResult> {
    const target = toUser.toLowerCase().trim().replace(/^@/, '');
    const res = await this.authedPost('/v1/memory-query', { to_user: target, query });
    const data = await res.json() as MemoryQueryResult & { error?: string };
    if (!res.ok) {
      throw new Error(data.error || 'Failed to send memory query');
    }
    return data;
  }

  async sendMemoryResponse(toUser: string, requestId: string, query: string, results: MemoryResultItem[]): Promise<MemoryResponseResult> {
    const target = toUser.toLowerCase().trim().replace(/^@/, '');
    const res = await this.authedPost('/v1/memory-response', { to_user: target, request_id: requestId, query, results });
    const data = await res.json() as MemoryResponseResult & { error?: string };
    if (!res.ok) {
      throw new Error(data.error || 'Failed to send memory response');
    }
    return data;
  }

  async sendAccessRequest(toUser: string, categories: string[]): Promise<{ delivered: boolean }> {
    const target = toUser.toLowerCase().trim().replace(/^@/, '');
    const res = await this.authedPost('/v1/access-request', { to_user: target, categories });
    const data = await res.json() as { delivered: boolean; error?: string };
    if (!res.ok) {
      throw new Error(data.error || 'Failed to send access request');
    }
    return data;
  }

  async getFriends(): Promise<FriendsResponse> {
    const res = await this.authedGet('/v1/friends');
    if (!res.ok) {
      throw new Error('Failed to get friends');
    }
    return await res.json() as FriendsResponse;
  }

  async getUserStatus(username: string): Promise<{ username: string; online: boolean }> {
    const res = await this.authedGet(`/v1/status/${username}`);
    if (!res.ok) {
      throw new Error('Failed to get user status');
    }
    return await res.json() as { username: string; online: boolean };
  }

  async validateApiKey(): Promise<'valid' | 'invalid' | 'unreachable'> {
    if (!this.apiKey) return 'invalid';
    try {
      const res = await this.authedGet('/v1/friends');
      return res.ok ? 'valid' : 'invalid';
    } catch {
      return 'unreachable';
    }
  }

  clearRegistration(): void {
    this.apiKey = '';
    const cfg = this.config();
    cfg.relay!.apiKey = '';
    cfg.relay!.username = '';
    saveConfig(cfg);
  }

  async deregister(): Promise<void> {
    if (this.ws) {
      this.disconnect();
    }
    if (this.apiKey) {
      try {
        await this.authedDelete('/v1/deregister');
      } catch {}
    }
    this.clearRegistration();
  }

  sendWsMessage(data: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send('ping');
      }
    }, 30000);
  }

  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private handleMessage(msg: Record<string, unknown>): void {
    if (msg.type === 'AUTH_OK') {
      this.emit('auth_ok', msg);
      return;
    }
    if (msg.type === 'INITIAL_STATE') {
      this.emit('initial_state', msg);
      return;
    }

    const eventMap: Record<string, string> = {
      'FRIEND_REQUEST': 'friend_request',
      'FRIEND_ACCEPT': 'friend_accept',
      'FRIEND_REJECT': 'friend_reject',
      'FRIEND_CANCEL': 'friend_cancel',
      'FRIEND_REMOVE': 'friend_remove',
      'MESSAGE': 'message',
      'MEMORY_QUERY': 'memory_query',
      'MEMORY_RESPONSE': 'memory_response',
      'ACCESS_REQUEST': 'access_request',
    };

    const eventType = eventMap[msg.type as string];
    if (eventType) {
      this.emit(eventType, msg);
    }
  }

  private scheduleReconnect(): void {
    if (this.intentionalDisconnect) return;
    if (!this.apiKey) return;

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.connect().catch(() => {});
    }, delay);
  }

  private emit(event: string, data: unknown): void {
    const handlers = this.handlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try { handler(data); } catch (err) { console.error(`[Relay] Event handler error for '${event}':`, err); }
      }
    }
  }

  private async httpPost(path: string, body: Record<string, unknown>): Promise<Response> {
    return ipv4Fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  private async authedPost(path: string, body: Record<string, unknown>): Promise<Response> {
    return ipv4Fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': this.apiKey,
      },
      body: JSON.stringify(body),
    });
  }

  private async authedGet(path: string): Promise<Response> {
    return ipv4Fetch(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: { 'X-API-Key': this.apiKey },
    });
  }

  private async authedDelete(path: string): Promise<Response> {
    return ipv4Fetch(`${this.baseUrl}${path}`, {
      method: 'DELETE',
      headers: { 'X-API-Key': this.apiKey },
    });
  }
}