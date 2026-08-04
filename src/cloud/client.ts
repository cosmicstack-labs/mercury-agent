import type { WSMessage, WSMessageType } from './types.js';
import type { CloudTokenStore } from './token-store.js';
import { WebSocket } from 'ws';
import { logger } from '../utils/logger.js';

export type WSMessageHandler = (message: WSMessage) => void | Promise<void>;

const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_BUFFERED_AMOUNT = 1024 * 1024;

export class MercuryCloudClient {
  private ws: WebSocket | null = null;
  private url: string;
  private tokenStore: CloudTokenStore;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private tokenCheckInterval: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 50;
  private handlers = new Map<string, WSMessageHandler[]>();
  private isConnecting = false;
  private shouldReconnect = true;
  private isRefreshing = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRefreshFailureLogAt = 0;
  private connectedHandlers = new Set<() => void | Promise<void>>();
  private awaitingPong = false;
  private lifecycleGeneration = 0;
  private authRefreshNeeded = false;
  private connectPromise: Promise<void> | null = null;
  private tokenPreparation: Promise<string> | null = null;

  constructor(url: string, tokenStore: CloudTokenStore) {
    this.url = url;
    this.tokenStore = tokenStore;
  }

  async connect(): Promise<void> {
    if (this.isConnected()) return;
    if (this.connectPromise) return this.connectPromise;
    this.shouldReconnect = true;
    this.isConnecting = true;
    const generation = this.lifecycleGeneration;

    // Never attempt an authenticated handshake with a token that is already
    // expired. Refresh first so every new/reconnected socket is validated by
    // the server using current credentials.
    try {
      const preparation = this.tokenPreparation ?? this.tokenStore.rotateIfExpired(2 * 60_000);
      this.tokenPreparation = preparation;
      await preparation;
      if (this.tokenPreparation === preparation) this.tokenPreparation = null;
    } catch (error) {
      this.tokenPreparation = null;
      this.isConnecting = false;
      if (this.shouldReconnect) this.scheduleReconnect();
      throw error;
    }
    if (!this.shouldReconnect || generation !== this.lifecycleGeneration) {
      this.isConnecting = false;
      return;
    }
    if (this.isConnected()) {
      this.isConnecting = false;
      return;
    }
    if (this.connectPromise) return this.connectPromise;

    // Pass the access token via an Authorization header rather than a URL
    // query parameter so it never appears in server/proxy access logs.
    const wsUrl = `${this.url}?agentId=${this.tokenStore.getAgentId()}`;

    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${this.tokenStore.getJwt()}` };
      const socket = new WebSocket(wsUrl, {
        handshakeTimeout: 15_000,
        headers,
      });
      this.ws = socket;
      this.connectPromise = new Promise<void>((resolve, reject) => {
        let opened = false;

        socket.on('open', () => {
          if (this.ws !== socket) return;
          opened = true;
          this.isConnecting = false;
          this.reconnectAttempts = 0;
          this.authRefreshNeeded = false;
          this.awaitingPong = false;
          this.startHeartbeat();
          this.startTokenCheck();
          resolve();
          for (const handler of this.connectedHandlers) {
            this.runHandler('connected', handler);
          }
        });

        socket.on('message', (data) => {
          this.awaitingPong = false;
          try {
            const message = JSON.parse(data.toString()) as WSMessage;
            for (const handler of this.handlers.get(message.type) || []) {
              this.runHandler(message.type, () => handler(message));
            }
          } catch (error) {
            logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'Invalid Mercury Cloud WebSocket message');
          }
        });

        socket.on('pong', () => {
          this.awaitingPong = false;
        });

        socket.on('close', (code) => {
          if (!opened) reject(new Error(`Mercury Cloud WebSocket closed before opening (${code})`));
          if (this.ws !== socket) return;
          this.isConnecting = false;
          this.stopHeartbeat();
          this.stopTokenCheck();
          this.ws = null;
          this.connectPromise = null;

          if (!this.shouldReconnect) return;
          this.authRefreshNeeded = code === 1008;
          this.scheduleReconnect();
        });

        socket.on('error', (error) => {
          logger.warn({ err: error.message }, 'Mercury Cloud WebSocket error');
        });
      }).finally(() => {
        if (this.ws !== socket || socket.readyState === WebSocket.OPEN) this.connectPromise = null;
      });
      return await this.connectPromise;
    } catch (error) {
      this.isConnecting = false;
      this.connectPromise = null;
      if (this.shouldReconnect) this.scheduleReconnect();
      throw error;
    }
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.lifecycleGeneration++;
    this.authRefreshNeeded = false;
    this.isConnecting = false;
    this.connectPromise = null;
    this.stopHeartbeat();
    this.stopTokenCheck();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  on(type: WSMessageType, handler: WSMessageHandler): void {
    const key = type as string;
    if (!this.handlers.has(key)) {
      this.handlers.set(key, []);
    }
    this.handlers.get(key)!.push(handler);
  }

  off(type: WSMessageType, handler: WSMessageHandler): void {
    const key = type as string;
    const handlers = this.handlers.get(key);
    if (handlers) {
      const idx = handlers.indexOf(handler);
      if (idx >= 0) handlers.splice(idx, 1);
    }
  }

  onConnected(handler: () => void | Promise<void>): () => void {
    this.connectedHandlers.add(handler);
    return () => this.connectedHandlers.delete(handler);
  }

  send(message: WSMessage): boolean {
    const socket = this.ws;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    if (socket.bufferedAmount > MAX_BUFFERED_AMOUNT) {
      logger.warn({ bufferedAmount: socket.bufferedAmount, type: message.type }, 'Mercury Cloud WebSocket send skipped due to backpressure');
      return false;
    }
    try {
      socket.send(JSON.stringify(message), (error) => {
        if (error) logger.warn({ err: error.message, type: message.type }, 'Mercury Cloud WebSocket send failed');
      });
      return true;
    } catch (error) {
      logger.warn({ err: error instanceof Error ? error.message : String(error), type: message.type }, 'Mercury Cloud WebSocket send failed');
      return false;
    }
  }

  sendResponse(payload: { message: string; conversationId?: string; sessionId?: string; requestId?: string; inReplyTo?: string }): void {
    this.send({
      type: 'agent.response',
      agentId: this.tokenStore.getAgentId(),
      payload,
      timestamp: new Date().toISOString(),
    });
  }

  sendCommandAck(requestId: string): boolean {
    return this.send({
      type: 'agent.command.ack',
      agentId: this.tokenStore.getAgentId(),
      payload: { requestId },
      timestamp: new Date().toISOString(),
    });
  }

  sendStream(payload: { event: string; data?: Record<string, unknown>; conversationId?: string; sessionId?: string; requestId?: string }): boolean {
    return this.send({
      type: 'agent.stream',
      agentId: this.tokenStore.getAgentId(),
      payload,
      timestamp: new Date().toISOString(),
    });
  }

  sendResearchArtifact(payload: { artifactId: string; title?: string; markdown: string; conversationId?: string; sessionId?: string; requestId?: string; topic?: string }): void {
    this.send({
      type: 'research.artifact',
      agentId: this.tokenStore.getAgentId(),
      payload,
      timestamp: new Date().toISOString(),
    });
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      const socket = this.ws;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      if (this.awaitingPong) {
        logger.warn('Mercury Cloud WebSocket heartbeat timed out; reconnecting');
        socket.terminate();
        return;
      }
      this.awaitingPong = true;
      try {
        socket.ping();
      } catch (error) {
        logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'Mercury Cloud WebSocket ping failed');
        socket.terminate();
        return;
      }
      this.send({
        type: 'agent.heartbeat',
        agentId: this.tokenStore.getAgentId(),
        timestamp: new Date().toISOString(),
      });
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatInterval.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private startTokenCheck(): void {
    this.stopTokenCheck();
    this.tokenCheckInterval = setInterval(() => {
      if (this.authRefreshNeeded || this.tokenStore.isJwtNearExpiry()) void this.tryRefreshAndReconnect();
    }, 60_000);
    this.tokenCheckInterval.unref?.();
  }

  private stopTokenCheck(): void {
    if (this.tokenCheckInterval) {
      clearInterval(this.tokenCheckInterval);
      this.tokenCheckInterval = null;
    }
  }

  private async tryRefreshAndReconnect(): Promise<void> {
    if (
      this.isRefreshing
      || (!this.tokenStore.getRefreshToken() && !this.tokenStore.getAgentApiKey())
      || !this.shouldReconnect
    ) return;
    this.isRefreshing = true;
    const generation = this.lifecycleGeneration;

    try {
      const result = await this.tokenStore.rotate();
      if (!this.shouldReconnect || generation !== this.lifecycleGeneration) return;
      this.authRefreshNeeded = false;

      // Notify the rest of the agent that the tokens changed. The shared store
      // already persisted + notified its listeners (including the provider);
      // this synthetic event keeps the legacy `token.refreshed` handler path
      // in index.ts in sync for any additional wiring.
      const refreshHandler = this.handlers.get('token.refreshed');
      if (refreshHandler) {
        for (const handler of refreshHandler) {
          const message = { type: 'token.refreshed' as WSMessageType, payload: { jwt: result.jwt, refreshToken: result.refreshToken } };
          this.runHandler('token.refreshed', () => handler(message));
        }
      }

      if (!this.isConnected()) {
        this.ws = null;
        await this.connect();
      }
    } catch (err: any) {
      // Automatic background refresh should never spam the interactive TUI.
      // Keep diagnostics in logs, rate-limited, and retry on the next check/call.
      const now = Date.now();
      if (now - this.lastRefreshFailureLogAt > 10 * 60 * 1000) {
        this.lastRefreshFailureLogAt = now;
        logger.warn({ err: err?.message || String(err) }, 'Mercury Cloud background token refresh failed; will retry later');
      }
      if (this.shouldReconnect && !this.isConnected()) this.scheduleReconnect();
    } finally {
      this.isRefreshing = false;
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect || this.reconnectTimer) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.reconnectAttempts = Math.floor(this.maxReconnectAttempts / 2);
    }

    const baseDelay = Math.min(1000 * 2 ** this.reconnectAttempts, 60_000);
    const jitteredDelay = Math.round(baseDelay * (0.5 + Math.random() * 0.5));
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldReconnect) {
        if (this.authRefreshNeeded) {
          void this.tryRefreshAndReconnect();
        } else {
          void this.connect().catch(() => {});
        }
      }
    }, jitteredDelay);
    if (this.reconnectTimer && typeof this.reconnectTimer.unref === 'function') {
      this.reconnectTimer.unref();
    }
  }

  private runHandler(type: string, handler: () => void | Promise<void>): void {
    try {
      void Promise.resolve(handler()).catch((error) => {
        logger.error({ err: error instanceof Error ? error.message : String(error), type }, 'Mercury Cloud WebSocket handler failed');
      });
    } catch (error) {
      logger.error({ err: error instanceof Error ? error.message : String(error), type }, 'Mercury Cloud WebSocket handler failed');
    }
  }
}
