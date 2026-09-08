import { loadConfig, saveConfig, updateConfig, type MercuryConfig } from '../utils/config.js';
import { refreshToken as rotateRefreshToken, redeemAgentApiKey } from './pairing.js';
import { logger } from '../utils/logger.js';

export interface TokenPair {
  jwt: string;
  refreshToken: string;
}

export type TokenRefreshListener = (tokens: TokenPair) => void;

/**
 * Single source of truth for the Mercury Cloud access + refresh tokens.
 *
 * Every consumer (WS client, MercuryCloud provider, pool search, chat
 * command handler) MUST read from and write back to this store. This is
 * critical because refresh tokens are single-use: once one consumer rotates
 * the token, every other consumer's cached copy is permanently invalid. The
 * old design gave each consumer its own private copy of the refresh token, so
 * the second rotation (after ~15 minutes) used an already-consumed token and
 * the WebSocket died until the user manually ran `mercury cloud connect`.
 *
 * This store keeps one in-memory copy, persists every rotation to disk, and
 * notifies listeners so the WS client and provider swap their cached JWT
 * without racing the auth endpoint.
 *
 * As a last-resort recovery, when the refresh token is dead (expired or
 * already consumed) the store redeems the long-lived agent API key (issued at
 * pairing time) for a fresh JWT + refresh-token pair — so a paired agent
 * self-recovers without forcing the user through a browser re-pair.
 */
export class CloudTokenStore {
  private jwt: string;
  private refreshTokenValue: string;
  private readonly apiUrl: string;
  private readonly agentId: string;
  private agentApiKey: string;
  private listeners = new Set<TokenRefreshListener>();
  private inflight: Promise<TokenPair> | null = null;
  private readonly liveConfig?: MercuryConfig;
  private active = true;

  constructor(jwt: string, refreshTokenValue: string, apiUrl: string, agentId: string, liveConfig?: MercuryConfig, agentApiKey?: string) {
    this.jwt = jwt;
    this.refreshTokenValue = refreshTokenValue;
    this.apiUrl = apiUrl;
    this.agentId = agentId;
    this.liveConfig = liveConfig;
    this.agentApiKey = agentApiKey ?? liveConfig?.cloud.agentApiKey ?? '';
  }

  getTokens(): TokenPair {
    return { jwt: this.jwt, refreshToken: this.refreshTokenValue };
  }

  getJwt(): string {
    return this.jwt;
  }

  getRefreshToken(): string {
    return this.refreshTokenValue;
  }

  getAgentId(): string {
    return this.agentId;
  }

  getApiUrl(): string {
    return this.apiUrl;
  }

  getAgentApiKey(): string {
    return this.agentApiKey;
  }

  matchesIdentity(apiUrl: string, agentId: string): boolean {
    return this.active && this.apiUrl === apiUrl && this.agentId === agentId;
  }

  setAgentApiKey(apiKey: string): void {
    if (!this.active) throw new Error('Mercury Cloud credentials have been invalidated');
    this.agentApiKey = apiKey;
    if (this.liveConfig) this.liveConfig.cloud.agentApiKey = apiKey;
    this.persistAgentApiKey(apiKey);
  }

  private persistAgentApiKey(apiKey: string): void {
    try {
      const config = loadConfig();
      config.cloud.agentApiKey = apiKey;
      saveConfig(config);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Failed to persist agent API key to config');
    }
  }

  /**
   * Update the cached tokens without persisting to disk. Use when the caller
   * has already persisted (e.g. the pairing flow writes config itself).
   */
  setTokens(jwt: string, refreshTokenValue: string): void {
    if (!this.active) throw new Error('Mercury Cloud credentials have been invalidated');
    this.jwt = jwt;
    this.refreshTokenValue = refreshTokenValue;
    if (this.liveConfig) {
      this.liveConfig.cloud.jwt = jwt;
      this.liveConfig.cloud.refreshToken = refreshTokenValue;
      this.liveConfig.providers.mercuryCloud.apiKey = this.liveConfig.cloud.accessKey || jwt;
    }
    for (const listener of this.listeners) {
      try { listener({ jwt, refreshToken: refreshTokenValue }); } catch (err) {
        logger.warn({ err: (err as Error).message }, 'Cloud token store listener threw');
      }
    }
  }

  /**
   * Update the cached tokens AND persist to disk + mirror into the provider
   * config. This is the path used by background rotation.
   */
  setTokensAndPersist(jwt: string, refreshTokenValue: string): void {
    updateConfig((config) => {
      this.assertActivePersistedIdentity(config);
      config.cloud.jwt = jwt;
      config.cloud.refreshToken = refreshTokenValue;
      config.providers.mercuryCloud.apiKey = config.cloud.accessKey || jwt;
    });
    this.setTokens(jwt, refreshTokenValue);
  }

