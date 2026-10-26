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
