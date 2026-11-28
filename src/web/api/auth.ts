import { Hono, type Context } from 'hono';
import { isBunVirtualPath } from '../../utils/bun-path.js';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import process from 'node:process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createSession, destroySession, getSessionCookieName, getSessionMaxAge, sessionKey } from '../auth.js';
import { checkDeviceToken, createDevice, getDevice, listDevices, looksLikeDeviceToken, normalizeDeviceName, revokeDevice } from '../devices.js';
import { DEVICE_COOKIE, authenticateRequest, bearerToken, originOf, principalLabel } from '../middleware.js';
import { browserLinks } from '../../security/browser-links.js';
import { apiContract } from '../api-contract.js';
import { createLoginLimiter } from '../login-limiter.js';
import { requireOwner, whereToApprove } from '../owner-gate.js';
import { ownerApprovals } from '../../security/owner-approvals.js';
import { audit } from '../../security/audit.js';
import { closeStreams } from '../../security/live-streams.js';
import { pairCodes } from '../../security/pair-codes.js';
import { readRemoteSettings } from '../../security/remote-settings.js';

/**
 * Mercury has no password (ADR-050). Devices connect with a pairing code
 * (POST /api/auth/pair) or a device token made on this computer; a browser
 * here opens with a one-time link (mercury web); a browser elsewhere signs
 * in with a device token. The old password endpoints answer 410.
 */
export const NO_PASSWORD = 'Mercury no longer signs in with a password. On the computer Mercury runs on, type /server pair and scan the QR code, or make a device token with /server token <device name>.';
const gone = (c: Context) => c.json({ error: NO_PASSWORD, code: 'password_removed' }, 410);

function resolveWebDir(...segments: string[]): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  // Standalone binary (macOS/Linux `$bunfs`, Windows `~BUN`): assets sit next to the executable.
  if (isBunVirtualPath(__dirname)) {
    return join(dirname(process.execPath), ...segments);
  }
  return join(__dirname, ...segments);
}

const spaLoginIndex = resolveWebDir('web', 'ui', 'index.html');

