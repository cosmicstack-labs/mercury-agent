import type { WSMessage, WSMessageType } from './types.js';
import { refreshToken } from './pairing.js';

export type WSMessageHandler = (message: WSMessage) => void;

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
  private maxReconnectAttempts = 10;
  private handlers = new Map<string, WSMessageHandler[]>();
  private isConnecting = false;
  private shouldReconnect = true;
  private isRefreshing = false;

  constructor(url: string, token: string, agentId: string, refreshTokenVal: string, apiUrl: string) {
    this.url = url;
    this.token = token;
    this.agentId = agentId;
    this.refreshTokenValue = refreshTokenVal;
    this.apiUrl = apiUrl;
  }

  async connect(): Promise<void> {
    if (this.isConnecting || this.ws) return;
    this.isConnecting = true;

    const wsUrl = `${this.url}?agentId=${this.agentId}&token=${this.token}`;

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        this.startHeartbeat();
        this.startTokenCheck();
      };

      this.ws.onmessage = (event: MessageEvent) => {
        try {
          const message = JSON.parse(event.data as string) as WSMessage;
          const handlers = this.handlers.get(message.type) || [];
          for (const handler of handlers) {
            handler(message);
          }
        } catch {
        }
      };

      this.ws.onclose = (event: any) => {
        this.isConnecting = false;
        this.stopHeartbeat();
        this.stopTokenCheck();
        this.ws = null;

        if (event.code === 1008) {
          this.tryRefreshAndReconnect();
          return;
        }

        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = () => {
        this.isConnecting = false;
      };
    } catch {
      this.isConnecting = false;
      this.scheduleReconnect();
    }
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.stopHeartbeat();
    this.stopTokenCheck();
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

  send(message: WSMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
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
      this.send({
        type: 'agent.heartbeat',
        agentId: this.agentId,
        timestamp: new Date().toISOString(),
      });
    }, 60_000);
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
      this.tryRefreshAndReconnect();
    }, 10 * 60 * 1000);
  }

  private stopTokenCheck(): void {
    if (this.tokenCheckInterval) {
      clearInterval(this.tokenCheckInterval);
      this.tokenCheckInterval = null;
    }
  }

  private async tryRefreshAndReconnect(): Promise<void> {
    if (this.isRefreshing || !this.refreshTokenValue) return;
    this.isRefreshing = true;

    try {
      const result = await refreshToken(this.apiUrl, this.refreshTokenValue);
      this.token = result.jwt;
      this.refreshTokenValue = result.refreshToken;

      const refreshHandler = this.handlers.get('token.refreshed');
      if (refreshHandler) {
        for (const handler of refreshHandler) {
          handler({ type: 'token.refreshed' as WSMessageType, payload: { jwt: result.jwt, refreshToken: result.refreshToken } });
        }
      }

      if (!this.isConnected()) {
        this.ws = null;
        this.connect();
      }
    } catch {
    } finally {
      this.isRefreshing = false;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return;

    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30_000);
    this.reconnectAttempts++;

    setTimeout(() => {
      if (this.shouldReconnect) {
        this.connect();
      }
    }, delay);
  }
}