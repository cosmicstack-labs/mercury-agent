import { Hono } from 'hono';
import { mediaService } from '../../media/runtime.js';
import { setMediaDefault, setSpeechPrefs } from '../../media/prefs.js';
import { getSpeechService } from '../../media/speech.js';
import { mediaJobs } from '../../media/jobs.js';

/**
 * Media models for the apps (ADR-042).
 *   GET  /api/media/models[?refresh=1]  image models on the configured providers,
 *                                       the default and the automatic pick
 *   PUT  /api/media/default { kind: "image", ref: "provider::model" | null }
 *   PUT  /api/media/speech { choice?, voice?, replies? }  (null clears; phase 2)
 */
const media = new Hono();

media.get('/api/media/models', async (c) => {
  const service = mediaService();
  if (!service) return c.json({ image: { models: [], default: null, auto: null }, speech: null });
  const refresh = c.req.query('refresh') === '1';
  const speechService = getSpeechService();
  const [setup, speech, video, music] = await Promise.all([
    service.imageSetup({ refresh }),
    speechService ? Promise.all([speechService.options({ refresh }), speechService.target()]) : Promise.resolve(null),
    service.setup('video', { refresh }),
    service.setup('music', { refresh }),
  ]);
  const kindJson = (k: typeof video) => ({
    models: k.models.map(({ ref, provider, model, label, group, canEdit }) => ({ ref, provider, model, label, group, canEdit })),
    default: k.default ?? null,
    auto: k.auto ? { ref: k.auto.ref, label: k.auto.label, group: k.auto.group } : null,
  });
  const prefs = speechService?.prefs() ?? {};
  return c.json({
    video: kindJson(video),
    music: kindJson(music),
    speech: speech ? {
      options: speech[0],
      current: speech[1] ? { id: speech[1].id, label: speech[1].label, voice: speech[1].voice ?? null } : null,
      choice: prefs.choice ?? null,
      voice: prefs.voice ?? null,
      replies: prefs.replies ?? 'mirror',
    } : null,
    image: {
      models: setup.models.map(({ ref, provider, model, label, group, canEdit }) => ({ ref, provider, model, label, group, canEdit })),
      default: setup.default ?? null,
      auto: setup.auto ? { ref: setup.auto.ref, label: setup.auto.label, group: setup.auto.group } : null,
    },
  });
});

media.put('/api/media/default', async (c) => {
  const body = await c.req.json<{ kind?: unknown; ref?: unknown }>().catch(() => null);
  if (!body || (body.kind !== 'image' && body.kind !== 'video' && body.kind !== 'music')) return c.json({ error: 'kind must be "image", "video" or "music"' }, 400);
  if (body.ref !== null && typeof body.ref !== 'string') return c.json({ error: 'ref must be "provider::model" or null' }, 400);
  try {
    setMediaDefault(body.kind, body.ref);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
  return c.json({ ok: true });
});

media.put('/api/media/speech', async (c) => {
  const body = await c.req.json<{ choice?: unknown; voice?: unknown; replies?: unknown }>().catch(() => null);
  if (!body) return c.json({ error: 'JSON body required' }, 400);
  const str = (v: unknown) => (v === null || typeof v === 'string' ? v : undefined);
  try {
    const next = setSpeechPrefs({
      ...(body.choice !== undefined ? { choice: str(body.choice) ?? null } : {}),
      ...(body.voice !== undefined ? { voice: str(body.voice) ?? null } : {}),
      ...(body.replies !== undefined ? { replies: (str(body.replies) ?? null) as 'off' | 'mirror' | 'always' | null } : {}),
    });
    return c.json({ ok: true, speech: next });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

/** Videos and songs this chat is still making (placeholders on a reopened chat). */
media.get('/api/media/jobs', (c) => {
  const id = c.req.query('sessionId');
  const list = mediaJobs()?.list(id ? { channelId: id } : undefined, 20) ?? [];
  return c.json({
    jobs: list.filter((j) => j.status === 'running').map((j) => ({ jobId: j.id, kind: j.kind, prompt: j.prompt.slice(0, 200), startedAt: j.createdAt, ...(j.aspect ? { aspect: j.aspect } : {}) })),
  });
});

export default media;
