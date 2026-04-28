import WebSocket from 'ws';
import { getOrCreateKeyPair, encryptForRecipient, decryptFromSender, isE2EAvailable, type KeyPair } from './crypto.js';
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
  id: string;
  fromTgId: string;
  toTgId: string;
  type: 'friend-request' | 'friend-response' | 'shared-memory-query' | 'shared-memory-response' | 'notification';
  encryptedPayload?: string;
  plainPayload?: Record<string, unknown>;
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
  private keyPair: KeyPair;
  private registered = false;
  private e2eAvailable: boolean;

  private ws: WebSocket | null = null;
  private wsReconnectAttempts = 0;
  private wsReconnectTimer: NodeJS.Timeout | null = null;
  private wsPingTimer: NodeJS.Timeout | null = null;
  private onEventCallback: OnEventCallback | null = null;
  private wsConnected = false;

  constructor(config?: RelayConfig) {
    this.url = config?.url || DEFAULT_RELAY_URL;
    this.keyPair = getOrCreateKeyPair() ?? { publicKey: new Uint8Array(0), privateKey: new Uint8Array(0), publicKeyBase64: '' };
    this.e2eAvailable = isE2EAvailable();
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
          public_key: this.keyPair.publicKeyBase64,
          endpoint: null,
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

  async sendSharedMemoryQuery(friendTgId: string, query: string, friendPublicKeyBase64: string): Promise<boolean> {
    if (!this.ensureRegistered()) return false;
    if (!this.e2eAvailable) {
      logger.warn('E2E encryption not available — cannot send shared memory query');
      return false;
    }

    try {
      const encryptedQuery = encryptForRecipient(query, friendPublicKeyBase64);
      if (!encryptedQuery) return false;

      const response = await fetch(`${this.url}/v1/message`, {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify({
          from_tg_id: this.tgUserId,
          to_tg_id: friendTgId,
          type: 'shared-memory-query',
          encrypted_payload: encryptedQuery,
        }),
      });

      if (!response.ok) {
        logger.warn({ status: response.status, friendTgId }, 'Shared memory query failed');
        return false;
      }

      logger.info({ friendTgId }, 'Shared memory query sent via relay');
      return true;
    } catch (err) {
      logger.warn({ err, friendTgId }, 'Shared memory query error');
      return false;
    }
  }

  async sendSharedMemoryResponse(friendTgId: string, responseText: string, friendPublicKeyBase64: string): Promise<boolean> {
    if (!this.ensureRegistered()) return false;
    if (!this.e2eAvailable) {
      logger.warn('E2E encryption not available — cannot send shared memory response');
      return false;
    }

    try {
      const encryptedResponse = encryptForRecipient(responseText, friendPublicKeyBase64);
      if (!encryptedResponse) return false;

      const resp = await fetch(`${this.url}/v1/message`, {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify({
          from_tg_id: this.tgUserId,
          to_tg_id: friendTgId,
          type: 'shared-memory-response',
          encrypted_payload: encryptedResponse,
        }),
      });

      return resp.ok;
    } catch (err) {
      logger.warn({ err, friendTgId }, 'Shared memory response error');
      return false;
    }
  }

  async getUserPublicKey(tgUserId: string): Promise<string | null> {
    if (!this.ensureRegistered()) return null;

    try {
      const response = await fetch(`${this.url}/v1/user/${tgUserId}`, {
        headers: this.authHeaders(),
      });

      if (!response.ok) return null;

      const data = await response.json() as { public_key: string };
      return data.public_key;
    } catch {
      return null;
    }
  }

  decryptMessage(encryptedPayload: string): string | null {
    if (!this.e2eAvailable) {
      logger.warn('E2E encryption not available — cannot decrypt message');
      return null;
    }
    return decryptFromSender(encryptedPayload, this.keyPair);
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
          id: msg.id as string,
          fromTgId: msg.from_tg_id as string,
          toTgId: msg.to_tg_id as string,
          type: msg.message_type as RelayMessage['type'],
          encryptedPayload: msg.encrypted_payload as string,
          createdAt: msg.created_at as number,
        }],
      });

      if (msg.id) {
        this.ws?.send(JSON.stringify({ type: 'ack_message', message_id: msg.id }));
      }
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
        id: m.id as string,
        fromTgId: m.from_tg_id as string,
        toTgId: m.to_tg_id as string,
        type: m.type as RelayMessage['type'],
        encryptedPayload: m.encrypted_payload as string,
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

  getPublicKeyBase64(): string {
    return this.keyPair.publicKeyBase64;
  }

  isE2EAvailable(): boolean {
    return this.e2eAvailable;
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