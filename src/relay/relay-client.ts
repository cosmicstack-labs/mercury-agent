import { getOrCreateKeyPair, encryptForRecipient, decryptFromSender, isE2EAvailable, type KeyPair } from './crypto.js';
import { logger } from '../utils/logger.js';

const DEFAULT_RELAY_URL = 'https://relay.mercuryagent.com';
const POLL_INTERVAL_MS = 15_000;

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

export class RelayClient {
  private url: string;
  private apiKey: string | null = null;
  private tgUserId: string | null = null;
  private keyPair: KeyPair;
  private pollTimer: NodeJS.Timeout | null = null;
  private registered = false;
  private e2eAvailable: boolean;

  constructor(config?: RelayConfig) {
    this.url = config?.url || DEFAULT_RELAY_URL;
    this.keyPair = getOrCreateKeyPair() ?? { publicKey: new Uint8Array(0), privateKey: new Uint8Array(0), publicKeyBase64: '' };
    this.e2eAvailable = isE2EAvailable();
  }

  async register(tgUserId: string, username?: string): Promise<boolean> {
    this.tgUserId = tgUserId;

    try {
      const response = await fetch(`${this.url}/v1/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tg_user_id: tgUserId,
          username: username ?? null,
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

  async approveFriendRequest(requestId: string, negativeTags: string[], negativeRules?: string): Promise<boolean> {
    if (!this.ensureRegistered()) return false;

    try {
      const response = await fetch(`${this.url}/v1/approve-request`, {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify({
          request_id: requestId,
          from_tg_id: this.tgUserId,
          negative_tags: negativeTags,
          negative_rules: negativeRules ?? null,
        }),
      });

      if (!response.ok) {
        logger.warn({ status: response.status, requestId }, 'Friend approval failed');
        return false;
      }

      logger.info({ requestId }, 'Friend request approved via relay');
      return true;
    } catch (err) {
      logger.warn({ err, requestId }, 'Friend approval error');
      return false;
    }
  }

  async rejectFriendRequest(requestId: string): Promise<boolean> {
    if (!this.ensureRegistered()) return false;

    try {
      const response = await fetch(`${this.url}/v1/reject-request`, {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify({
          request_id: requestId,
          from_tg_id: this.tgUserId,
        }),
      });

      return response.ok;
    } catch (err) {
      logger.warn({ err, requestId }, 'Friend rejection error');
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
    if (this.pollTimer) return;

    const poll = async () => {
      if (!this.registered) return;
      const result = await this.poll();
      if (result.friendRequests.length > 0 || result.friendResponses.length > 0 || result.messages.length > 0) {
        onPollResult(result);
      }
    };

    this.pollTimer = setInterval(poll, POLL_INTERVAL_MS);
    poll();
    logger.info('Relay poll loop started');
  }

  stopPollLoop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
      logger.info('Relay poll loop stopped');
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