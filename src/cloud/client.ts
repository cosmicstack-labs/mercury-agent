import type { WSMessage, WSMessageType } from './types.js';
import { refreshToken } from './pairing.js';
import { WebSocket } from 'ws';
import { logger } from '../utils/logger.js';

export type WSMessageHandler = (message: WSMessage) => void | Promise<void>;

const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_BUFFERED_AMOUNT = 1024 * 1024;

export class MercuryCloudClient {
  private ws: WebSocket | null = null;
  private url: string;
  private token: string;
  private refreshTokenValue: string;
  private apiUrl: string;
  private agentId: string;
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

  constructor(url: string, token: string, agentId: string, refreshTokenVal: string, apiUrl: string) {
    this.url = url;
    this.token = token;
    this.agentId = agentId;
    this.refreshTokenValue = refreshTokenVal;
    this.apiUrl = apiUrl;
  }

  async connect(): Promise<void> {
    if (this.isConnected()) return;
    if (this.connectPromise) return this.connectPromise;
    this.shouldReconnect = true;
    this.isConnecting = true;

    const wsUrl = `${this.url}?agentId=${this.agentId}&token=${this.token}`;

    try {
      const socket = new WebSocket(wsUrl, { handshakeTimeout: 15_000 });
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
      agentId: this.agentId,
      payload,
      timestamp: new Date().toISOString(),
    });
  }

  sendCommandAck(requestId: string): boolean {
    return this.send({
      type: 'agent.command.ack',
      agentId: this.agentId,
      payload: { requestId },
      timestamp: new Date().toISOString(),
    });
  }

  sendStream(payload: { event: string; data?: Record<string, unknown>; conversationId?: string; sessionId?: string; requestId?: string }): boolean {
    return this.send({
      type: 'agent.stream',
      agentId: this.agentId,
      payload,
      timestamp: new Date().toISOString(),
    });
  }

  sendResearchArtifact(payload: { artifactId: string; title?: string; markdown: string; conversationId?: string; sessionId?: string; requestId?: string; topic?: string }): void {
    this.send({
      type: 'research.artifact',
      agentId: this.agentId,
      payload,
      timestamp: new Date().toISOString(),
    });
  }

  updateToken(token: string): void {
    this.token = token;
  }

  updateRefreshToken(refreshTokenVal: string): void {
    this.refreshTokenValue = refreshTokenVal;
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
        agentId: this.agentId,
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
      if (this.authRefreshNeeded || this.isTokenNearExpiry()) void this.tryRefreshAndReconnect();
    }, 3 * 60 * 1000);
    this.tokenCheckInterval.unref?.();
  }

  private stopTokenCheck(): void {
    if (this.tokenCheckInterval) {
      clearInterval(this.tokenCheckInterval);
      this.tokenCheckInterval = null;
    }
  }

  private async tryRefreshAndReconnect(): Promise<void> {
    if (this.isRefreshing || !this.refreshTokenValue || !this.shouldReconnect) return;
    this.isRefreshing = true;
    const generation = this.lifecycleGeneration;

    try {
      const result = await refreshToken(this.apiUrl, this.refreshTokenValue);
      if (!this.shouldReconnect || generation !== this.lifecycleGeneration) return;
      this.token = result.jwt;
      this.refreshTokenValue = result.refreshToken;
      this.authRefreshNeeded = false;

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

  private isTokenNearExpiry(): boolean {
    const parts = this.token.split('.');
    if (parts.length !== 3) return true;
    try {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { exp?: number };
      return typeof payload.exp !== 'number' || Date.now() >= payload.exp * 1000 - 60_000;
    } catch {
      return true;
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
