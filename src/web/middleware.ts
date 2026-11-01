import { Context, Next } from 'hono';
import { getCookie } from 'hono/cookie';
import { validateSession, getSessionCookieName, readAttachToken } from './auth.js';
import { looksLikeDeviceToken, validateDeviceToken } from './devices.js';

const PUBLIC_PATHS = new Set(['/login', '/api/auth/login', '/api/auth/logout', '/api/auth/token', '/api/health']);

/**
 * The attach token is only honored from loopback connections. Defense in
 * depth: the secret itself is an owner-only file, but a matching token from
 * a non-loopback peer must not open the API even if a future bug leaks it.
 */
export function isLoopbackRequest(c: Context): boolean {
  try {
    const address: string = (c.env as any)?.incoming?.socket?.remoteAddress || '';
    return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
  } catch {
    return false;
  }
}

export type Principal =
  | { kind: 'session' }
  | { kind: 'attach' }
  | { kind: 'device'; deviceId: string; deviceName: string };

export function bearerToken(c: Context): string | null {
  const header = c.req.header('Authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/**
 * Who is calling, or null.
 *
 *  - web session: cookie (browser) or Bearer (scripts) — any peer;
 *  - device token: Bearer, any peer — that is its purpose (devices.ts);
 *  - attach token: Bearer, loopback only.
 */
export function authenticateRequest(c: Context): Principal | null {
  const cookieToken = getCookie(c, getSessionCookieName());
  if (cookieToken && validateSession(cookieToken)) return { kind: 'session' };

  const bearer = bearerToken(c);
  if (!bearer) return null;
  if (validateSession(bearer)) return { kind: 'session' };
  if (looksLikeDeviceToken(bearer)) {
    const device = validateDeviceToken(bearer);
    return device ? { kind: 'device', deviceId: device.id, deviceName: device.name } : null;
  }
  // Attach clients (`mercury attach`) authenticate with the machine-local
  // token instead of the interactive web login.
  if (isLoopbackRequest(c) && bearer === readAttachToken()) return { kind: 'attach' };
  return null;
}

export async function authGuard(c: Context, next: Next) {
  const path = new URL(c.req.url).pathname;
  if (path.startsWith('/vendor/') || path.startsWith('/static/') || path.startsWith('/assets/') || path.startsWith('/icons/') || path.endsWith('.css') || path.endsWith('.js') || path.endsWith('.png') || path.endsWith('.ico') || path.endsWith('.svg') || path.endsWith('.woff2') || path.endsWith('.webmanifest')) {
    return next();
  }
  if (PUBLIC_PATHS.has(path)) {
    return next();
  }
  // A plugin renderer is drawn in `<iframe sandbox="allow-scripts">`: an opaque origin,
  // so the browser sends no cookie and the session check could never pass. The asset is
  // shipped code with a CSP that allows nothing; the listing above stays authenticated.
  if (path.startsWith('/api/ui/renderers/') && path !== '/api/ui/renderers/') {
    return next();
  }
  if (path.startsWith('/api/')) {
    if (authenticateRequest(c)) {
      return next();
    }
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const token = getCookie(c, getSessionCookieName());
  if (!token || !validateSession(token)) {
    return c.redirect('/login');
  }
  return next();
}

export async function errorHandler(c: Context, next: Next) {
  try {
    return await next();
  } catch (err: any) {
    console.error('[web] Error:', err.message);
    if (c.req.url.includes('/api/')) {
      return c.json({ error: err.message || 'Internal server error' }, 500);
    }
    return c.html('<h1>500 — Internal Server Error</h1>', 500);
  }
}
