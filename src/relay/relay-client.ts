import WebSocket from 'ws';
import { getOrCreateKeyPair, encryptForRecipient, decryptFromSender, isE2EAvailable, type KeyPair } from './crypto.js';
import { logger } from '../utils/logger.js';

const DEFAULT_RELAY_URL = 'https://relay.mercuryagent.com';
const POLL_INTERVAL_MS = 15_000;
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

export interface RelayPollResult {
  friendRequests: Array<{ fromTgId: string; fromUsername: string | null; fromFirstName: string | null; requestId: string }>;
  friendResponses: Array<{ fromTgId: string; approved: boolean; requestId: string }>;
  messages: RelayMessage[];
}

type OnResultCallback = (result: RelayPollResult) => void;

export class RelayClient {
  private url: string;
  private apiKey: string | null = null;
  private tgUserId: string | null = null;
  private keyPair: KeyPair;
  private pollTimer: NodeJS.Timeout | null = null;
  private registered = false;
  private e2eAvailable: boolean;

  private ws: WebSocket | null = null;
  private wsReconnectAttempts = 0;
  private wsReconnectTimer: NodeJS.Timeout | null = null;
  private wsPingTimer: NodeJS.Timeout | null = null;
  private onResultCallback: OnResultCallback | null = null;
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
        logger.warn({ status: response.status }, 'Relay registration failed');
        return false;
      }

      const data = await response.json() as { api_key: string };
      this.apiKey = data.api_key;
      this.registered = true;
      logger.info({ tgUserId }, 'Registered with relay server');
      return true;
    } catch (err) {
      logger.warn({ err }, 'Relay registration error');
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

  async poll(): Promise<RelayPollResult> {
    if (!this.ensureRegistered()) {
      return { friendRequests: [], friendResponses: [], messages: [] };
    }

    try {
      const response = await fetch(`${this.url}/v1/poll?user_id=${this.tgUserId}`, {
        headers: this.authHeaders(),
      });

      if (!response.ok) {
        return { friendRequests: [], friendResponses: [], messages: [] };
      }

      const data = await response.json() as {
        friend_requests?: Array<{ from_tg_id: string; from_username?: string; from_first_name?: string; request_id: string }>;
        friend_responses?: Array<{ from_tg_id: string; approved: boolean; request_id: string }>;
        messages?: RelayMessage[];
      };

      return {
        friendRequests: (data.friend_requests || []).map(r => ({
          fromTgId: r.from_tg_id,
          fromUsername: r.from_username ?? null,
          fromFirstName: r.from_first_name ?? null,
          requestId: r.request_id,
        })),
        friendResponses: (data.friend_responses || []).map(r => ({
          fromTgId: r.from_tg_id,
          approved: r.approved,
          requestId: r.request_id,
        })),
        messages: data.messages || [],
      };
    } catch (err) {
      logger.debug({ err }, 'Relay poll error');
      return { friendRequests: [], friendResponses: [], messages: [] };
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

  async acknowledgeMessage(messageId: string): Promise<void> {
    if (!this.ensureRegistered()) return;

    try {
      await fetch(`${this.url}/v1/message/${messageId}`, {
        method: 'DELETE',
        headers: this.authHeaders(),
      });
    } catch {
      // Silent — best effort
    }
  }

  decryptMessage(encryptedPayload: string): string | null {
    if (!this.e2eAvailable) {
      logger.warn('E2E encryption not available — cannot decrypt message');
      return null;
    }
    return decryptFromSender(encryptedPayload, this.keyPair);
  }

  startPollLoop(onPollResult: (result: RelayPollResult) => void): void {
    this.onResultCallback = onPollResult;

    this.connectWebSocket();

    if (!this.wsConnected) {
      this.startHttpPoll();
    }
  }

  stopPollLoop(): void {
    this.disconnectWebSocket();
    this.stopHttpPoll();
    logger.info('Relay connection stopped');
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
        this.stopHttpPoll();
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
        this.startHttpPoll();
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
      this.startHttpPoll();
    }
  }

  private handleWsMessage(msg: Record<string, unknown>): void {
    if (!this.onResultCallback) return;

    const type = msg.type as string;

    if (type === 'auth_ok') {
      logger.info({ tgUserId: msg.tg_user_id }, 'WebSocket authenticated with relay');
      return;
    }

    if (type === 'initial_state') {
      const result = this.parseWsInitialState(msg);
      if (result && (result.friendRequests.length > 0 || result.friendResponses.length > 0 || result.messages.length > 0)) {
        this.onResultCallback(result);
      }
      return;
    }

    if (type === 'friend_request') {
      const result: RelayPollResult = {
        friendRequests: [{
          fromTgId: msg.from_tg_id as string,
          fromUsername: (msg.from_username as string) ?? null,
          fromFirstName: (msg.from_first_name as string) ?? null,
          requestId: msg.request_id as string,
        }],
        friendResponses: [],
        messages: [],
      };
      this.onResultCallback(result);
      return;
    }

    if (type === 'friend_response') {
      const result: RelayPollResult = {
        friendRequests: [],
        friendResponses: [{
          fromTgId: msg.from_tg_id as string,
          approved: msg.approved as boolean,
          requestId: msg.request_id as string,
        }],
        messages: [],
      };
      this.onResultCallback(result);
      return;
    }

    if (type === 'friend_revoked') {
      const result: RelayPollResult = {
        friendRequests: [],
        friendResponses: [{
          fromTgId: msg.from_tg_id as string,
          approved: false,
          requestId: '',
        }],
        messages: [],
      };
      this.onResultCallback(result);
      return;
    }

    if (type === 'message') {
      const result: RelayPollResult = {
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
      };
      this.onResultCallback(result);

      if (msg.id) {
        this.ws?.send(JSON.stringify({ type: 'ack_message', message_id: msg.id }));
      }
      return;
    }
  }

  private parseWsInitialState(msg: Record<string, unknown>): RelayPollResult | null {
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

  private startHttpPoll(): void {
    if (this.pollTimer) return;

    const poll = async () => {
      if (!this.registered || this.wsConnected) return;
      const result = await this.poll();
      if (result.friendRequests.length > 0 || result.friendResponses.length > 0 || result.messages.length > 0) {
        this.onResultCallback?.(result);
      }
    };

    this.pollTimer = setInterval(poll, POLL_INTERVAL_MS);
    poll();
    logger.info('HTTP poll fallback started (relay WebSocket unavailable)');
  }

  private stopHttpPoll(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  isRegistered(): boolean {
    return this.registered;
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