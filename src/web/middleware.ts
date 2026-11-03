import { Context, Next } from 'hono';
import { getCookie } from 'hono/cookie';
import { attachTokenMatches, getSessionCookieName, sessionKey, validateSession } from './auth.js';
import { checkDeviceToken, looksLikeDeviceToken, noteDeviceSeen } from './devices.js';
import { requestOrigin, hostName, type RequestOrigin } from '../security/request-origin.js';
import { readRemoteSettings } from '../security/remote-settings.js';
import { ipAllowed } from '../security/ip-match.js';
import { audit } from '../security/audit.js';
import { loadConfig } from '../utils/config.js';
import { logger } from '../utils/logger.js';

const PUBLIC_PATHS = new Set(['/login', '/api/auth/login', '/api/auth/logout', '/api/auth/token', '/api/auth/token/pending', '/api/health']);

export type Principal =
  | { kind: 'session'; key: string; via: 'cookie' | 'bearer' }
  | { kind: 'attach' }
  | { kind: 'device'; deviceId: string; deviceName: string };

const origins = new WeakMap<Request, RequestOrigin>();
const principals = new WeakMap<Request, Principal | null>();
const expiredDevices = new WeakMap<Request, { name: string }>();

/** Where this request really comes from (see security/request-origin.ts). Computed once per request. */
export function originOf(c: Context): RequestOrigin {
  let o = origins.get(c.req.raw);
  if (!o) { o = requestOrigin(c); origins.set(c.req.raw, o); }
  return o;
}

/**
 * From this machine, not through a tunnel or proxy. (Kept under its old name:
 * it used to look only at the socket, which every same-host tunnel passes.)
 */
export function isLoopbackRequest(c: Context): boolean {
  return originOf(c).local;
}

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
 *  - attach token: Bearer, this machine only (never through a tunnel).
 */
export function authenticateRequest(c: Context): Principal | null {
  if (principals.has(c.req.raw)) return principals.get(c.req.raw) ?? null;
  const p = resolvePrincipal(c);
  principals.set(c.req.raw, p);
  return p;
}

function resolvePrincipal(c: Context): Principal | null {
  const cookieToken = getCookie(c, getSessionCookieName());
  if (cookieToken && validateSession(cookieToken)) return { kind: 'session', key: sessionKey(cookieToken), via: 'cookie' };

  const bearer = bearerToken(c);
  if (!bearer) return null;
  if (looksLikeDeviceToken(bearer)) {
    const r = checkDeviceToken(bearer);
    if (r.ok) return { kind: 'device', deviceId: r.device.id, deviceName: r.device.name };
    if (r.expired) expiredDevices.set(c.req.raw, { name: r.expired.name });
    return null;
  }
  if (validateSession(bearer)) return { kind: 'session', key: sessionKey(bearer), via: 'bearer' };
  // Attach clients (`mercury attach`, Mercury Desktop on this machine)
  // authenticate with the machine-local token instead of the web login.
  const o = originOf(c);
  if (o.socketLocal && !o.proxied && attachTokenMatches(bearer)) return { kind: 'attach' };
  return null;
}

/** The principal of an authenticated request (set by authGuard). */
export function principalOf(c: Context): Principal | null {
  return authenticateRequest(c);
}

/** "device:<id>" / "session:<key>" / "attach": who to close streams for, who an approval is for. */
export function principalKey(p: Principal | null): string | null {
  if (!p) return null;
  return p.kind === 'device' ? `device:${p.deviceId}` : p.kind === 'session' ? `session:${p.key}` : 'attach';
}

/** A name for the security log and approval questions. */
export function principalLabel(p: Principal | null): string {
  if (!p) return 'someone';
  return p.kind === 'device' ? p.deviceName : p.kind === 'session' ? 'a browser' : 'this computer';
}

/**
 * The caller is on this computer: Mercury Desktop or the CLI here (attach
 * token), or a browser here that signed in (not through a tunnel).
 */
export function isThisComputer(c: Context): boolean {
  const p = authenticateRequest(c);
  const o = originOf(c);
  if (p?.kind === 'attach') return true;
  if (p?.kind === 'session') return o.local;
  // No principal on a protected route only happens when a route is called
  // without authGuard in front (in-process route tests, which also carry no
  // socket): then the origin decides, and no socket at all counts as here.
  if (p === null) return o.local || !hasSocket(c);
  return false;
}

function hasSocket(c: Context): boolean {
  return !!(c.env as { incoming?: { socket?: unknown } } | undefined)?.incoming?.socket;
}

/** Only on this computer; otherwise the 403 to return. */
export function requireThisComputer(c: Context, what = 'This'): Response | null {
  if (isThisComputer(c)) return null;
  return c.json({ error: `${what} only works on the computer Mercury runs on.`, thisComputerOnly: true }, 403);
}

