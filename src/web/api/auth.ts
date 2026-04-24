import { Hono } from 'hono';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';
import { authenticate, createSession, destroySession, changePassword, changeUsername, getSessionCookieName, getSessionMaxAge } from '../auth.js';
import { renderLoginPage } from '../pages/login.js';

const auth = new Hono();

auth.get('/login', (c) => {
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
  deleteCookie(c, getSessionCookieName(), { path: '/' });
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