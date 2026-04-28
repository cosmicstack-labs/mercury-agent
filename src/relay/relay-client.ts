import WebSocket from 'ws';
import { logger } from '../utils/logger.js';

const DEFAULT_RELAY_URL = 'https://mercury-relay.admin-5cc.workers.dev';
const WS_RECONNECT_BASE_MS = 1_000;
const WS_RECONNECT_MAX_MS = 30_000;
const WS_PING_INTERVAL_MS = 30_000;

export interface RelayConfig {
  url: string;
  enabled: boolean;
}

export interface RelayMessage {
  fromTgId: string;
  toTgId: string;
  type: 'shared-memory-query' | 'shared-memory-response';
  payload: string;
  createdAt: number;
}

export interface RelayEvent {
  friendRequests: Array<{ fromTgId: string; fromUsername: string | null; fromFirstName: string | null; requestId: string }>;
  friendResponses: Array<{ fromTgId: string; approved: boolean; requestId: string }>;
  messages: RelayMessage[];
  friendDeleted?: string;
}

type OnEventCallback = (event: RelayEvent) => void;

export class RelayClient {
  private url: string;
  private apiKey: string | null = null;
  private tgUserId: string | null = null;
  private registered = false;

  private ws: WebSocket | null = null;
  private wsReconnectAttempts = 0;
  private wsReconnectTimer: NodeJS.Timeout | null = null;
  private wsPingTimer: NodeJS.Timeout | null = null;
  private onEventCallback: OnEventCallback | null = null;
  private wsConnected = false;

  constructor(config?: RelayConfig) {
    this.url = config?.url || DEFAULT_RELAY_URL;
  }

  private get wsUrl(): string {
    return this.url.replace(/^https?/, 'ws');
  }

