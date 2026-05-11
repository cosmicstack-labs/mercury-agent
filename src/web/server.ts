import { Hono } from 'hono';
import { createAdaptorServer } from '@hono/node-server';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authGuard, errorHandler } from './middleware.js';
import { initWebAuth, getWebPort, loadWebAuth } from './auth.js';
import authRoutes from './api/auth.js';
import statusRoutes, { updateStatus } from './api/status.js';
import providerRoutes from './api/providers.js';
import configRoutes from './api/config.js';
import systemRoutes, { setScheduler } from './api/system.js';
import brainRoutes, { setUserMemory } from './api/brain.js';
import chatRoutes, { setWebChannel } from './api/chat.js';
import { renderDashboard } from './pages/dashboard.js';
import { renderProviders } from './pages/providers.js';
import { renderSettings } from './pages/settings.js';
import { renderSkills } from './pages/skills.js';
import { renderPermissions } from './pages/permissions.js';
import { renderUsage } from './pages/usage.js';
import { renderSchedules } from './pages/schedules.js';
import { renderMemory } from './pages/brain/memory.js';
import { renderPersons } from './pages/brain/persons.js';
import { renderPerson } from './pages/brain/person.js';
import { renderGoals } from './pages/brain/goals.js';
import { renderGraph } from './pages/brain/graph.js';
import { renderChat } from './pages/chat.js';
import { loadConfig } from '../utils/config.js';
import { isBetterSqlite3Available } from '../memory/second-brain-db.js';

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
  wasm: 'application/wasm',
};

app.use('*', errorHandler);
app.use('*', authGuard);

app.route('/', authRoutes);
app.route('/', statusRoutes);
app.route('/', providerRoutes);
app.route('/', configRoutes);
app.route('/', systemRoutes);
app.route('/', brainRoutes);
app.route('/', chatRoutes);

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

app.get('/skills', (c) => {
  return c.html(renderSkills(c));
});

app.get('/permissions', (c) => {
  return c.html(renderPermissions(c));
});

app.get('/usage', (c) => {
  return c.html(renderUsage(c));
});

app.get('/schedules', (c) => {
  return c.html(renderSchedules(c));
});

app.get('/second-brain/graph', (c) => {
  return c.html(renderGraph(c));
});

app.get('/second-brain/memory', (c) => {
  return c.html(renderMemory(c, {}));
});

app.get('/second-brain/persons', (c) => {
  return c.html(renderPersons(c));
});

app.get('/second-brain/persons/:id', (c) => {
  const id = c.req.param('id');
  return c.html(renderPerson(c, id));
});

app.get('/second-brain/goals', (c) => {
  return c.html(renderGoals(c));
});

app.get('/chat', (c) => {
  return c.html(renderChat(c));
});

export { updateStatus, setUserMemory, setWebChannel, setScheduler };

export function startWebServer(): { port: number; url: string } {
  const port = getWebPort();
  initWebAuth();

  const server = createAdaptorServer({ fetch: app.fetch });

  server.on('error', (err: any) => {
    if (err?.code === 'EADDRINUSE') {
      console.log(`\n  ☿ Port ${port} is already in use. Web dashboard unavailable.`);
      console.log(`  Change the port with MERCURY_PORT or in mercury.yaml web.port.`);
    } else {
      console.error('Web server error:', err.message);
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`\n  ☿ Web dashboard: http://127.0.0.1:${port}`);
    console.log(`  Default login: mercury / Mercury@123\n`);
  });

  return { port, url: `http://127.0.0.1:${port}` };
}
