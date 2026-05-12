import { Hono } from 'hono';
import { createAdaptorServer } from '@hono/node-server';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../utils/logger.js';
import { authGuard, errorHandler } from './middleware.js';
import { initWebAuth, getWebPort, loadWebAuth } from './auth.js';
import authRoutes from './api/auth.js';
import statusRoutes, { updateStatus } from './api/status.js';
import providerRoutes from './api/providers.js';
import configRoutes from './api/config.js';
import systemRoutes, { setScheduler } from './api/system.js';
import brainRoutes, { setUserMemory } from './api/brain.js';
import chatRoutes, { setWebChannel, setProgrammingMode, setModelSwitchCallback, setCurrentProviderCallback } from './api/chat.js';
import agentRoutes, { setAgentSupervisor, setBackgroundTaskManager } from './api/agents.js';
import spotifyRoutes, { setSpotifyClient } from './api/spotify.js';
import kanbanRoutes, { setKanbanSupervisor, setKanbanBoardManager, setKanbanProviders } from './api/kanban.js';
import { BoardManager } from '../core/board-manager.js';
import { loadConfig } from '../utils/config.js';
import { isBetterSqlite3Available } from '../memory/second-brain-db.js';

const app = new Hono();

const __dirname = dirname(fileURLToPath(import.meta.url));
const staticDir = process.env.MERCURY_WEB_STATIC || join(__dirname, 'web', 'static');
const uiDir = process.env.MERCURY_UI_DIR || join(__dirname, 'web', 'ui');

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
  webmanifest: 'application/manifest+json',
  map: 'application/json',
};

// Check if the React SPA build exists
const spaIndexPath = join(uiDir, 'index.html');
const spaAvailable = existsSync(spaIndexPath);

app.use('*', errorHandler);
app.use('*', authGuard);

// ── API routes (always available) ──
app.route('/', authRoutes);
app.route('/', statusRoutes);
app.route('/', providerRoutes);
app.route('/', configRoutes);
app.route('/', systemRoutes);
app.route('/', brainRoutes);
app.route('/', chatRoutes);
app.route('/', agentRoutes);
app.route('/', spotifyRoutes);
app.route('/', kanbanRoutes);

