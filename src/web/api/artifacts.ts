import { copyFileSync, createReadStream, existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { artifactStore, type Artifact } from '../../artifacts/store.js';
import type { ArtifactKind } from '../../artifacts/classify.js';
import type { SessionRepository } from '../../sessions/index.js';
import { isLoopbackRequest } from '../middleware.js';

/**
 * Artifacts: what Mercury made, by conversation.
 *
 *   GET    /api/artifacts?kind=&q=&threadId=&cursor=&limit=   newest first, a page at a time, with counts per kind
 *   GET    /api/artifacts/:id                                  one, with its thread
 *   GET    /api/artifacts/:id/file                             the file itself (Range for video and audio)
 *   POST   /api/artifacts/:id/export { dest }                  Save as… (this computer only)
 *   DELETE /api/artifacts/:id                                  forget one (Mercury's copy only)
 */

let sessions: SessionRepository | null = null;
export function setArtifactSessions(repo: SessionRepository | null): void { sessions = repo; }

const KINDS: Array<ArtifactKind | 'all'> = ['all', 'image', 'video', 'audio', 'pdf', 'document', 'text', 'file'];

function withThread(a: Artifact) {
  let threadTitle: string | null = null;
  let threadExists = false;
  try {
    const s = sessions?.get(a.threadId);
    if (s && s.status !== 'deleted') { threadTitle = s.title; threadExists = true; }
  } catch { /* gone */ }
  const { storedPath: _stored, ...rest } = a;
  return { ...rest, threadTitle, threadExists, originalExists: existsSync(a.originalPath) };
}

const artifacts = new Hono();

artifacts.get('/api/artifacts', (c) => {
  const kind = c.req.query('kind') as ArtifactKind | 'all' | undefined;
  const r = artifactStore().list({
    kind: kind && KINDS.includes(kind) ? kind : 'all',
    q: c.req.query('q') ?? undefined,
    threadId: c.req.query('threadId') ?? undefined,
    cursor: c.req.query('cursor') ?? undefined,
    limit: Number(c.req.query('limit') ?? 40) || 40,
  });
  return c.json({ items: r.items.map(withThread), nextCursor: r.nextCursor, counts: r.counts });
});

artifacts.get('/api/artifacts/:id', (c) => {
  const a = artifactStore().get(c.req.param('id'));
  return a ? c.json({ artifact: withThread(a) }) : c.json({ error: 'Not found' }, 404);
});

artifacts.get('/api/artifacts/:id/file', (c) => {
  const a = artifactStore().get(c.req.param('id'));
  if (!a || !existsSync(a.storedPath)) return c.json({ error: 'Not found' }, 404);
  const size = statSync(a.storedPath).size;
  const headers: Record<string, string> = {
    'Content-Type': a.mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
    'Content-Disposition': `${c.req.query('download') === '1' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(a.name)}`,
    // SVG and HTML-ish content can't run anything when opened directly.
    'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; media-src 'self'",
    'X-Content-Type-Options': 'nosniff',
  };
  const range = c.req.header('range');
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    const body = Readable.toWeb(createReadStream(a.storedPath, { start, end })) as unknown as ReadableStream;
    return new Response(body, { status: 206, headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) } });
  }
  const body = Readable.toWeb(createReadStream(a.storedPath)) as unknown as ReadableStream;
  return new Response(body, { status: 200, headers: { ...headers, 'Content-Length': String(size) } });
});

artifacts.post('/api/artifacts/:id/export', async (c) => {
  if (!isLoopbackRequest(c)) return c.json({ error: 'Saving to a folder only works on the computer Mercury runs on. Use Download instead.' }, 403);
  const a = artifactStore().get(c.req.param('id'));
  if (!a || !existsSync(a.storedPath)) return c.json({ error: 'Not found' }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { dest?: unknown };
  const dest = typeof body.dest === 'string' ? body.dest : '';
  if (!dest || !isAbsolute(dest) || !existsSync(dirname(dest))) return c.json({ error: 'Choose a folder that exists.' }, 400);
  copyFileSync(a.storedPath, dest);
  return c.json({ ok: true, path: dest });
});

artifacts.delete('/api/artifacts/:id', (c) => (artifactStore().remove(c.req.param('id')) ? c.json({ ok: true }) : c.json({ error: 'Not found' }, 404)));

export default artifacts;
