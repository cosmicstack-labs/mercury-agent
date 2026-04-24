import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authGuard, errorHandler } from './middleware.js';
import { initWebAuth, getWebPort, loadWebAuth } from './auth.js';
import authRoutes from './api/auth.js';
import statusRoutes, { updateStatus } from './api/status.js';
import providerRoutes from './api/providers.js';
import configRoutes from './api/config.js';
import { renderDashboard } from './pages/dashboard.js';
import { renderProviders } from './pages/providers.js';
import { renderSettings } from './pages/settings.js';
import { loadConfig } from '../utils/config.js';

const app = new Hono();

const __dirname = dirname(fileURLToPath(import.meta.url));
const staticDir = process.env.MERCURY_WEB_STATIC || join(__dirname, 'web', 'static');

const MIME_TYPES: Record<string, string> = {
  css: 'text/css',
  js: 'application/javascript',
  png: 'image/png',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  woff2: 'font/woff2',
  html: 'text/html',
  json: 'application/json',
};

app.use('*', errorHandler);
app.use('*', authGuard);

app.route('/', authRoutes);
app.route('/', statusRoutes);
app.route('/', providerRoutes);
app.route('/', configRoutes);

app.get('/static/style.css', (c) => {
  const filePath = join(staticDir, 'style.css');
  if (existsSync(filePath)) {
    return new Response(readFileSync(filePath), {
      headers: { 'Content-Type': 'text/css' },
    });
  }
  return c.notFound();
});

app.get('/static/app.js', (c) => {
  const filePath = join(staticDir, 'app.js');
  if (existsSync(filePath)) {
    return new Response(readFileSync(filePath), {
      headers: { 'Content-Type': 'application/javascript' },
    });
  }
  return c.notFound();
});

app.get('/vendor/*', (c) => {
  const filename = c.req.path.split('/').pop() || '';
  const filePath = join(staticDir, 'vendor', filename);
  if (existsSync(filePath)) {
    const ext = filename.split('.').pop() || '';
    return new Response(readFileSync(filePath), {
      headers: { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' },
    });
  }
  return c.notFound();
});

app.get('/', (c) => {
  return c.html(renderDashboard(c, {}));
});

app.get('/providers', (c) => {
  const config = loadConfig();
  const list = Object.entries(config.providers)
    .filter(([k]) => k !== 'default')
    .map(([name, p]: [string, any]) => ({
      name: p.name || name,
      maskedKey: p.apiKey ? p.apiKey.slice(0, 4) + '••••' + p.apiKey.slice(-4) : '',
      baseUrl: p.baseUrl,
      model: p.model,
      enabled: p.enabled,
      hasKey: !!p.apiKey,
    }));
  return c.html(renderProviders(c, list));
});

app.get('/settings', (c) => {
  const config = loadConfig();
  const auth = loadWebAuth();
  return c.html(renderSettings(c, config, auth?.username || 'mercury'));
});

export { updateStatus };

export function startWebServer(): { port: number; url: string } {
  const port = getWebPort();
  initWebAuth();

  serve({
    fetch: app.fetch,
    port,
    hostname: '127.0.0.1',
  });

  console.log(`\n  ☿ Web dashboard: http://127.0.0.1:${port}`);
  console.log(`  Default login: mercury / Mercury@123\n`);

  return { port, url: `http://127.0.0.1:${port}` };
}