function renderLoginPage(error?: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mercury — Login</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,sans-serif;background:#0a0a0a;color:#e5e5e5;display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:#141414;border:1px solid #262626;border-radius:12px;padding:2rem;width:100%;max-width:380px}
h1{font-size:1.5rem;margin-bottom:.25rem;color:#00d4ff}
p.sub{font-size:.875rem;color:#737373;margin-bottom:1.5rem}
label{display:block;font-size:.8rem;color:#a3a3a3;margin-bottom:.25rem}
input{width:100%;padding:.6rem .75rem;border:1px solid #262626;border-radius:8px;background:#0a0a0a;color:#e5e5e5;font-size:.875rem;margin-bottom:1rem}
input:focus{outline:none;border-color:#00d4ff}
button{width:100%;padding:.65rem;border:none;border-radius:8px;background:#00d4ff;color:#000;font-weight:600;font-size:.875rem;cursor:pointer}
button:hover{background:#00bfe6}
.err{color:#ef4444;font-size:.8rem;margin-bottom:1rem}
</style></head><body>
<div class="card">
<h1>Mercury</h1><p class="sub">Sign in to continue</p>
${error ? `<div class="err">${error}</div>` : ''}
<p class="sub">On the computer Mercury runs on, run <code>mercury web</code> to open the dashboard. From another device, paste a device token (make one there with <code>/server token &lt;name&gt;</code>).</p>
<form method="POST" action="/api/auth/login">
<label for="t">Device token</label><input id="t" name="token" type="password" autocomplete="off" spellcheck="false" placeholder="mdt_…" required>
<button type="submit">Sign in</button>
</form></div></body></html>`;
}

const auth = new Hono();

auth.get('/login', (c) => {
  if (existsSync(spaLoginIndex)) {
    return new Response(readFileSync(spaLoginIndex), {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      },
    });
  }
  return c.html(renderLoginPage());
});

// Sign-in attempts are limited per client: per address when the tunnel says
// who it is, one shared allowance for unknown remote clients, and never
// against someone on this computer (so nobody online can lock the owner out
// of their own machine).
const signInLimiter = createLoginLimiter();

function limiterKey(c: Parameters<typeof originOf>[0]): string {
  const o = originOf(c);
  if (o.local) return 'this-computer';
  return o.clientIpKnown ? `ip:${o.clientIp}` : 'remote-unknown';
}

/** Secure cookies over https (directly or through a tunnel that says so). */
function overHttps(c: Parameters<typeof originOf>[0]): boolean {
  try {
    return new URL(c.req.url).protocol === 'https:' || (c.req.header('x-forwarded-proto') ?? '').split(',')[0].trim() === 'https';
  } catch {
    return false;
  }
}

/** A browser signs in with a device token; the token becomes its cookie (revoking the device signs it out). */
auth.post('/api/auth/login', async (c) => {
  const json = (c.req.header('content-type') ?? '').includes('application/json');
  const fail = (status: 400 | 401 | 429, message: string) => (json ? c.json({ error: message }, status) : c.html(renderLoginPage(message), status));
  const key = limiterKey(c);
  const wait = signInLimiter.retryAfterSeconds(key);
  if (wait > 0) {
    c.header('Retry-After', String(wait));
    return fail(429, `Too many wrong tokens. Try again in ${Math.ceil(wait / 60)} minutes.`);
  }
  let token = '';
  try {
    const body = json ? ((await c.req.json()) as Record<string, unknown>) : await c.req.parseBody();
    token = typeof body.token === 'string' ? body.token.trim() : '';
  } catch {
    return fail(400, 'Expected a device token');
  }
  if (!token) return fail(400, 'Paste a device token');
  const origin = originOf(c);
  const r = looksLikeDeviceToken(token) ? checkDeviceToken(token) : null;
  if (!r?.ok) {
    signInLimiter.recordFailure(key);
    audit('login.failed', { who: 'browser', ip: origin.clientIp, detail: 'wrong device token' });
    if (signInLimiter.retryAfterSeconds(key) > 0) audit('login.locked', { ip: origin.clientIp });
    return fail(401, r?.expired ? 'This device token expired because it was not used. Make a new one with /server token <name>.' : "That device token isn't valid. Make one on the computer Mercury runs on with /server token <name>.");
  }
  signInLimiter.reset(key);
  setCookie(c, DEVICE_COOKIE, token, { httpOnly: true, secure: overHttps(c), sameSite: 'Strict', maxAge: getSessionMaxAge(), path: '/' });
  audit('device.new-location', { who: r.device.name, ip: origin.clientIpKnown ? origin.clientIp : undefined, detail: 'signed in a browser' });
  return json ? c.json({ ok: true, device: r.device }) : c.redirect('/');
});

/** The one-time link `mercury web` opens: this computer only, once, for 5 minutes. */
auth.get('/login/once', (c) => {
  const code = c.req.query('c') ?? '';
  if (!originOf(c).local) return c.html(renderLoginPage('A sign-in link works only on the computer Mercury runs on.'), 403);
  if (!browserLinks().redeem(code)) return c.html(renderLoginPage('This sign-in link was already used or has expired. Run mercury web again.'), 401);
  const token = createSession();
  setCookie(c, getSessionCookieName(), token, { httpOnly: true, secure: overHttps(c), sameSite: 'Lax', maxAge: getSessionMaxAge(), path: '/' });
  audit('pair.local', { who: 'a browser on this computer', detail: 'one-time link' });
  return c.redirect('/');
});

auth.get('/api/auth/logout', (c) => {
  const token = getCookie(c, getSessionCookieName());
  if (token) { destroySession(token); closeStreams(`session:${sessionKey(token)}`); }
  setCookie(c, getSessionCookieName(), '', {
    httpOnly: true,
    secure: overHttps(c),
    sameSite: 'Strict',
    maxAge: 0,
    path: '/',
  });
  setCookie(c, DEVICE_COOKIE, '', { httpOnly: true, secure: overHttps(c), sameSite: 'Strict', maxAge: 0, path: '/' });
  return c.redirect('/login');
});

// ── Device tokens ─────────────────────────────────────────────────────────
// Made on this computer (/server token, mercury devices add) or by pairing
// with a code (POST /api/auth/pair). Exchanging a password for a token is gone.
auth.post('/api/auth/token', (c) => gone(c));
auth.post('/api/auth/token/pending', (c) => gone(c));

const pairLimiter = createLoginLimiter();
const PAIR_CODE_REFUSED = "This pairing code isn't valid. Make a new one on the computer Mercury runs on.";

auth.post('/api/auth/pair', async (c) => {
  const key = limiterKey(c);
  const wait = pairLimiter.retryAfterSeconds(key);
  if (wait > 0) {
    c.header('Retry-After', String(wait));
    return c.json({ error: 'Too many wrong pairing codes; try again later' }, 429);
  }
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Expected a JSON body' }, 400);
  }
  const code = typeof body.code === 'string' ? body.code : '';
  if (!code) return c.json({ error: 'A pairing code is required' }, 400);
  const origin = originOf(c);
  const codes = pairCodes();
  const found = codes.match(code);
  if (!found) {
    pairLimiter.recordFailure(key);
    audit('login.failed', { who: normalizeDeviceName(body.deviceName), ip: origin.clientIp, detail: 'wrong pairing code' });
    if (pairLimiter.retryAfterSeconds(key) > 0) audit('login.locked', { ip: origin.clientIp });
    return c.json({ error: PAIR_CODE_REFUSED }, 401);
  }
  pairLimiter.reset(key);
  try {
    const created = createDevice(body.deviceName, body.platform, found.by);
    codes.redeemed(found.id, { name: created.device.name, platform: created.device.platform }, origin.clientIpKnown ? origin.clientIp : undefined);
    return c.json({ token: created.token, device: created.device, ...apiContract() });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Could not create device' }, 409);
  }
});

auth.get('/api/auth/devices', (c) => {
  const principal = authenticateRequest(c);
  return c.json({
    devices: listDevices(),
    current: principal?.kind === 'device' ? principal.deviceId : null,
  });
});

/** Revoke a device: its own token always; another device from this computer, or with the owner's approval. */
auth.delete('/api/auth/devices/:id', (c) => {
  const id = c.req.param('id');
  if (!/^[0-9a-f]{8}$/.test(id)) return c.json({ error: 'Bad device id' }, 400);
  const principal = authenticateRequest(c);
  const self = principal?.kind === 'device' && principal.deviceId === id;
  if (!self) {
    const target = getDevice(id);
    const wait = requireOwner(c, { id: `device.revoke:${id}`, title: `Sign out the device “${target?.name ?? id}”` });
    if (wait) return wait;
  }
  const name = getDevice(id)?.name ?? id;
  if (!revokeDevice(id)) return c.json({ error: 'No such device' }, 404);
  closeStreams(`device:${id}`);
  audit('device.revoked', { who: name, by: self ? 'itself' : principalLabel(principal) });
  return c.json({ success: true });
});

/** Sign out this device: revoke the token that made the call. */
auth.post('/api/auth/token/revoke', (c) => {
  const principal = authenticateRequest(c);
  if (principal?.kind !== 'device') return c.json({ error: 'Not a device token' }, 400);
  revokeDevice(principal.deviceId);
  closeStreams(`device:${principal.deviceId}`);
  audit('device.revoked', { who: principal.deviceName, by: 'itself' });
  return c.json({ success: true });
});

// Sessions obtained with a Bearer header (scripts, or a desktop client on
// the web-session path) end here instead of through the cookie redirect.
auth.post('/api/auth/logout', (c) => {
  const token = bearerToken(c) || getCookie(c, getSessionCookieName());
  if (token) { destroySession(token); closeStreams(`session:${sessionKey(token)}`); }
  return c.json({ success: true });
});

auth.post('/api/auth/password', (c) => gone(c));
auth.post('/api/auth/username', (c) => gone(c));

export default auth;