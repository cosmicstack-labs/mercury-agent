import { Hono } from 'hono';
import { isThisComputer, principalLabel, principalOf } from '../middleware.js';
import { requireOwner } from '../owner-gate.js';
import { versionString } from './status.js';
import { audit } from '../../security/audit.js';
import { serverUpdateStatus, targetVersion } from '../../updates/status.js';
import { cancelServerUpdate, startServerUpdate, type UpdateJob } from '../../updates/server-updater.js';
import { compareVersions } from '../../updates/manifest.js';
import { detectInstall } from '../../updates/install-kind.js';

/**
 * Updating this Mercury (UPDATES.md §2):
 *
 *   GET  /api/updates[?seen=1]        version, newest, required, the job
 *   POST /api/updates/check           the same, checked again now (rate limited)
 *   POST /api/updates/server          { version?, now? } → 202 { job }; a remote device asks the owner first
 *   POST /api/updates/server/cancel   only before the old version is stopped
 *
 * Anyone signed in can see the status; updating from another device needs
 * the owner's yes, like a restart.
 */

const updates = new Hono();
let lastCheck = 0;

updates.get('/api/updates', async (c) => {
  return c.json(await serverUpdateStatus({ current: versionString(), seen: c.req.query('seen') === '1' }));
});

updates.post('/api/updates/check', async (c) => {
  const force = Date.now() - lastCheck >= 60_000;
  if (force) lastCheck = Date.now();
  return c.json(await serverUpdateStatus({ current: versionString(), force }));
});

updates.post('/api/updates/server', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { version?: unknown; now?: unknown };
  const current = versionString();
  const status = await serverUpdateStatus({ current });
  const requested = typeof body.version === 'string' && /^\d+\.\d+\.\d+([.+-][\w.-]+)?$/.test(body.version.replace(/^v/, '')) ? body.version.replace(/^v/, '') : null;
  // Only forward, and only to a version we know about: the newest one.
  const to = requested ?? targetVersion(status);
  if (!to) return c.json({ error: `Mercury ${current} is already the newest version.`, upToDate: true }, 400);
  if (compareVersions(to, current) <= 0) return c.json({ error: `${to} isn't newer than ${current}.` }, 400);
  if (status.latest && to !== status.latest.version) return c.json({ error: `Only the newest version (${status.latest.version}) can be installed.` }, 400);

  if (!isThisComputer(c)) {
    const wait = requireOwner(c, { id: 'server.update', title: `Update Mercury to ${to}`, detail: `From ${current}. Mercury restarts on its own (about a minute) and goes back if the new version doesn't start.` });
    if (wait) return wait;
  }
  const started = startServerUpdate({ current, to, install: detectInstall(current), now: body.now === true, manual: true });
  if (!started.ok) return c.json({ error: started.error, ...(started.job ? { job: started.job } : {}) }, started.status);
  started.done.catch(() => {});
  audit('update.started', { who: isThisComputer(c) ? 'this computer' : principalLabel(principalOf(c)), detail: `${current} → ${to}` });
  return c.json({ job: started.job satisfies UpdateJob }, 202);
});

updates.post('/api/updates/server/cancel', (c) => {
  if (!isThisComputer(c)) {
    const wait = requireOwner(c, { id: 'server.update.cancel', title: 'Cancel the Mercury update' });
    if (wait) return wait;
  }
  const r = cancelServerUpdate();
  if (!r.ok) return c.json({ error: r.error, ...(r.job ? { job: r.job } : {}) }, 409);
  return c.json({ ok: true, job: r.job });
});

export default updates;
