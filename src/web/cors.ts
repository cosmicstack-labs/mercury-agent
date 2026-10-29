import { cors } from 'hono/cors';
import type { MiddlewareHandler } from 'hono';

/**
 * CORS for clients that are not served by this runtime: Mercury Desktop's
 * webview has its own origin (`tauri://localhost` on macOS and Linux,
 * `http://tauri.localhost` on Windows). Browsers served from this runtime
 * are same-origin and never need this.
 *
 * Authentication is `Authorization: Bearer`, never a cookie, so this does
 * not enable credentials and a cross-site page cannot ride the session
 * cookie through it. Extra origins (a self-hosted web build, a dev server)
 * come from `web.corsOrigins` in mercury.yaml.
 */

export const DESKTOP_ORIGINS: readonly string[] = Object.freeze([
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
]);

/** Vite's default port for `tauri dev`; only honored when the developer asks for it. */
const DEV_ORIGINS: readonly string[] = Object.freeze([
  'http://localhost:1420',
  'http://127.0.0.1:1420',
]);

export function allowedOrigins(extra: readonly string[] | undefined, env: NodeJS.ProcessEnv = process.env): Set<string> {
  const set = new Set<string>(DESKTOP_ORIGINS);
  if (env.MERCURY_DESKTOP_DEV === '1') for (const o of DEV_ORIGINS) set.add(o);
  for (const raw of extra ?? []) {
    const origin = normalizeOrigin(raw);
    if (origin) set.add(origin);
  }
  return set;
}

/** An origin is scheme://host[:port], nothing else. Anything else is dropped. */
export function normalizeOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '*') return null; // never wildcard an authenticated API
  try {
    const url = new URL(trimmed);
    if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) return null;
    return url.origin === 'null' ? null : url.origin;
  } catch {
    return null;
  }
}

export function apiCors(extra: readonly string[] | undefined): MiddlewareHandler {
  const allowed = allowedOrigins(extra);
  return cors({
    origin: (origin) => (allowed.has(origin) ? origin : null),
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type', 'Accept', 'Last-Event-ID', 'Cache-Control'],
    exposeHeaders: ['Content-Type', 'Content-Disposition'],
    maxAge: 600,
    credentials: false,
  });
}
