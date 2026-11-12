import type { ProviderConfig } from '../utils/config.js';
import { logger } from '../utils/logger.js';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const warnedOrigins = new Set<string>();

type BasicAuthConfig = Pick<ProviderConfig, 'baseUrl' | 'username' | 'password'>;

/**
 * HTTP Basic credentials for a server behind a reverse proxy (nginx, Caddy,
 * Cloudflare Access). The header replaces the Bearer one, and is sent only
 * when a username is set. Every request that carries it goes through here, so
 * the plain-http warning is raised here, once per server.
 */
export function basicAuthHeaders(config: BasicAuthConfig): Record<string, string> | undefined {
  if (!config.username) return undefined;
  warnIfClear(config);
  const token = Buffer.from(`${config.username}:${config.password ?? ''}`, 'utf8').toString('base64');
  return { Authorization: `Basic ${token}` };
}

function warnIfClear(config: BasicAuthConfig): void {
  if (!sendsPasswordInClear(config)) return;
  const origin = new URL(config.baseUrl).origin; // no user:pass@ part
  if (warnedOrigins.has(origin)) return;
  warnedOrigins.add(origin);
  logger.warn({ origin }, 'Username and password go over plain http to another machine; use https:// in baseUrl');
}

/** The saved config pointed at a URL typed now. Saved Basic credentials belong to the saved server, so another URL gets none. */
export function withBaseUrl(saved: ProviderConfig, baseUrl: string): ProviderConfig {
  const trim = (u: string) => u.replace(/\/+$/, '');
  const sameServer = trim(baseUrl) === trim(saved.baseUrl ?? '');
  return { ...saved, ...(sameServer ? {} : { username: undefined, password: undefined }), baseUrl };
}

/** Basic auth is only base64: over plain http to another machine the password is readable on the wire. */
export function sendsPasswordInClear(config: Pick<ProviderConfig, 'baseUrl' | 'username'>): boolean {
  if (!config.username) return false;
  try {
    const url = new URL(config.baseUrl);
    return url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}
