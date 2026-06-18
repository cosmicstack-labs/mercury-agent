import { Hono } from 'hono';
import { createAdaptorServer } from '@hono/node-server';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../utils/logger.js';
import { authGuard, errorHandler } from './middleware.js';
import { initWebAuth, getWebPort } from './auth.js';
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
import ideRoutes, { setIDEProviders } from './api/workspace-ide.js';
import { BoardManager } from '../core/board-manager.js';
import { isBetterSqlite3Available } from '../memory/second-brain-db.js';

const app = new Hono();

const __dirname = dirname(fileURLToPath(import.meta.url));

function resolveWebDir(subpath: string): string {
  const envVar = subpath === 'static' ? process.env.MERCURY_WEB_STATIC : process.env.MERCURY_UI_DIR;
  if (envVar) return envVar;

  // When running as a Bun --compile standalone binary, __dirname points to
  // Bun's virtual filesystem ($bunfs).  The web assets are shipped alongside
  // the binary in a `web/` directory, so resolve relative to the binary itself.
  if (typeof (process.versions as any).bun === 'string' && __dirname.includes('$bunfs')) {
    return join(dirname(process.execPath), 'web', subpath);
  }

  return join(__dirname, 'web', subpath);
}

const staticDir = resolveWebDir('static');
const uiDir = resolveWebDir('ui');

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
app.route('/', ideRoutes);

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
  const SPA_TOP_LEVEL_FILES = ['favicon.svg', 'favicon.ico', 'manifest.webmanifest', 'registerSW.js', 'sw.js', 'sw.js.map', 'robots.txt', 'logo-dark.png', 'logo-light.png', 'logo-full-dark.png', 'logo-full-light.png'];

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

    // Serve top-level static files from ui dir if they exist
    const reqPath = c.req.path.slice(1); // strip leading /
    if (reqPath && !reqPath.includes('/') && !reqPath.includes('..')) {
      const filePath = join(uiDir, reqPath);
      if (existsSync(filePath)) {
        const ext = reqPath.split('.').pop() || '';
        return new Response(readFileSync(filePath), {
          headers: {
            'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
            'Cache-Control': 'public, max-age=3600',
          },
        });
      }
    }

    return new Response(readFileSync(spaIndexPath), {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      },
    });
  });

} else {
  // React SPA not built — return helpful message for all routes
  app.get('*', (c) => {
    if (c.req.path.startsWith('/api/')) return c.notFound();
    return c.text('Mercury web UI not found. If running from source, run: npm run build\nIf running a standalone binary, ensure the web/ directory is next to the binary.', 500);
  });
}

export { updateStatus, setUserMemory, setWebChannel, setScheduler, setAgentSupervisor, setBackgroundTaskManager, setSpotifyClient, setProgrammingMode, setModelSwitchCallback, setCurrentProviderCallback, setKanbanSupervisor, setKanbanBoardManager, setKanbanProviders, setIDEProviders };

let webServer: ReturnType<typeof createAdaptorServer> | null = null;

// Ensure web server is always terminated with the Mercury process
process.on('exit', () => {
  if (webServer) {
    try { webServer.close(); } catch {}
    webServer = null;
  }
});

process.on('uncaughtException', (err) => {
  logger.error({ err: err.message }, 'Uncaught exception in web server');
  // Write crash flag so next startup can report to the user.
  try {
    const { writeCrashFlag } = require('../core/crash-flag.js');
    writeCrashFlag({ reason: `Uncaught exception: ${err.message}`.slice(0, 300), timestamp: Date.now() });
  } catch { /* best effort */ }
});

process.on('unhandledRejection', (reason: any) => {
  logger.warn({ err: reason?.message || reason }, 'Unhandled rejection in web server (non-fatal)');
  try {
    const { writeCrashFlag } = require('../core/crash-flag.js');
    writeCrashFlag({ reason: `Unhandled rejection: ${reason?.message || reason}`.slice(0, 300), timestamp: Date.now() });
  } catch { /* best effort */ }
});

export function startWebServer(): { port: number; url: string } {
  const port = getWebPort();
  initWebAuth();

  if (spaAvailable) {
    logger.info(`React UI loaded from: ${uiDir}`);
  } else {
    logger.info('React UI not found, using legacy Alpine.js UI');
  }

  const server = createAdaptorServer({ fetch: app.fetch });
  webServer = server;

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

export function stopWebServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!webServer) return resolve();
    webServer.close(() => resolve());
    // Force-close connections after 2s
    setTimeout(() => resolve(), 2000);
  });
}
