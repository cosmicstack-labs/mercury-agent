import { copyFileSync, createReadStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { chatFoldersFor, freeName, outputRoot } from '../../artifacts/output-dir.js';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { artifactStore, type Artifact } from '../../artifacts/store.js';
import type { ArtifactKind } from '../../artifacts/classify.js';
import type { SessionRepository } from '../../sessions/index.js';
import { isThisComputer } from '../middleware.js';
import { canConvert, CONVERT_MIME, convertedName, convertFile, type ConvertFormat } from '../../artifacts/convert/index.js';
import { logger } from '../../utils/logger.js';

const asFormat = (v: unknown): ConvertFormat | null => (v === 'pdf' || v === 'docx' ? v : null);

/**
 * Artifacts: what Mercury made, by conversation.
 *
 *   GET    /api/artifacts?kind=&q=&threadId=&cursor=&limit=   newest first, a page at a time, with counts per kind
 *   GET    /api/artifacts/:id                                  one, with its thread
 *   GET    /api/artifacts/:id/file                             the file itself (Range for video and audio)
 *   GET    /api/artifacts/:id/file?as=pdf|docx                 a Markdown/text artifact as a PDF or Word document
 *   POST   /api/artifacts/:id/export { dest, as? }             Save as… (this computer only), converted when `as` is given
 *   DELETE /api/artifacts/:id                                  forget one (Mercury's copy only)
 *   GET    /api/artifacts/folder                               the output folder (~/mercury-artifacts) and files Mercury left loose in the home folder
 *   POST   /api/artifacts/folder/tidy                          move those loose files into their chats' folders (this computer only)
 */

let sessions: SessionRepository | null = null;
export function setArtifactSessions(repo: SessionRepository | null): void { sessions = repo; }

/** The configured output folder (artifacts.outputDir), read when asked so a config change applies. */
let outputSetting: () => string | undefined = () => undefined;
export function setArtifactOutputDir(fn: () => string | undefined): void { outputSetting = fn; }

/** Files Mercury made that sit loose in the home folder (from before the output folder existed). */
function strays(): Artifact[] {
  const home = resolve(homedir());
  const seen = new Set<string>();
  return artifactStore().all().filter((a) => {
    if (seen.has(a.originalPath)) return false;
    seen.add(a.originalPath);
    return resolve(dirname(a.originalPath)) === home && existsSync(a.originalPath);
  });
}

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

artifacts.get('/api/artifacts/folder', (c) => {
  const root = outputRoot(outputSetting());
  const home = resolve(homedir());
  const display = root === home ? '~' : root.startsWith(`${home}/`) ? `~${root.slice(home.length)}` : root;
  return c.json({ path: root, display, exists: existsSync(root), strays: strays().map((a) => ({ id: a.id, name: a.name, path: a.originalPath, threadId: a.threadId, threadTitle: withThread(a).threadTitle })) });
});

artifacts.post('/api/artifacts/folder/tidy', (c) => {
  if (!isThisComputer(c)) return c.json({ error: 'Tidying files only works on the computer Mercury runs on.' }, 403);
  const folders = chatFoldersFor(outputRoot(outputSetting()));
  const moved: Array<{ name: string; to: string }> = [];
  const failed: Array<{ name: string; error: string }> = [];
  for (const a of strays()) {
    try {
      const thread = withThread(a);
      const dir = folders.pathFor(a.threadId, thread.threadTitle || a.name.replace(/\.[^.]+$/, ''), a.createdAt);
      mkdirSync(dir, { recursive: true });
      const to = join(dir, freeName(dir, a.name));
      try { renameSync(a.originalPath, to); } catch { copyFileSync(a.originalPath, to); unlinkSync(a.originalPath); }
      // Every record of this file (the same file in two threads) follows it.
      for (const same of artifactStore().all().filter((x) => x.originalPath === a.originalPath)) artifactStore().relocate(same.id, to);
      moved.push({ name: a.name, to });
    } catch (err) {
      failed.push({ name: a.name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return c.json({ moved, failed });
});

artifacts.get('/api/artifacts/:id', (c) => {
  const a = artifactStore().get(c.req.param('id'));
  return a ? c.json({ artifact: withThread(a) }) : c.json({ error: 'Not found' }, 404);
});

artifacts.get('/api/artifacts/:id/file', (c) => {
  const a = artifactStore().get(c.req.param('id'));
  if (!a || !existsSync(a.storedPath)) return c.json({ error: 'Not found' }, 404);
  const as = asFormat(c.req.query('as'));
  if (c.req.query('as') !== undefined && !as) return c.json({ error: 'as must be pdf or docx' }, 400);
  if (as) {
    if (!canConvert(a)) return c.json({ error: 'Only Markdown and text can be exported as a document.' }, 415);
    let bytes: Buffer;
    try { bytes = convertFile(a.storedPath, a.name, as); } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err), id: a.id, as }, 'Artifact conversion failed');
      return c.json({ error: `Couldn't make the ${as === 'pdf' ? 'PDF' : 'Word document'}.` }, 500);
    }
    return new Response(new Uint8Array(bytes), { status: 200, headers: {
      'Content-Type': CONVERT_MIME[as],
      'Content-Length': String(bytes.length),
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(convertedName(a.name, as))}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    } });
  }
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
  if (!isThisComputer(c)) return c.json({ error: 'Saving to a folder only works on the computer Mercury runs on. Use Download instead.' }, 403);
  const a = artifactStore().get(c.req.param('id'));
  if (!a || !existsSync(a.storedPath)) return c.json({ error: 'Not found' }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { dest?: unknown; as?: unknown };
  const dest = typeof body.dest === 'string' ? body.dest : '';
  if (!dest || !isAbsolute(dest) || !existsSync(dirname(dest))) return c.json({ error: 'Choose a folder that exists.' }, 400);
  const as = asFormat(body.as);
  if (body.as !== undefined && !as) return c.json({ error: 'as must be pdf or docx' }, 400);
  if (as) {
    if (!canConvert(a)) return c.json({ error: 'Only Markdown and text can be exported as a document.' }, 415);
    try { writeFileSync(dest, convertFile(a.storedPath, a.name, as)); } catch (err) {
      return c.json({ error: `Couldn't make the ${as === 'pdf' ? 'PDF' : 'Word document'}: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
    return c.json({ ok: true, path: dest });
  }
  copyFileSync(a.storedPath, dest);
  return c.json({ ok: true, path: dest });
});

artifacts.delete('/api/artifacts/:id', (c) => (artifactStore().remove(c.req.param('id')) ? c.json({ ok: true }) : c.json({ error: 'Not found' }, 404)));

export default artifacts;
