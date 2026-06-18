import { Hono } from 'hono';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import process from 'node:process';
import { authenticate, createSession, destroySession, changePassword, changeUsername, getSessionCookieName, getSessionMaxAge } from '../auth.js';

function resolveWebDir(...segments: string[]): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  if (typeof (process.versions as any).bun === 'string' && __dirname.includes('$bunfs')) {
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