function allowedHosts(): Set<string> {
  try {
    return new Set((loadConfig().web?.allowedHosts ?? []).map((h) => hostName(String(h))));
  } catch {
    return new Set();
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** A cookie-authenticated change must come from a page this server (or an allowed app) served. */
function crossSite(c: Context): boolean {
  const origin = c.req.header('origin') ?? (() => { try { return new URL(c.req.header('referer') ?? '').origin; } catch { return ''; } })();
  if (!origin || origin === 'null') return true;
  try {
    const host = c.req.header('x-forwarded-host') || c.req.header('host') || '';
    return new URL(origin).host.toLowerCase() !== host.toLowerCase();
  } catch {
    return true;
  }
}

/** The last request from outside this computer: what the security screen says about the tunnel. */
let lastRemote: { at: number; proxied: boolean; clientIpKnown: boolean; ip: string } | null = null;
export function lastRemoteRequest(): typeof lastRemote { return lastRemote; }

const blockedLogged = new Map<string, number>();
function logBlocked(ip: string, detail: string): void {
  const now = Date.now();
  if ((blockedLogged.get(ip) ?? 0) > now - 10 * 60_000) return;
  blockedLogged.set(ip, now);
  if (blockedLogged.size > 1000) blockedLogged.clear();
  audit('device.blocked', { ip, detail });
}

/** Tell the owner, once per new address per device. */
let newLocationHook: ((device: { id: string; name: string }, ip: string) => void) | null = null;
export function onDeviceNewLocation(fn: typeof newLocationHook): void { newLocationHook = fn; }

export async function authGuard(c: Context, next: Next) {
  const path = new URL(c.req.url).pathname;
  const origin = originOf(c);
  const api = path.startsWith('/api/');

  // DNS rebinding: a request straight to this machine must name this machine.
  // (Through a tunnel the Host is its public name; that's what `proxied` covers.)
  if (origin.socketLocal && !origin.proxied && !origin.hostLocal && !allowedHosts().has(hostName(c.req.header('host') || new URL(c.req.url).host))) {
    return api ? c.json({ error: 'Unknown host. Add it to web.allowedHosts if you put Mercury behind your own proxy.' }, 421) : c.text('Unknown host', 421);
  }

  // Remote clients: remote access has to be on, and their address allowed.
  if (!origin.local) {
    lastRemote = { at: Date.now(), proxied: origin.proxied, clientIpKnown: origin.clientIpKnown, ip: origin.clientIp };
    const remote = readRemoteSettings();
    if (!remote.enabled) {
      logBlocked(origin.clientIp, 'remote access is off');
      return api ? c.json({ error: 'Remote access is turned off on this Mercury. Turn it on with /server on the computer it runs on.', remoteOff: true }, 403) : c.text('Remote access is turned off on this Mercury.', 403);
    }
    if (remote.allowIps.length && (!origin.clientIpKnown || !ipAllowed(origin.clientIp, remote.allowIps))) {
      logBlocked(origin.clientIp, origin.clientIpKnown ? 'address not allowed' : 'address unknown (the tunnel did not pass it)');
      return api ? c.json({ error: 'This address is not allowed to connect to this Mercury.', addressBlocked: true }, 403) : c.text('This address is not allowed to connect.', 403);
    }
  }

  if (path.startsWith('/vendor/') || path.startsWith('/static/') || path.startsWith('/assets/') || path.startsWith('/icons/') || path.endsWith('.css') || path.endsWith('.js') || path.endsWith('.png') || path.endsWith('.ico') || path.endsWith('.svg') || path.endsWith('.woff2') || path.endsWith('.webmanifest')) {
    return next();
  }
  if (PUBLIC_PATHS.has(path)) {
    // The sign-in form posts from its own page; anything else posting a password is forged.
    if (!SAFE_METHODS.has(c.req.method) && path === '/api/auth/login' && crossSite(c)) return c.text('Forbidden', 403);
    return next();
  }
  if (api) {
    const principal = authenticateRequest(c);
    if (!principal) {
      const expired = expiredDevices.get(c.req.raw);
      if (expired) {
        audit('device.expired', { who: expired.name, ip: origin.clientIp });
        return c.json({ error: `This device wasn't used for ${readRemoteSettings().idleDays} days, so it was signed out. Sign in again; the owner approves it once more.`, expired: true }, 401);
      }
      return c.json({ error: 'Unauthorized' }, 401);
    }
    // Cookies ride along with any request the browser makes; a change needs a same-site page.
    if (principal.kind === 'session' && principal.via === 'cookie' && !SAFE_METHODS.has(c.req.method) && crossSite(c)) {
      return c.json({ error: 'Cross-site request refused' }, 403);
    }
    if (principal.kind === 'device') {
      try {
        const fresh = noteDeviceSeen(principal.deviceId, origin.clientIpKnown ? origin.clientIp : null, c.req.header('user-agent') ?? null);
        if (fresh && origin.clientIpKnown) {
          audit('device.new-location', { who: principal.deviceName, ip: origin.clientIp });
          newLocationHook?.({ id: principal.deviceId, name: principal.deviceName }, origin.clientIp);
        }
      } catch { /* bookkeeping only */ }
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
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message, path: new URL(c.req.url).pathname }, 'Web request failed');
    // The detail stays in the log: error text can name files, keys and internals.
    if (c.req.url.includes('/api/')) return c.json({ error: 'Internal server error' }, 500);
    return c.html('<h1>500 — Internal Server Error</h1>', 500);
  }
}
