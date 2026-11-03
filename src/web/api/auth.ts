import { Hono } from 'hono';
import { isBunVirtualPath } from '../../utils/bun-path.js';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import process from 'node:process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { authenticateAsync, createSession, destroySession, destroyAllSessions, changePassword, changeUsername, getSessionCookieName, getSessionMaxAge, sessionKey } from '../auth.js';
import { createDevice, getDevice, listDevices, revokeAllDevices, revokeDevice } from '../devices.js';
import { authenticateRequest, bearerToken, isThisComputer, originOf, principalLabel } from '../middleware.js';
import { apiContract } from '../api-contract.js';
import { createLoginLimiter } from '../login-limiter.js';
import { requireOwner, whereToApprove } from '../owner-gate.js';
import { ownerApprovals } from '../../security/owner-approvals.js';
import { audit } from '../../security/audit.js';
import { closeStreams } from '../../security/live-streams.js';

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
<form method="POST" action="/api/auth/login">
<label for="u">Username</label><input id="u" name="username" autocomplete="username" required>
<label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required>
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

auth.post('/api/auth/login', async (c) => {
  const key = limiterKey(c);
  const wait = signInLimiter.retryAfterSeconds(key);
  if (wait > 0) {
    c.header('Retry-After', String(wait));
    return c.html(renderLoginPage(`Too many failed attempts. Try again in ${Math.ceil(wait / 60)} minutes.`), 429);
  }
  const body = await c.req.parseBody();
  const username = (body.username as string) || '';
  const password = (body.password as string) || '';

  if (!username || !password) {
    return c.html(renderLoginPage('Please enter both username and password'), 400);
  }

  if (!(await authenticateAsync(username, password))) {
    signInLimiter.recordFailure(key);
    audit('login.failed', { who: 'browser', ip: originOf(c).clientIp });
    return c.html(renderLoginPage('Invalid username or password'), 401);
  }
  signInLimiter.reset(key);

  const token = createSession();
  setCookie(c, getSessionCookieName(), token, {
    httpOnly: true,
    secure: overHttps(c),
    sameSite: 'Strict',
    maxAge: getSessionMaxAge(),
    path: '/',
  });

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
  return c.redirect('/login');
});

// ── Device tokens (Mercury Desktop, phones, scripts) ──────────────────────
//
// POST /api/auth/token  { username, password, deviceName?, platform? }
//   On this computer → 200 { token, device, apiVersion, features, version? }
//   From anywhere else → 202 { pending, pairingId, pollToken, code, where, expiresAt }:
//     the owner approves the new device (their messaging channel, the CLI,
//     Mercury Desktop here); the client asks POST /api/auth/token/pending
//     { pairingId, pollToken } until it gets the token (or "denied"/"expired").
//   → 401 bad credentials · 429 too many failures · 409 device limit
//
// The token is the only credential the client keeps; the password is never
// stored on the device.

const PAIRING_TTL_MS = 10 * 60_000;

interface PendingPairing {
  approvalId: string;
  pollHash: string;
  deviceName: unknown;
  platform: unknown;
  ip?: string;
  /** Who asked (the sign-in limiter's key), so one client can't pile up questions. */
  client: string;
  /** Set once the token was handed out: a second poll can't mint another. */
  done?: boolean;
}

const pairings = new Map<string, PendingPairing>();
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

function sameSecret(presented: string, hash: string): boolean {
  const a = Buffer.from(sha(presented), 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

auth.post('/api/auth/token', async (c) => {
  const key = limiterKey(c);
  const wait = signInLimiter.retryAfterSeconds(key);
  if (wait > 0) {
    c.header('Retry-After', String(wait));
    return c.json({ error: 'Too many failed sign-in attempts; try again later' }, 429);
  }
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Expected a JSON body' }, 400);
  }
  const username = typeof body.username === 'string' ? body.username : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!username || !password) {
    return c.json({ error: 'Username and password required' }, 400);
  }
  const origin = originOf(c);
  if (!(await authenticateAsync(username, password))) {
    signInLimiter.recordFailure(key);
    audit('login.failed', { who: typeof body.deviceName === 'string' ? body.deviceName.slice(0, 64) : 'a device', ip: origin.clientIp });
    if (signInLimiter.retryAfterSeconds(key) > 0) audit('login.locked', { ip: origin.clientIp });
    return c.json({ error: 'Invalid username or password' }, 401);
  }
  signInLimiter.reset(key);

  // On this computer the owner is right here: no one to ask.
  if (origin.local) {
    try {
      const created = createDevice(body.deviceName, body.platform, 'this computer');
      audit('pair.local', { who: created.device.name });
      return c.json({ token: created.token, device: created.device, ...apiContract() });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Could not create device' }, 409);
    }
  }

  // One waiting sign-in per client at a time: asking again doesn't message the owner again.
  const waitingHere = [...pairings.values()].filter((p) => !p.done && p.client === key && ownerApprovals().get(p.approvalId)?.status === 'pending');
  if (waitingHere.length >= 2) return c.json({ error: 'A sign-in from here is already waiting for the owner. Wait for their answer.' }, 429);
  // Check the limit now, not after the owner said yes.
  if (listDevices().length >= (await import('../../security/remote-settings.js')).readRemoteSettings().maxDevices) {
    return c.json({ error: 'This Mercury has reached its device limit. Revoke a device, or raise the limit with /server.' }, 409);
  }
  const name = String(body.deviceName ?? 'A new device').replace(/[^\P{C}]/gu, '').trim().slice(0, 64) || 'A new device';
  const platform = typeof body.platform === 'string' ? body.platform.replace(/[^a-z0-9-]/gi, '').slice(0, 24) : '';
  const ip = origin.clientIpKnown ? origin.clientIp : undefined;
  const approval = ownerApprovals().request({
    kind: 'pair',
    title: `New device: ${name}`,
    detail: [platform && `on ${platform}`, ip && `from ${ip}`].filter(Boolean).join(', ') || undefined,
    who: name,
    ip,
  }, PAIRING_TTL_MS);
  const pairingId = randomBytes(12).toString('base64url');
  const pollToken = randomBytes(24).toString('base64url');
  pairings.set(pairingId, { approvalId: approval.id, pollHash: sha(pollToken), deviceName: body.deviceName, platform: body.platform, ip, client: key });
  const timer = setTimeout(() => pairings.delete(pairingId), PAIRING_TTL_MS + 5 * 60_000);
  timer.unref?.();
  audit('pair.requested', { who: name, ip });
  return c.json({
    pending: true,
    pairingId,
    pollToken,
    code: approval.code,
    where: whereToApprove(),
    expiresAt: approval.expiresAt,
    message: `Approve this device on ${whereToApprove()}. Code: ${approval.code}`,
  }, 202);
});