// ── Legacy static assets (vendor fonts, icons, wasm — still needed by React SPA) ──
app.get('/vendor/*', (c) => {
  const subPath = c.req.path.slice('/vendor/'.length);
  if (!subPath || subPath.includes('..')) return c.notFound();
  const filePath = join(staticDir, 'vendor', subPath);
  if (existsSync(filePath)) {
    const ext = subPath.split('.').pop() || '';
    return new Response(readFileSync(filePath), {
      headers: { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' },
    });
  }
  return c.notFound();
});

if (spaAvailable) {
  // ═══════════════════════════════════════════════════════════════
  // React SPA mode — serve Vite build output
  // ═══════════════════════════════════════════════════════════════

  // Serve static assets from the SPA build (JS, CSS, etc.)
  app.get('/assets/*', (c) => {
    const subPath = c.req.path.slice('/assets/'.length);
    if (!subPath || subPath.includes('..')) return c.notFound();
    const filePath = join(uiDir, 'assets', subPath);
    if (existsSync(filePath)) {
      const ext = subPath.split('.').pop() || '';
      return new Response(readFileSync(filePath), {
        headers: {
          'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      });
    }
    return c.notFound();
  });

  // Serve top-level SPA files (favicon, manifest, service worker, etc.)
  const SPA_TOP_LEVEL_FILES = ['favicon.svg', 'favicon.ico', 'manifest.webmanifest', 'registerSW.js', 'sw.js', 'sw.js.map', 'robots.txt'];

  // Also pick up workbox files dynamically
  try {
    const uiFiles = readdirSync(uiDir);
    for (const f of uiFiles) {
      if (f.startsWith('workbox-') && !SPA_TOP_LEVEL_FILES.includes(f)) {
        SPA_TOP_LEVEL_FILES.push(f);
      }
    }
  } catch {}

  for (const fileName of SPA_TOP_LEVEL_FILES) {
    app.get(`/${fileName}`, (c) => {
      const filePath = join(uiDir, fileName);
      if (existsSync(filePath)) {
        const ext = fileName.split('.').pop() || '';
        return new Response(readFileSync(filePath), {
          headers: { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' },
        });
      }
      return c.notFound();
    });
  }

  // Serve PWA icon directory
  app.get('/icons/*', (c) => {
    const subPath = c.req.path.slice('/icons/'.length);
    if (!subPath || subPath.includes('..')) return c.notFound();
    const filePath = join(uiDir, 'icons', subPath);
    if (existsSync(filePath)) {
      const ext = subPath.split('.').pop() || '';
      return new Response(readFileSync(filePath), {
        headers: { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' },
      });
    }
    return c.notFound();
  });

  // SPA catch-all: serve index.html for all non-API, non-asset routes
  // This enables client-side routing via React Router
  app.get('*', (c) => {
    // Don't catch API routes
    if (c.req.path.startsWith('/api/')) return c.notFound();
    return new Response(readFileSync(spaIndexPath), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  });

} else {
  // ═══════════════════════════════════════════════════════════════
  // Legacy Alpine.js mode — server-rendered pages (fallback)
  // ═══════════════════════════════════════════════════════════════

  // Lazy-import page renderers only when needed (avoid build errors if pages are removed)
  const legacyPageHandler = async (c: any, renderer: string, args: any[] = []) => {
    try {
      const mod = await import(`./pages/${renderer}.js`);
      const fn = Object.values(mod)[0] as Function;
      return c.html(fn(c, ...args));
    } catch {
      return c.text('Legacy UI not available. Please build the React UI.', 500);
    }
  };

  app.get('/static/style.css', (c) => {
    const filePath = join(staticDir, 'style.css');
    if (existsSync(filePath)) {
      return new Response(readFileSync(filePath), { headers: { 'Content-Type': 'text/css' } });
    }
    return c.notFound();
  });

  app.get('/static/app.js', (c) => {
    const filePath = join(staticDir, 'app.js');
    if (existsSync(filePath)) {
      return new Response(readFileSync(filePath), { headers: { 'Content-Type': 'application/javascript' } });
    }
    return c.notFound();
  });

  app.get('/', (c) => legacyPageHandler(c, 'dashboard'));
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
    return legacyPageHandler(c, 'providers', [list]);
  });
  app.get('/settings', (c) => {
    const config = loadConfig();
    const auth = loadWebAuth();
    return legacyPageHandler(c, 'settings', [config, auth?.username || 'mercury']);
  });
  app.get('/skills', (c) => legacyPageHandler(c, 'skills'));
  app.get('/permissions', (c) => legacyPageHandler(c, 'permissions'));
  app.get('/usage', (c) => legacyPageHandler(c, 'usage'));
  app.get('/schedules', (c) => legacyPageHandler(c, 'schedules'));
  app.get('/second-brain/graph', (c) => legacyPageHandler(c, 'brain/graph'));
  app.get('/second-brain/memory', (c) => legacyPageHandler(c, 'brain/memory'));
  app.get('/second-brain/persons', (c) => legacyPageHandler(c, 'brain/persons'));
  app.get('/second-brain/persons/:id', (c) => {
    const id = c.req.param('id');
    return legacyPageHandler(c, 'brain/person', [id]);
  });
  app.get('/second-brain/goals', (c) => legacyPageHandler(c, 'brain/goals'));
  app.get('/chat', (c) => legacyPageHandler(c, 'chat'));
  app.get('/tasks', (c) => legacyPageHandler(c, 'tasks'));
  app.get('/board', (c) => legacyPageHandler(c, 'kanban'));
}

export { updateStatus, setUserMemory, setWebChannel, setScheduler, setAgentSupervisor, setBackgroundTaskManager, setSpotifyClient, setProgrammingMode, setModelSwitchCallback, setCurrentProviderCallback, setKanbanSupervisor, setKanbanBoardManager, setKanbanProviders };

export function startWebServer(): { port: number; url: string } {
  const port = getWebPort();
  initWebAuth();

  if (spaAvailable) {
    logger.info(`React UI loaded from: ${uiDir}`);
  } else {
    logger.info('React UI not found, using legacy Alpine.js UI');
  }

  const server = createAdaptorServer({ fetch: app.fetch });

  server.on('error', (err: any) => {
    if (err?.code === 'EADDRINUSE') {
      logger.warn(`Port ${port} is already in use. Web dashboard unavailable.`);
    } else {
      logger.error({ err: err.message }, 'Web server error');
    }
  });

  server.listen(port, '127.0.0.1', () => {
    logger.info(`Web dashboard: http://127.0.0.1:${port}`);
  });

  return { port, url: `http://127.0.0.1:${port}` };
}
