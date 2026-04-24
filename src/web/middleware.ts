import { Context, Next } from 'hono';
import { getCookie } from 'hono/cookie';
import { validateSession, getSessionCookieName } from './auth.js';

const PUBLIC_PATHS = new Set(['/login', '/api/auth/login']);

export async function authGuard(c: Context, next: Next) {
  const path = new URL(c.req.url).pathname;
  if (path.startsWith('/vendor/') || path.startsWith('/static/') || path.endsWith('.css') || path.endsWith('.js') || path.endsWith('.png') || path.endsWith('.ico')) {
    return next();
  }
  if (PUBLIC_PATHS.has(path)) {
    return next();
  }
  if (path.startsWith('/api/')) {
    const token = getCookie(c, getSessionCookieName()) || c.req.header('Authorization')?.replace('Bearer ', '');
    if (!token || !validateSession(token)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return next();
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