/** A pairing waiting for the owner: answers within ~25 s if it's decided meanwhile. */
auth.post('/api/auth/token/pending', async (c) => {
  let body: Record<string, unknown>;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Expected a JSON body' }, 400); }
  const pairingId = typeof body.pairingId === 'string' ? body.pairingId : '';
  const pollToken = typeof body.pollToken === 'string' ? body.pollToken : '';
  const p = pairings.get(pairingId);
  if (!p || !pollToken || !sameSecret(pollToken, p.pollHash)) return c.json({ status: 'expired', error: 'This sign-in request is no longer waiting. Sign in again.' }, 404);
  if (p.done) return c.json({ status: 'expired', error: 'This sign-in request was already completed.' }, 410);
  const approvals = ownerApprovals();
  let status = approvals.get(p.approvalId)?.status ?? 'expired';
  if (status === 'pending') {
    status = await Promise.race([
      approvals.wait(p.approvalId),
      new Promise<'pending'>((r) => { const t = setTimeout(() => r('pending'), Math.min(25_000, Number(body.waitMs) || 25_000)); t.unref?.(); }),
    ]);
  }
  if (status === 'pending') return c.json({ status: 'pending', code: approvals.get(p.approvalId)?.code });
  if (status !== 'allowed') {
    pairings.delete(pairingId);
    return c.json({ status, error: status === 'denied' ? 'The owner did not approve this device.' : 'Nobody approved this device in time. Sign in again to ask again.' }, 403);
  }
  p.done = true;
  pairings.delete(pairingId);
  const decidedBy = approvals.get(p.approvalId)?.decidedBy ?? 'owner';
  try {
    const created = createDevice(p.deviceName, p.platform, decidedBy);
    audit('pair.approved', { who: created.device.name, ip: p.ip, by: decidedBy });
    return c.json({ status: 'approved', token: created.token, device: created.device, ...apiContract() });
  } catch (err) {
    return c.json({ status: 'error', error: err instanceof Error ? err.message : 'Could not create device' }, 409);
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

/**
 * Change the password. Every other browser is signed out (a changed password
 * means the old one may be known); `signOutDevices: true` revokes every
 * device token too. From a remote device it also needs the owner's approval.
 */
auth.post('/api/auth/password', async (c) => {
  const body = await c.req.json().catch(() => ({})) as { currentPassword?: string; newPassword?: string; signOutDevices?: boolean };
  const { currentPassword, newPassword } = body;
  if (!currentPassword || !newPassword) {
    return c.json({ error: 'Current and new password required' }, 400);
  }
  if (newPassword.length < 10) return c.json({ error: 'Use at least 10 characters for the new password.' }, 400);
  const wait = requireOwner(c, { id: 'auth.password', title: 'Change the Mercury password' });
  if (wait) return wait;
  const ok = changePassword(currentPassword, newPassword);
  if (!ok) return c.json({ error: 'Current password is incorrect' }, 403);
  const keep = bearerToken(c) || getCookie(c, getSessionCookieName()) || undefined;
  for (const k of destroyAllSessions(keep)) closeStreams(`session:${k}`);
  let devicesSignedOut = 0;
  if (body.signOutDevices === true) {
    const ids = revokeAllDevices();
    for (const id of ids) closeStreams(`device:${id}`);
    devicesSignedOut = ids.length;
  }
  audit('password.changed', { by: isThisComputer(c) ? 'this computer' : principalLabel(authenticateRequest(c)), detail: devicesSignedOut ? `${devicesSignedOut} devices signed out` : undefined });
  return c.json({ success: true, devicesSignedOut });
});

auth.post('/api/auth/username', async (c) => {
  const body = await c.req.json().catch(() => ({})) as { currentPassword?: string; newUsername?: string };
  const { currentPassword, newUsername } = body;
  if (!currentPassword || !newUsername) {
    return c.json({ error: 'Current password and new username required' }, 400);
  }
  const wait = requireOwner(c, { id: 'auth.username', title: 'Change the Mercury username' });
  if (wait) return wait;
  const ok = changeUsername(currentPassword, newUsername);
  if (!ok) return c.json({ error: 'Current password is incorrect' }, 403);
  return c.json({ success: true });
});

export default auth;