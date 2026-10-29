import { Hono } from 'hono';
import { isBunVirtualPath } from '../../utils/bun-path.js';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import process from 'node:process';
import { authenticate, createSession, destroySession, changePassword, changeUsername, getSessionCookieName, getSessionMaxAge } from '../auth.js';
import { createDevice, listDevices, revokeDevice } from '../devices.js';
import { authenticateRequest, bearerToken } from '../middleware.js';
import { apiContract } from '../api-contract.js';
import { createLoginLimiter } from '../login-limiter.js';

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

auth.post('/api/auth/login', async (c) => {
  const body = await c.req.parseBody();
  const username = (body.username as string) || '';
  const password = (body.password as string) || '';

  if (!username || !password) {
    return c.html(renderLoginPage('Please enter both username and password'), 400);
  }

  if (!authenticate(username, password)) {
    return c.html(renderLoginPage('Invalid username or password'), 401);
  }

  const token = createSession();
  setCookie(c, getSessionCookieName(), token, {
    httpOnly: true,
    secure: false,
    sameSite: 'Strict',
    maxAge: getSessionMaxAge(),
    path: '/',
  });

  return c.redirect('/');
});

auth.get('/api/auth/logout', (c) => {
  const token = getCookie(c, getSessionCookieName());
  if (token) destroySession(token);
  setCookie(c, getSessionCookieName(), '', {
    httpOnly: true,
    secure: false,
    sameSite: 'Strict',
    maxAge: 0,
    path: '/',
  });
  return c.redirect('/login');
});

// ── Device tokens (Mercury Desktop, phones, scripts) ──────────────────────
//
// POST /api/auth/token  { username, password, deviceName?, platform? }
//   → 200 { token, device, apiVersion, features, version? }
//   → 401 bad credentials · 429 too many failures from this address
//
// The token is the only credential the client keeps; the password is never
// stored on the device. Same bcrypt check as the web login, plus a small
// per-address failure limiter because this endpoint is reachable without a
// browser and will be pointed at from the internet through tunnels.

const tokenLimiter = createLoginLimiter();

function peerAddress(c: { env?: unknown }): string {
  try {
    return String((c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress || 'unknown');
  } catch {
    return 'unknown';
  }
}

auth.post('/api/auth/token', async (c) => {
  const peer = peerAddress(c);
  const wait = tokenLimiter.retryAfterSeconds(peer);
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
  if (!authenticate(username, password)) {
    tokenLimiter.recordFailure(peer);
    return c.json({ error: 'Invalid username or password' }, 401);
  }
  tokenLimiter.reset(peer);
  let created;
  try {
    created = createDevice(body.deviceName, body.platform);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Could not create device' }, 409);
  }
  return c.json({ token: created.token, device: created.device, ...apiContract() });
});

auth.get('/api/auth/devices', (c) => {
  const principal = authenticateRequest(c);
  return c.json({
    devices: listDevices(),
    current: principal?.kind === 'device' ? principal.deviceId : null,
  });
});

auth.delete('/api/auth/devices/:id', (c) => {
  const id = c.req.param('id');
  if (!/^[0-9a-f]{8}$/.test(id)) return c.json({ error: 'Bad device id' }, 400);
  return revokeDevice(id) ? c.json({ success: true }) : c.json({ error: 'No such device' }, 404);
});

/** Sign out this device: revoke the token that made the call. */
auth.post('/api/auth/token/revoke', (c) => {
  const principal = authenticateRequest(c);
  if (principal?.kind !== 'device') return c.json({ error: 'Not a device token' }, 400);
  revokeDevice(principal.deviceId);
  return c.json({ success: true });
});

// Sessions obtained with a Bearer header (scripts, or a desktop client on
// the web-session path) end here instead of through the cookie redirect.
auth.post('/api/auth/logout', (c) => {
  const token = bearerToken(c) || getCookie(c, getSessionCookieName());
  if (token) destroySession(token);
  return c.json({ success: true });
});

auth.post('/api/auth/password', async (c) => {
  const body = await c.req.json();
  const { currentPassword, newPassword } = body;
  if (!currentPassword || !newPassword) {
    return c.json({ error: 'Current and new password required' }, 400);
  }
  const ok = changePassword(currentPassword, newPassword);
  if (!ok) return c.json({ error: 'Current password is incorrect' }, 403);
  return c.json({ success: true });
});

auth.post('/api/auth/username', async (c) => {
  const body = await c.req.json();
  const { currentPassword, newUsername } = body;
  if (!currentPassword || !newUsername) {
    return c.json({ error: 'Current password and new username required' }, 400);
  }
  const ok = changeUsername(currentPassword, newUsername);
  if (!ok) return c.json({ error: 'Current password is incorrect' }, 403);
  return c.json({ success: true });
});

export default auth;