  async register(tgUserId: string, username?: string, firstName?: string): Promise<boolean> {
    this.tgUserId = tgUserId;

    try {
      const response = await fetch(`${this.url}/v1/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tg_user_id: tgUserId,
          username: username ?? null,
          first_name: firstName ?? null,
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        console.error(`[RelayClient] Registration failed: status=${response.status} body=${body}`);
        return false;
      }

      const data = await response.json() as { api_key: string };
      this.apiKey = data.api_key;
      this.registered = true;
      logger.info({ tgUserId }, 'Registered with relay server');
      return true;
    } catch (err) {
      console.error(`[RelayClient] Registration error:`, err);
      return false;
    }
  }

  async sendFriendRequest(toTgId: string): Promise<boolean> {
    if (!this.ensureRegistered()) return false;

    try {
      const response = await fetch(`${this.url}/v1/friend-request`, {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify({
          from_tg_id: this.tgUserId,
          to_tg_id: toTgId,
        }),
      });

      if (!response.ok) {
        logger.warn({ status: response.status, toTgId }, 'Friend request failed');
        return false;
      }

      logger.info({ toTgId }, 'Friend request sent via relay');
      return true;
    } catch (err) {
      logger.warn({ err, toTgId }, 'Friend request error');
      return false;
    }
  }

  async approveFriendRequest(friendTgId: string, negativeTags: string[], negativeRules?: string): Promise<boolean> {
    if (!this.ensureRegistered()) return false;

    try {
      const response = await fetch(`${this.url}/v1/approve-request`, {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify({
          from_tg_id: friendTgId,
          to_tg_id: this.tgUserId,
          negative_tags: negativeTags,
          negative_rules: negativeRules ?? null,
        }),
      });

      if (!response.ok) {
        logger.warn({ status: response.status, friendTgId }, 'Friend approval failed');
        return false;
      }

      logger.info({ friendTgId }, 'Friend request approved via relay');
      return true;
    } catch (err) {
      logger.warn({ err, friendTgId }, 'Friend approval error');
      return false;
    }
  }

  async rejectFriendRequest(friendTgId: string): Promise<boolean> {
    if (!this.ensureRegistered()) return false;

    try {
      const response = await fetch(`${this.url}/v1/reject-request`, {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify({
          from_tg_id: friendTgId,
          to_tg_id: this.tgUserId,
        }),
      });

      return response.ok;
    } catch (err) {
      logger.warn({ err, friendTgId }, 'Friend rejection error');
      return false;
    }
  }

  async revokeFriend(friendTgId: string): Promise<boolean> {
    if (!this.ensureRegistered()) return false;

    try {
      const response = await fetch(`${this.url}/v1/revoke-friend`, {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify({
          from_tg_id: this.tgUserId,
          friend_tg_id: friendTgId,
        }),
      });

      return response.ok;
    } catch (err) {
      logger.warn({ err, friendTgId }, 'Friend revocation error');
      return false;
    }
  }

  async deleteFriend(friendTgId: string): Promise<boolean> {
    if (!this.ensureRegistered()) return false;

    try {
      const response = await fetch(`${this.url}/v1/delete-friend`, {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify({
          from_tg_id: this.tgUserId,
          friend_tg_id: friendTgId,
        }),
      });

      return response.ok;
    } catch (err) {
      logger.warn({ err, friendTgId }, 'Friend deletion error');
      return false;
    }
  }

  sendViaWs(toTgId: string, messageType: string, payload: string): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.warn({ toTgId, messageType }, 'Cannot send via WS — not connected');
      return false;
    }

    const msg = JSON.stringify({
      type: 'send_message',
      to_tg_id: toTgId,
      message_type: messageType,
      payload,
    });

    try {
      this.ws.send(msg);
      logger.info({ toTgId, messageType }, 'Message sent via WebSocket');
      return true;
    } catch (err) {
      logger.warn({ err, toTgId, messageType }, 'Failed to send message via WebSocket');
      return false;
    }
  }

  connect(onEvent: (event: RelayEvent) => void): void {
    this.onEventCallback = onEvent;
    this.connectWebSocket();
  }

  disconnect(): void {
    this.disconnectWebSocket();
    logger.info('Relay connection stopped');
  }

  resetForReconnect(): void {
    this.disconnectWebSocket();
    this.apiKey = null;
    this.registered = false;
    this.tgUserId = null;
    this.wsReconnectAttempts = 0;
  }

  private connectWebSocket(): void {
    if (this.ws || !this.registered || !this.apiKey || !this.tgUserId) return;

    try {
      const url = `${this.wsUrl}/v1/ws?api_key=${encodeURIComponent(this.apiKey)}`;
      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        logger.info({ tgUserId: this.tgUserId }, 'WebSocket connected to relay');
        this.wsConnected = true;
        this.wsReconnectAttempts = 0;
        this.startWsPing();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleWsMessage(msg);
        } catch (err) {
          logger.debug({ err }, 'WebSocket message parse error');
        }
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        logger.info({ code, reason: reason.toString() }, 'WebSocket disconnected from relay');
        this.wsConnected = false;
        this.ws = null;
        this.stopWsPing();
        this.scheduleReconnect();
      });

      this.ws.on('error', (err: Error) => {
        logger.debug({ err }, 'WebSocket error');
        this.wsConnected = false;
      });

      this.ws.on('ping', () => {
        this.ws?.pong();
      });
    } catch (err) {
      logger.warn({ err }, 'Failed to connect WebSocket to relay');
      this.scheduleReconnect();
    }
  }

  private handleWsMessage(msg: Record<string, unknown>): void {
    if (!this.onEventCallback) return;

    const type = msg.type as string;

    if (type === 'auth_ok') {
      logger.info({ tgUserId: msg.tg_user_id }, 'WebSocket authenticated with relay');
      return;
    }

    if (type === 'initial_state') {
      const result = this.parseWsInitialState(msg);
      if (result && (result.friendRequests.length > 0 || result.friendResponses.length > 0 || result.messages.length > 0)) {
        this.onEventCallback(result);
      }
      return;
    }

    if (type === 'friend_request') {
      this.onEventCallback({
        friendRequests: [{
          fromTgId: msg.from_tg_id as string,
          fromUsername: (msg.from_username as string) ?? null,
          fromFirstName: (msg.from_first_name as string) ?? null,
          requestId: msg.request_id as string,
        }],
        friendResponses: [],
        messages: [],
      });
      return;
    }

    if (type === 'friend_response') {
      this.onEventCallback({
        friendRequests: [],
        friendResponses: [{
          fromTgId: msg.from_tg_id as string,
          approved: msg.approved as boolean,
          requestId: msg.request_id as string,
        }],
        messages: [],
      });
      return;
    }

    if (type === 'friend_revoked') {
      this.onEventCallback({
        friendRequests: [],
        friendResponses: [{
          fromTgId: msg.from_tg_id as string,
          approved: false,
          requestId: '',
        }],
        messages: [],
      });
      return;
    }

    if (type === 'friend_deleted') {
      this.onEventCallback({
        friendRequests: [],
        friendResponses: [],
        messages: [],
        friendDeleted: msg.from_tg_id as string,
      });
      return;
    }

    if (type === 'message') {
      this.onEventCallback({
        friendRequests: [],
        friendResponses: [],
        messages: [{
          fromTgId: msg.from_tg_id as string,
          toTgId: msg.to_tg_id as string,
          type: msg.message_type as RelayMessage['type'],
          payload: msg.payload as string,
          createdAt: msg.created_at as number,
        }],
      });
      return;
    }
  }

  private parseWsInitialState(msg: Record<string, unknown>): RelayEvent | null {
    try {
      const friendRequests = ((msg.friend_requests as Array<Record<string, unknown>>) ?? []).map(r => ({
        fromTgId: r.from_tg_id as string,
        fromUsername: (r.from_username as string) ?? null,
        fromFirstName: (r.from_first_name as string) ?? null,
        requestId: r.request_id as string,
      }));

      const friendResponses = ((msg.friend_responses as Array<Record<string, unknown>>) ?? []).map(r => ({
        fromTgId: r.from_tg_id as string,
        approved: r.approved as boolean,
        requestId: r.request_id as string,
      }));

      const messages = ((msg.messages as Array<Record<string, unknown>>) ?? []).map(m => ({
        fromTgId: m.from_tg_id as string,
        toTgId: m.to_tg_id as string,
        type: m.message_type as RelayMessage['type'],
        payload: m.payload as string,
        createdAt: m.created_at as number,
      }));

      return { friendRequests, friendResponses, messages };
    } catch {
      return null;
    }
  }

  private startWsPing(): void {
    this.stopWsPing();
    this.wsPingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, WS_PING_INTERVAL_MS);
  }

  private stopWsPing(): void {
    if (this.wsPingTimer) {
      clearInterval(this.wsPingTimer);
      this.wsPingTimer = null;
    }
  }

  private disconnectWebSocket(): void {
    this.stopWsPing();
    this.stopReconnect();
    if (this.ws) {
      this.ws.close(1000, 'Client disconnecting');
      this.ws = null;
    }
    this.wsConnected = false;
  }

  private scheduleReconnect(): void {
    if (this.wsReconnectTimer) return;

    const delay = Math.min(
      WS_RECONNECT_BASE_MS * Math.pow(2, this.wsReconnectAttempts),
      WS_RECONNECT_MAX_MS,
    );
    this.wsReconnectAttempts++;

    logger.info({ delay, attempt: this.wsReconnectAttempts }, 'Scheduling WebSocket reconnect');

    this.wsReconnectTimer = setTimeout(() => {
      this.wsReconnectTimer = null;
      this.connectWebSocket();
    }, delay);
  }

  private stopReconnect(): void {
    if (this.wsReconnectTimer) {
      clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = null;
    }
    this.wsReconnectAttempts = 0;
  }

  isRegistered(): boolean {
    return this.registered;
  }

  isConnected(): boolean {
    return this.wsConnected;
  }

  getUrl(): string {
    return this.url;
  }

  getTgUserId(): string | null {
    return this.tgUserId;
  }

  private ensureRegistered(): boolean {
    if (!this.registered || !this.apiKey || !this.tgUserId) {
      logger.warn('Relay client not registered — skipping request');
      return false;
    }
    return true;
  }

  private authHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'X-API-Key': this.apiKey ?? '',
    };
  }
}