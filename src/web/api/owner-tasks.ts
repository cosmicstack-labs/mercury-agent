import { Hono, type Context } from 'hono';
import { principalLabel, principalOf } from '../middleware.js';
import { readFileSync } from 'node:fs';
import { ownerTasks, OWNER_TASK_MAX_ANSWER, type OwnerTask } from '../../security/owner-tasks.js';
import { audit } from '../../security/audit.js';

/**
 * Owner tasks (ADR-048) for the apps: Mercury Desktop and the paired phones
 * show what's waiting, the image or audio, and send the answer back. Any
 * signed-in client of the owner may answer (behind the auth guard: browser
 * session, this computer, or a paired device's token); the first answer wins.
 *
 *   GET  /api/owner/tasks              → { pending: OwnerTask[] }
 *   GET  /api/owner/tasks/:id/media    → the image or audio
 *   POST /api/owner/tasks/:id          { answer: string } | { decline: true } → { task }
 */
export const ownerTaskRoutes = new Hono();

const view = (t: OwnerTask) => ({
  id: t.id, code: t.code, title: t.title, prompt: t.prompt, who: t.who, link: t.link,
  media: t.media ? { kind: t.media.kind, mimeType: t.media.mimeType, url: `/api/owner/tasks/${t.id}/media` } : undefined,
  answerKind: t.answerKind, expiresAt: t.expiresAt, status: t.status,
});

const answeredBy = (c: Context) => principalLabel(principalOf(c));

ownerTaskRoutes.get('/api/owner/tasks', (c) => c.json({ pending: ownerTasks().pending().map(view) }));

ownerTaskRoutes.get('/api/owner/tasks/:id/media', (c) => {
  const t = ownerTasks().get(c.req.param('id'));
  if (!t?.media) return c.json({ error: 'No such task media' }, 404);
  let data: Buffer;
  try { data = readFileSync(t.media.path); } catch { return c.json({ error: 'Media is gone' }, 410); }
  return new Response(new Uint8Array(data), { headers: { 'Content-Type': t.media.mimeType, 'Cache-Control': 'no-store' } });
});

ownerTaskRoutes.post('/api/owner/tasks/:id', async (c) => {
  const body = await c.req.json<{ answer?: unknown; decline?: unknown }>().catch(() => ({} as { answer?: unknown; decline?: unknown }));
  const id = c.req.param('id');
  const before = ownerTasks().get(id);
  if (!before) return c.json({ error: 'No such task' }, 404);
  const by = answeredBy(c);
  let t: OwnerTask | null;
  if (body.decline === true) t = ownerTasks().decline(id, by);
  else {
    if (typeof body.answer !== 'string' || (!body.answer.trim() && before.answerKind === 'text')) return c.json({ error: 'answer is required' }, 400);
    if (body.answer.length > OWNER_TASK_MAX_ANSWER) return c.json({ error: `answer is longer than ${OWNER_TASK_MAX_ANSWER} characters` }, 400);
    t = ownerTasks().answer(id, body.answer, by);
  }
  if (!t) return c.json({ error: 'Already answered or expired', task: view(ownerTasks().get(id) ?? before) }, 409);
  audit('owner.task', { who: t.who, by, detail: `${t.title}: ${t.status}` });
  return c.json({ task: view(t) });
});
