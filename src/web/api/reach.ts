/**
 * Calls and notifications from Mercury to the owner's phone (ADR-046).
 *
 * For the phone itself (a paired device's token; only that device, never another):
 *   PUT  /api/devices/me/reach        { platform, appVersion, ring, notify, capabilities } → { reach }
 *   GET  /api/devices/me/reach        → { device, reach, live, settings }
 *   POST /api/devices/me/ring/:id     { outcome: answered | declined | missed } → { ok, state }
 *   POST /api/devices/me/test-ring    ring this phone now (Settings → Calls from Mercury → Test)
 *   GET  /api/devices/me/missed       → { items } calls and notifications no phone was live for
 *   POST /api/devices/me/missed/ack   { ids: string[] } | { all: true } → { removed }
 *
 * For the owner from any of their apps:
 *   GET  /api/reach/settings          → { settings }
 *   PUT  /api/reach/settings          partial settings → { settings }
 *   GET  /api/reach/phones            → { phones: [{ id, name, platform, appVersion, ring, notify, live, lastSeenAt }] }
 *
 * The phone opens no extra connection for this: rings and notifications
 * arrive as `ring`, `ring_end` and `notify` events on the activity stream
 * (/api/chat/activity) it already keeps open while the app runs.
 */
import { Hono, type Context } from 'hono';
import { principalOf } from '../middleware.js';
import { audit } from '../../security/audit.js';
import { getDevice, listPhones, normalizeReach, setDeviceReach } from '../devices.js';
import { isLive } from '../../reach/presence.js';
import { reachService } from '../../reach/service.js';
import { ackMissed, listMissed } from '../../reach/missed.js';
import { readReachSettings, writeReachSettings } from '../../reach/settings.js';

const reach = new Hono();

/** The paired device making this request, or a 403 for anything else (a browser, this computer's CLI). */
function deviceOf(c: Context): { id: string; name: string } | Response {
  const p = principalOf(c);
  if (p?.kind !== 'device') return c.json({ error: 'Only a paired phone can do this, for itself.' }, 403);
  return { id: p.deviceId, name: p.deviceName };
}

reach.put('/api/devices/me/reach', async (c) => {
  const me = deviceOf(c);
  if (me instanceof Response) return me;
  const next = normalizeReach(await c.req.json().catch(() => null));
  if (typeof next === 'string') return c.json({ error: next }, 400);
  const before = getDevice(me.id)?.reach;
  if (!setDeviceReach(me.id, next)) return c.json({ error: 'No such device' }, 404);
  const changed = !before || before.ring !== next.ring || before.notify !== next.notify || before.platform !== next.platform || before.appVersion !== next.appVersion;
  if (changed) audit('device.reach', { who: `${me.name} (${me.id})`, detail: `${next.platform} ${next.appVersion || '?'}; ring ${next.ring ? 'on' : 'off'}, notify ${next.notify ? 'on' : 'off'}` });
  return c.json({ reach: next });
});

reach.get('/api/devices/me/reach', (c) => {
  const me = deviceOf(c);
  if (me instanceof Response) return me;
  const d = getDevice(me.id);
  if (!d) return c.json({ error: 'No such device' }, 404);
  return c.json({ device: { id: d.id, name: d.name, platform: d.platform }, reach: d.reach ?? null, live: isLive(d.id), settings: readReachSettings() });
});

reach.post('/api/devices/me/ring/:id', async (c) => {
  const me = deviceOf(c);
  if (me instanceof Response) return me;
  const body = (await c.req.json().catch(() => ({}))) as { outcome?: unknown };
  const outcome = body.outcome;
  if (outcome !== 'answered' && outcome !== 'declined' && outcome !== 'missed') return c.json({ error: 'outcome must be answered, declined or missed' }, 400);
  const r = reachService().report(me.id, c.req.param('id'), outcome);
  if (!r.ok) return c.json({ error: r.error }, r.status);
  return c.json({ ok: true, state: r.state });
});

reach.post('/api/devices/me/test-ring', (c) => {
  const me = deviceOf(c);
  if (me instanceof Response) return me;
  if (!isLive(me.id)) return c.json({ error: 'This phone isn\'t connected to Mercury\'s live updates right now. Open Mercury and try again.' }, 409);
  // Not awaited: the ring arrives on the phone's stream; the request returns at once.
  void reachService().callOwner({ reason: 'This is a test call from Mercury, to check that calls reach you', source: 'test', deviceIds: [me.id], followUp: false }).catch(() => {});
  return c.json({ ok: true });
});

reach.get('/api/devices/me/missed', (c) => {
  const me = deviceOf(c);
  if (me instanceof Response) return me;
  return c.json({ items: listMissed() });
});

reach.post('/api/devices/me/missed/ack', async (c) => {
  const me = deviceOf(c);
  if (me instanceof Response) return me;
  const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown; all?: unknown };
  if (body.all === true) return c.json({ removed: ackMissed('all') });
  const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string').slice(0, 100) : [];
  if (!ids.length) return c.json({ error: 'Send { ids: [...] } or { all: true }.' }, 400);
  return c.json({ removed: ackMissed(ids) });
});

reach.get('/api/reach/settings', (c) => c.json({ settings: readReachSettings() }));

reach.put('/api/reach/settings', async (c) => {
  const patch = await c.req.json().catch(() => null);
  if (!patch || typeof patch !== 'object') return c.json({ error: 'Send the settings to change.' }, 400);
  const before = readReachSettings();
  const settings = writeReachSettings(patch);
  const p = principalOf(c);
  const who = p?.kind === 'device' ? p.deviceName : p?.kind === 'session' ? 'browser' : 'this computer';
  const changed = (Object.keys(settings) as Array<keyof typeof settings>).filter((k) => JSON.stringify(settings[k]) !== JSON.stringify(before[k]));
  if (changed.length) audit('reach.settings', { who, detail: changed.join(', ') });
  return c.json({ settings });
});

reach.get('/api/reach/phones', (c) => c.json({
  phones: listPhones().map((d) => ({
    id: d.id, name: d.name, platform: d.reach?.platform ?? d.platform, appVersion: d.reach?.appVersion ?? null,
    ring: d.reach?.ring !== false, notify: d.reach?.notify !== false, registered: !!d.reach, live: isLive(d.id), lastSeenAt: d.lastSeenAt,
  })),
}));

export default reach;
