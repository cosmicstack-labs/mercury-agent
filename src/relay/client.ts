import type { MercuryConfig } from '../utils/config.js';
import { saveConfig } from '../utils/config.js';

type EventHandler = (data: unknown) => void;

export interface FriendsResponse {
  friends: Array<{
    request_id: string;
    status: string;
    created_at: number;
    approved_at: number | null;
    target_user: { tg_user_id: string; username: string | null; first_name: string | null };
  }>;
  pending_sent: Array<{
    request_id: string;
    status: string;
    created_at: number;
    approved_at: number | null;
    target_user: { tg_user_id: string; username: string | null; first_name: string | null };
  }>;
  pending_received: Array<{
    request_id: string;
    status: string;
    created_at: number;
    approved_at: number | null;
    target_user: { tg_user_id: string; username: string | null; first_name: string | null };
  }>;
}

export interface TargetUser {
  tg_user_id: string;
  username: string | null;
  first_name: string | null;
}

export interface FriendRequestResult {
  request_id: string;
  status: string;
  target_online: boolean;
  target_user: TargetUser;
}

export class RelayClient {
  private ws: WebSocket | null = null;
  private url: string;
  private apiKey: string;
  private baseUrl: string;
  private config: () => MercuryConfig;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private handlers: Map<string, Set<EventHandler>> = new Map();
  private intentionalDisconnect = false;

  constructor(config: () => MercuryConfig) {
    this.config = config;
    const cfg = config();
    this.url = cfg.relay.url;
    this.apiKey = cfg.relay.apiKey;
    this.baseUrl = this.url.replace(/\/v1\/ws$/, '').replace(/^wss?/, 'https');
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  isRegistered(): boolean {
    return this.apiKey.length > 0;
  }

  async register(tgUserId: string, username?: string, firstName?: string): Promise<{ apiKey: string; user: TargetUser }> {
    const res = await this.httpPost('/v1/register', {
      tg_user_id: tgUserId,
      username: username || undefined,
      first_name: firstName || undefined,
    });
    if (!res.ok) {
      const err = await res.json() as { error: string };
      throw new Error(err.error || 'Registration failed');
    }
    const data = await res.json() as { api_key: string; user: TargetUser };
    this.apiKey = data.api_key;

    const cfg = this.config();
    cfg.relay.apiKey = data.api_key;
    saveConfig(cfg);

    return { apiKey: data.api_key, user: data.user };
  }

  connect(): boolean {
    if (!this.apiKey) return false;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return true;

    this.intentionalDisconnect = false;
    this.reconnectAttempts = 0;

    try {
      const fullUrl = `${this.url}?api_key=${this.apiKey}`;
      this.ws = new WebSocket(fullUrl);

      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        this.emit('connected', null);
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string);
          this.handleMessage(msg);
        } catch {}
      };

      this.ws.onclose = () => {
        this.emit('disconnected', null);
        if (!this.intentionalDisconnect) {
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = () => {};

      return true;
    } catch {
      return false;
    }
  }

  disconnect(): void {
    this.intentionalDisconnect = true;
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

  async sendFriendRequest(input: string): Promise<FriendRequestResult> {
    const body: Record<string, string> = {};
    if (input.startsWith('@')) {
      body.username = input.slice(1);
    } else {
      body.to_tg_id = input;
    }

    const res = await this.authedPost('/v1/friend-request', body);
    if (!res.ok) {
      const err = await res.json() as { error: string; target_user?: TargetUser };
      throw Object.assign(new Error(err.error), { target_user: err.target_user });
    }
    return await res.json() as FriendRequestResult;
  }

  async approveRequest(fromTgId: string): Promise<{ status: string; target_user: TargetUser }> {
    const res = await this.authedPost('/v1/approve-request', { from_tg_id: fromTgId });
    if (!res.ok) {
      const err = await res.json() as { error: string };
      throw new Error(err.error);
    }
    return await res.json() as { status: string; target_user: TargetUser };
  }

  async rejectRequest(fromTgId: string): Promise<{ status: string; target_user: TargetUser }> {
    const res = await this.authedPost('/v1/reject-request', { from_tg_id: fromTgId });
    if (!res.ok) {
      const err = await res.json() as { error: string };
      throw new Error(err.error);
    }
    return await res.json() as { status: string; target_user: TargetUser };
  }

  async cancelRequest(toTgId: string): Promise<{ status: string; target_user: TargetUser }> {
    const res = await this.authedPost('/v1/cancel-request', { to_tg_id: toTgId });
    if (!res.ok) {
      const err = await res.json() as { error: string };
      throw new Error(err.error);
    }
    return await res.json() as { status: string; target_user: TargetUser };
  }

  async deleteFriend(friendTgId: string): Promise<{ status: string; target_user: TargetUser }> {
    const res = await this.authedPost('/v1/delete-friend', { friend_tg_id: friendTgId });
    if (!res.ok) {
      const err = await res.json() as { error: string };
      throw new Error(err.error);
    }
    return await res.json() as { status: string; target_user: TargetUser };
  }

  async getFriends(): Promise<FriendsResponse> {
    const res = await this.authedGet('/v1/friends');
    if (!res.ok) {
      throw new Error('Failed to get friends');
    }
    return await res.json() as FriendsResponse;
  }

  async getUserStatus(tgId: string): Promise<{ tg_user_id: string; online: boolean }> {
    const res = await this.authedGet(`/v1/status/${tgId}`);
    if (!res.ok) {
      throw new Error('Failed to get user status');
    }
    return await res.json() as { tg_user_id: string; online: boolean };
  }

  sendWsMessage(data: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
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
      this.connect();
    }, delay);
  }

  private emit(event: string, data: unknown): void {
    const handlers = this.handlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try { handler(data); } catch {}
      }
    }
  }

  private async httpPost(path: string, body: Record<string, unknown>): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  private async authedPost(path: string, body: Record<string, unknown>): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': this.apiKey,
      },
      body: JSON.stringify(body),
    });
  }

  private async authedGet(path: string): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: { 'X-API-Key': this.apiKey },
    });
  }
}