  /**
   * Rotate the refresh token exactly once across all concurrent callers.
   * Returns the new pair and persists + notifies listeners. If the refresh
   * token is dead (expired or already consumed), falls back to redeeming the
   * long-lived agent API key so the agent self-recovers without a re-pair.
   */
  async rotate(): Promise<TokenPair> {
    if (!this.active) throw new Error('Mercury Cloud credentials have been invalidated');
    if (this.inflight) return this.inflight;
    if (!this.refreshTokenValue && !this.agentApiKey) throw new Error('No refresh token or agent API key available');

    this.inflight = (async () => {
      const tokenBeingRotated = this.refreshTokenValue;
      const persisted = this.readNewerPersistedTokens(tokenBeingRotated);
      if (persisted) return persisted;
      if (!this.active) throw new Error('Mercury Cloud was disconnected or re-paired');

      if (tokenBeingRotated) {
        try {
          const result = await rotateRefreshToken(this.apiUrl, tokenBeingRotated);
          this.setTokensAndPersist(result.jwt, result.refreshToken);
          return result;
        } catch (error) {
          if (!this.active) throw error;
          // Another Mercury process may have won the single-use rotation and
          // persisted the successor while this request was in flight.
          for (const delay of [50, 150, 300]) {
            await new Promise((resolve) => setTimeout(resolve, delay));
            const adopted = this.readNewerPersistedTokens(tokenBeingRotated);
            if (adopted) return adopted;
          }
          // Refresh token is genuinely dead. Try the long-lived agent API key
          // before giving up — this is the self-recovery path that avoids a
          // browser re-pair for remotely-deployed agents.
          if (this.agentApiKey) {
            logger.warn({ err: (error as Error).message }, 'Refresh token rotation failed; redeeming agent API key');
            return await this.redeemWithAgentKey();
          }
          throw error;
        }
      } else {
        // No refresh token at all — go straight to the agent API key.
        return await this.redeemWithAgentKey();
      }
    })().finally(() => {
      this.inflight = null;
    });

    return this.inflight;
  }

  /**
   * Redeem the long-lived agent API key for a fresh JWT + refresh-token pair.
   * On success, persists the new tokens (and keeps the same agent API key)
   * and notifies listeners. Throws if the API key is invalid/revoked.
   */
  private async redeemWithAgentKey(): Promise<TokenPair> {
    if (!this.agentApiKey) throw new Error('No agent API key available for recovery');
    const result = await redeemAgentApiKey(this.apiUrl, this.agentApiKey);
    if (!result.agentId || result.agentId !== this.agentId) {
      throw new Error('Agent API key identity mismatch; re-pair Mercury Cloud');
    }
    this.setTokensAndPersist(result.jwt, result.refreshToken);
    return { jwt: result.jwt, refreshToken: result.refreshToken };
  }

  /**
   * Rotate only if the access token is expired or within `skewMs` of expiry.
   * Returns the current (possibly newly rotated) JWT.
   */
  async rotateIfExpired(skewMs = 60_000): Promise<string> {
    if (!isTokenExpired(this.jwt, skewMs)) return this.jwt;
    const result = await this.rotate();
    return result.jwt;
  }

  /**
   * Decode the JWT and return true if it is malformed or within `skewMs` of
   * (or past) its `exp` claim.
   */
  isJwtNearExpiry(skewMs = 60_000): boolean {
    return isTokenExpired(this.jwt, skewMs);
  }

  addListener(listener: TokenRefreshListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  invalidate(): void {
    if (!this.active) return;
    this.active = false;
    this.jwt = '';
    this.refreshTokenValue = '';
    this.agentApiKey = '';
    for (const listener of this.listeners) {
      try { listener({ jwt: '', refreshToken: '' }); } catch {}
    }
    this.listeners.clear();
  }

  private assertActivePersistedIdentity(config: MercuryConfig): void {
    if (
      !config.cloud.enabled
      || !config.providers.mercuryCloud.enabled
      || config.cloud.agentId !== this.agentId
      || config.cloud.apiUrl !== this.apiUrl
    ) {
      this.invalidate();
      throw new Error('Mercury Cloud was disconnected or re-paired while credentials were refreshing');
    }
  }

  private readNewerPersistedTokens(comparedRefreshToken: string): TokenPair | null {
    try {
      const config = loadConfig();
      if (
        !config.cloud.enabled
        || !config.providers.mercuryCloud.enabled
        || config.cloud.agentId !== this.agentId
        || config.cloud.apiUrl !== this.apiUrl
      ) {
        this.invalidate();
        return null;
      }
      if (
        !config.cloud.jwt
        || !config.cloud.refreshToken
        || config.cloud.refreshToken === comparedRefreshToken
      ) return null;
      this.setTokens(config.cloud.jwt, config.cloud.refreshToken);
      return { jwt: config.cloud.jwt, refreshToken: config.cloud.refreshToken };
    } catch {
      return null;
    }
  }
}

function isTokenExpired(jwt: string, skewMs = 60_000): boolean {
  const parts = jwt.split('.');
  if (parts.length !== 3) return true;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { exp?: number };
    return typeof payload.exp !== 'number' || Date.now() >= payload.exp * 1000 - skewMs;
  } catch {
    return true;
  }
}

let store: CloudTokenStore | null = null;

/**
 * Initialize (or re-initialize) the shared token store from the current config.
 * Called once at agent startup. Subsequent calls replace the singleton so a
 * re-pair updates the store with the new credentials.
 */
export function initCloudTokenStore(config: MercuryConfig): CloudTokenStore {
  store?.invalidate();
  const next = new CloudTokenStore(
    config.cloud.jwt,
    config.cloud.refreshToken,
    config.cloud.apiUrl,
    config.cloud.agentId,
    config,
    config.cloud.agentApiKey,
  );
  store = next;
  return next;
}

export function getCloudTokenStore(): CloudTokenStore | null {
  return store;
}

export function clearCloudTokenStore(): void {
  store?.invalidate();
  store = null;
}
