/**
 * The app's "Microphone & permissions" screen: what the OS lets each desktop
 * plugin (Optimus) use, which microphone it listens with, and a live test.
 *
 *   GET  /api/devices                     every running desktop plugin's report
 *   POST /api/devices/:id/request         { kind, openSettings? }: ask the OS, or open its settings page
 *   POST /api/devices/:id/select          { microphone?, microphoneOn? }
 *   GET  /api/devices/:id/test?seconds=5  SSE: `level` {level, at} while listening, then `done` or `error`
 *
 * All of it is about the computer Mercury runs on and can open system
 * settings there, so it's accepted from this machine only.
 */
import { Hono, type Context } from 'hono';
import { isThisComputer } from '../middleware.js';
import { getPluginManager } from '../../plugins/manager.js';
import { deviceFeed } from '../../plugins/device-feed.js';

const devices = new Hono();

const KINDS = ['microphone', 'screen', 'accessibility', 'camera'] as const;

function localOnly(c: Context): Response | null {
  if (isThisComputer(c)) return null;
  return c.json({ error: 'Microphone and permissions are set on the computer Mercury runs on. Open Mercury there.', remote: true }, 403);
}

function fail(c: Context, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return c.json({ error: message }, /not installed|not running|can't report/i.test(message) ? 409 : 400);
}

devices.get('/api/devices', async (c) => {
  const denied = localOnly(c);
  if (denied) return denied;
  const mgr = getPluginManager();
  const plugins = await Promise.all(
    mgr.devicePlugins().map(async (p) => {
      try {
        return { ...p, report: await mgr.deviceRequest(p.id, 'status', {}, 20_000) };
      } catch (err) {
        return { ...p, error: (err as Error).message };
      }
    }),
  );
  return c.json({ plugins });
});

devices.post('/api/devices/:id/request', async (c) => {
  const denied = localOnly(c);
  if (denied) return denied;
  const body = (await c.req.json().catch(() => ({}))) as { kind?: unknown; openSettings?: unknown };
  if (!(KINDS as readonly unknown[]).includes(body.kind)) return c.json({ error: `kind must be one of ${KINDS.join(', ')}` }, 400);
  try {
    // macOS waits for the owner's answer to its prompt, so allow a minute and a half.
    return c.json({ report: await getPluginManager().deviceRequest(c.req.param('id'), 'request', { kind: body.kind, openSettings: body.openSettings === true }, 90_000) });
  } catch (err) {
    return fail(c, err);
  }
});

devices.post('/api/devices/:id/select', async (c) => {
  const denied = localOnly(c);
  if (denied) return denied;
  const body = (await c.req.json().catch(() => ({}))) as { microphone?: unknown; microphoneOn?: unknown };
  const params: Record<string, unknown> = {};
  if (typeof body.microphone === 'string') params.microphone = body.microphone.slice(0, 200);
  if (typeof body.microphoneOn === 'boolean') params.microphoneOn = body.microphoneOn;
  if (Object.keys(params).length === 0) return c.json({ error: 'Send microphone (a name, or "" for the system default) or microphoneOn.' }, 400);
  try {
    return c.json({ report: await getPluginManager().deviceRequest(c.req.param('id'), 'select', params, 20_000) });
  } catch (err) {
    return fail(c, err);
  }
});

devices.get('/api/devices/:id/test', (c) => {
  const denied = localOnly(c);
  if (denied) return denied;
  const id = c.req.param('id');
  const seconds = Math.max(1, Math.min(15, Number(c.req.query('seconds')) || 5));
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let open = true;
      const send = (event: string, data: unknown) => {
        if (!open) return;
        try { controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { /* client gone */ }
      };
      const close = () => {
        if (!open) return;
        open = false;
        unsubscribe();
        try { controller.close(); } catch { /* already closed */ }
      };
      const unsubscribe = deviceFeed.subscribe((ev) => {
        if (ev.plugin === id && ev.kind === 'microphone') send('level', { level: ev.level, at: ev.at });
      });
      c.req.raw.signal?.addEventListener('abort', close);
      getPluginManager()
        .deviceRequest(id, 'test', { seconds }, (seconds + 25) * 1000)
        .then((result) => send('done', result))
        .catch((err) => send('error', { error: (err as Error).message }))
        .finally(close);
    },
    cancel() {},
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' } });
});

export default devices;
