/**
 * Plugin API for the dashboard and for `mercury plugins …` / attached
 * terminals (which forward here so only the runtime owner runs plugins).
 *
 * Reading (list, info, health) is open to any authenticated session.
 * Anything that installs or changes plugins runs new code on this machine,
 * so it is accepted from this machine only (like /api/restart), never from
 * a LAN or Cloud-relayed session.
 */
import { Hono, type Context } from 'hono';
import { isLoopbackRequest } from '../middleware.js';
import { getPluginManager } from '../../plugins/manager.js';
import { localService } from '../../plugins/service.js';
import { qrSvg } from '../../plugins/qr-svg.js';
import { readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { installedManifest } from '../../plugins/installer.js';
import { pluginVersionDir, readState } from '../../plugins/store.js';

const plugins = new Hono();

function svc() {
  return localService(getPluginManager());
}

function localOnly(c: Context): Response | null {
  if (isLoopbackRequest(c)) return null;
  return c.json({ error: 'Plugins can only be installed or changed from this machine.' }, 403);
}

function fail(c: Context, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const status = /not installed|No plugin called|no setting/i.test(message) ? 404 : 400;
  return c.json({ error: message }, status);
}

plugins.get('/api/plugins', async (c) => {
  try {
    return c.json(await svc().list(c.req.query('refresh') === '1'));
  } catch (err) {
    return fail(c, err);
  }
});

plugins.get('/api/plugins/health', (c) => c.json(getPluginManager().health()));

/**
 * A fenced-block renderer (Plugin API 1.3).
 *
 * The document is the plugin's own HTML, so it is served as a document with a
 * CSP that allows inline script and style and nothing else: no network, no
 * forms, no base URL. The dashboard puts it in `sandbox="allow-scripts"`, which
 * drops it to an opaque origin — no session cookie, no app DOM, and a
 * postMessage that can only reach the frame that embedded it.
 *
 * Only an asset the manifest declares is served. Without that check the route
 * would hand out `.env` files a plugin folder should never have.
 */
const RENDERER_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

plugins.get('/api/plugins/:id/renderer/*', (c) => {
  const id = c.req.param('id');
  const asset = c.req.path.split('/renderer/')[1] ?? '';

  const entry = readState().plugins[id];
  if (!entry) return c.json({ error: 'Plugin not installed' }, 404);
  const manifest = installedManifest(id, entry.version);
  if (!manifest) return c.json({ error: 'Plugin manifest is unreadable' }, 404);

  const declared = manifest.contributes.renderers.some((renderer) => renderer.asset === asset);
  if (!declared) return c.json({ error: 'No such renderer asset' }, 404);

  const root = pluginVersionDir(id, entry.version);
  const file = resolve(root, asset);
  // `resolve` collapses `..`: anything that lands outside the version folder
  // is refused even though the manifest check above already ruled it out.
  if (file !== root && !file.startsWith(root + sep)) return c.json({ error: 'No such renderer asset' }, 404);
  let bytes: Buffer;
  try {
    if (!statSync(file).isFile()) throw new Error('not a file');
    bytes = readFileSync(file);
  } catch {
    return c.json({ error: 'Renderer asset is missing from the installation' }, 404);
  }

  const type = file.endsWith('.html') ? 'text/html; charset=utf-8'
    : file.endsWith('.css') ? 'text/css; charset=utf-8'
      : file.endsWith('.js') || file.endsWith('.mjs') ? 'text/javascript; charset=utf-8'
        : 'application/octet-stream';
  return new Response(bytes, {
    headers: {
      'content-type': type,
      'content-security-policy': RENDERER_CSP,
      'x-content-type-options': 'nosniff',
      // The URL carries the version, so a new install is a new URL — the old
      // one must not survive in a cache.
      'cache-control': 'no-cache',
    },
  });
});

plugins.get('/api/plugins/:id', async (c) => {
  try {
    return c.json({ plugin: await svc().info(c.req.param('id')) });
  } catch (err) {
    return fail(c, err);
  }
});

plugins.post('/api/plugins/install', async (c) => {
  const denied = localOnly(c);
  if (denied) return denied;
  const body = (await c.req.json().catch(() => ({}))) as { source?: unknown; enable?: unknown; force?: unknown };
  if (typeof body.source !== 'string' || !body.source.trim() || body.source.length > 500) {
    return c.json({ error: 'source must be a plugin id, path, https URL or github:owner/repo' }, 400);
  }
  try {
    return c.json(await svc().install(body.source.trim(), { enable: body.enable !== false, force: body.force === true }));
  } catch (err) {
    return fail(c, err);
  }
});

plugins.post('/api/plugins/update', async (c) => {
  const denied = localOnly(c);
  if (denied) return denied;
  try {
    return c.json({ changed: await svc().update() });
  } catch (err) {
    return fail(c, err);
  }
});

plugins.post('/api/plugins/reconcile', async (c) => {
  const denied = localOnly(c);
  if (denied) return denied;
  await getPluginManager().reconcile();
  return c.json({ ok: true });
});

for (const action of ['enable', 'disable', 'update', 'rollback'] as const) {
  plugins.post(`/api/plugins/:id/${action}`, async (c) => {
    const denied = localOnly(c);
    if (denied) return denied;
    const id = c.req.param('id');
    try {
      const s = svc();
      if (action === 'enable') await s.enable(id);
      else if (action === 'disable') await s.disable(id);
      else if (action === 'rollback') return c.json(await s.rollback(id));
      else return c.json({ changed: await s.update(id) });
      return c.json({ ok: true, plugin: await s.info(id) });
    } catch (err) {
      return fail(c, err);
    }
  });
}

plugins.post('/api/plugins/:id/settings', async (c) => {
  const denied = localOnly(c);
  if (denied) return denied;
  const body = (await c.req.json().catch(() => ({}))) as { key?: unknown; value?: unknown };
  if (typeof body.key !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/.test(body.key)) return c.json({ error: 'key is required' }, 400);
  try {
    await svc().setSetting(c.req.param('id'), body.key, body.value);
    return c.json({ ok: true });
  } catch (err) {
    return fail(c, err);
  }
});

// Plugin API 1.1 channels. The status includes a live QR code, and linking
// gives an account to Mercury, so all of these are loopback-only.
plugins.get('/api/plugins/:id/channel', (c) => {
  const denied = localOnly(c);
  if (denied) return denied;
  const status = getPluginManager().channelStatus(c.req.param('id'));
  // qr for the terminal (`mercury plugins pair`), qrImage for the dashboard.
  const qrImage = status?.qr ? `data:image/svg+xml;base64,${Buffer.from(qrSvg(status.qr)).toString('base64')}` : undefined;
  return c.json({ status: status ? { ...status, qrImage } : null });
});

plugins.post('/api/plugins/:id/pair', async (c) => {
  const denied = localOnly(c);
  if (denied) return denied;
  const body = (await c.req.json().catch(() => ({}))) as { method?: unknown; phone?: unknown };
  const method = body.method === 'code' ? 'code' : 'qr';
  const phone = typeof body.phone === 'string' && /^\+?[\d\s-]{6,20}$/.test(body.phone) ? body.phone : undefined;
  try {
    return c.json({ status: await svc().pair(c.req.param('id'), { method, phone }) });
  } catch (err) {
    return fail(c, err);
  }
});

plugins.post('/api/plugins/:id/test', async (c) => {
  const denied = localOnly(c);
  if (denied) return denied;
  try {
    return c.json({ message: await svc().testChannel(c.req.param('id')) });
  } catch (err) {
    return fail(c, err);
  }
});

plugins.post('/api/plugins/:id/unlink', async (c) => {
  const denied = localOnly(c);
  if (denied) return denied;
  try {
    await svc().unlink(c.req.param('id'));
    return c.json({ ok: true });
  } catch (err) {
    return fail(c, err);
  }
});

plugins.delete('/api/plugins/:id', async (c) => {
  const denied = localOnly(c);
  if (denied) return denied;
  try {
    await svc().uninstall(c.req.param('id'), c.req.query('purge') === '1');
    return c.json({ ok: true });
  } catch (err) {
    return fail(c, err);
  }
});

export default plugins;
