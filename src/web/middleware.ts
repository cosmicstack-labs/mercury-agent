import { Context, Next } from 'hono';
import { getCookie } from 'hono/cookie';
import { validateSession, getSessionCookieName, readAttachToken } from './auth.js';

const PUBLIC_PATHS = new Set(['/login', '/api/auth/login', '/api/auth/logout']);

/**
 * The attach token is only honored from loopback connections. Defense in
 * depth: the secret itself is an owner-only file, but a matching token from
 * a non-loopback peer must not open the API even if a future bug leaks it.
 */
function isLoopbackRequest(c: Context): boolean {
  try {
    const address: string = (c.env as any)?.incoming?.socket?.remoteAddress || '';
    return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
  } catch {
    return false;
  }
}

export async function authGuard(c: Context, next: Next) {
  const path = new URL(c.req.url).pathname;
  if (path.startsWith('/vendor/') || path.startsWith('/static/') || path.startsWith('/assets/') || path.startsWith('/icons/') || path.endsWith('.css') || path.endsWith('.js') || path.endsWith('.png') || path.endsWith('.ico') || path.endsWith('.svg') || path.endsWith('.woff2') || path.endsWith('.webmanifest')) {
    return next();
  }
  if (PUBLIC_PATHS.has(path)) {
    return next();
  }
  if (path.startsWith('/api/')) {
    const token = getCookie(c, getSessionCookieName()) || c.req.header('Authorization')?.replace('Bearer ', '');
    if (token && validateSession(token)) {
      return next();
    }
    // Attach clients (`mercury attach`) authenticate with the machine-local
    // token instead of the interactive web login.
    if (token && isLoopbackRequest(c) && token === readAttachToken()) {
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