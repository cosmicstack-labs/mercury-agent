import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { getMercuryHome } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { type ArtifactKind, mimeOf } from './classify.js';

/**
 * Artifacts: deliverables Mercury made, kept with the conversation they came
 * from. Each is Mercury's own copy (a hard link when the disk allows, so a
 * big video isn't stored twice) under ~/.mercury/artifacts/<thread>/, so
 * deleting the thread deletes them, and the owner's original file is never
 * touched. One small index lists them all, newest first.
 */

export interface Artifact {
  id: string;
  threadId: string;
  name: string;
  kind: ArtifactKind;
  mime: string;
  size: number;
  /** Where Mercury wrote it (may have moved or been deleted since). */
  originalPath: string;
  /** Mercury's copy, which the apps show and download. */
  storedPath: string;
  createdAt: number;
  /** The tool that made or sent it. */
  tool?: string;
  /** "code" when it came from Mercury Code. */
  surface?: 'chat' | 'code';
  /** Made together, in one turn by one media tool (five images for one ask): shown as one group. */
  batch?: string;
  /** What the media model was asked for. */
  prompt?: string;
}

/** What deleting did: records gone, bytes the disk got back, originals left where they were. */
export interface RemoveResult { removed: number; freed: number; keptOriginals: number }

/** Space the artifacts take, counted the way the disk does (a hard-linked copy is not counted twice). */
export interface ArtifactUsage {
  count: number;
  /** Bytes on disk for Mercury's copies and the originals Mercury owns. */
  bytes: number;
  byKind: Record<string, { count: number; bytes: number }>;
  /** Of `bytes`, what deleting every artifact would give back. */
  freeable: number;
  /** Artifacts whose original lives outside Mercury's folders (a project file): deleting keeps that file. */
  outside: number;
}

/**
 * May deleting this artifact delete the original too? Only a file Mercury
 * owns: one in its output folder or its home, or one a media model made.
 * A file it wrote into a project stays; only Mercury's copy goes.
 */
export function ownsOriginal(a: Pick<Artifact, 'originalPath' | 'tool'>, roots: readonly string[]): boolean {
  const p = resolve(a.originalPath);
  if (roots.some((r) => p.startsWith(resolve(r) + sep))) return true;
  return !!a.tool && (a.tool.startsWith('generate_') || a.tool === 'research');
}

function inode(path: string): { key: string; size: number; links: number } | null {
  try {
    const st = statSync(path);
    return { key: `${st.dev}:${st.ino}`, size: st.size, links: st.nlink };
  } catch {
    return null;
  }
}

export interface ArtifactQuery { kind?: ArtifactKind | 'all'; q?: string; threadId?: string; cursor?: string; limit?: number }

export class ArtifactStore {
  private items: Artifact[] | null = null;
  /** The index's mtime when read: another process (Mercury Code, the CLI) may have changed it since. */
  private loadedAt = 0;
  constructor(readonly root = join(getMercuryHome(), 'artifacts')) {}

  private get indexPath(): string { return join(this.root, 'index.json'); }

  private load(): Artifact[] {
    // Re-read when another process wrote the index: a stale copy saved over
    // it would bring back what was deleted there (or lose what it added).
    let mtime = 0;
    try { mtime = statSync(this.indexPath).mtimeMs; } catch { /* none yet */ }
    if (this.items && mtime <= this.loadedAt) return this.items;
    this.loadedAt = mtime;
    try {
      this.items = existsSync(this.indexPath) ? (JSON.parse(readFileSync(this.indexPath, 'utf-8')) as Artifact[]).filter((a) => a && a.id && a.threadId) : [];
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Artifact index unreadable; starting a new one');
      this.items = [];
    }
    return this.items;
  }

  private save(): void {
    mkdirSync(this.root, { recursive: true });
    const tmp = `${this.indexPath}.tmp`;
    // What this change produced (each change starts from a fresh load()); never re-read in between.
    writeFileSync(tmp, JSON.stringify(this.items ?? []), { encoding: 'utf-8', mode: 0o600 });
    renameSync(tmp, this.indexPath);
    try { this.loadedAt = statSync(this.indexPath).mtimeMs; } catch { /* just written */ }
  }

  /** Keep a copy of a file as an artifact of a thread. The same file twice in a thread is one artifact. */
  add(input: { threadId: string; path: string; kind: ArtifactKind; tool?: string; surface?: 'chat' | 'code'; batch?: string; prompt?: string }, now = Date.now()): Artifact {
    const items = this.load();
    const existing = items.find((a) => a.threadId === input.threadId && a.originalPath === input.path);
    const st = statSync(input.path);
    const id = existing?.id ?? randomUUID();
    const dir = join(this.root, safe(input.threadId));
    mkdirSync(dir, { recursive: true });
    const storedPath = join(dir, `${id.slice(0, 8)}-${safe(basename(input.path))}`);
    rmSync(storedPath, { force: true });
    try { linkSync(input.path, storedPath); } catch { copyFileSync(input.path, storedPath); }
    const record: Artifact = {
      id, threadId: input.threadId, name: basename(input.path), kind: input.kind, mime: mimeOf(input.path), size: st.size,
      originalPath: input.path, storedPath, createdAt: existing?.createdAt ?? now, tool: input.tool, surface: input.surface,
      ...(input.batch ? { batch: input.batch } : {}), ...(input.prompt ? { prompt: input.prompt.slice(0, 500) } : {}),
    };
    if (existing) items.splice(items.indexOf(existing), 1);
    items.unshift(record);
    this.save();
    return record;
  }

  get(id: string): Artifact | null {
    return this.load().find((a) => a.id === id) ?? null;
  }

  /** Newest first, filtered, a page at a time (cursor = the last id seen). */
  list(query: ArtifactQuery = {}): { items: Artifact[]; nextCursor: string | null; counts: Record<string, number> } {
    const q = (query.q ?? '').trim().toLowerCase();
    const all = this.load().filter((a) => (!query.threadId || a.threadId === query.threadId) && (!q || a.name.toLowerCase().includes(q) || a.originalPath.toLowerCase().includes(q)));
    const counts: Record<string, number> = { all: all.length };
    for (const a of all) counts[a.kind] = (counts[a.kind] ?? 0) + 1;
    const filtered = !query.kind || query.kind === 'all' ? all : all.filter((a) => a.kind === query.kind);
    const start = query.cursor ? filtered.findIndex((a) => a.id === query.cursor) + 1 : 0;
    const limit = Math.min(Math.max(query.limit ?? 40, 1), 200);
    const items = filtered.slice(Math.max(0, start), Math.max(0, start) + limit);
    const more = Math.max(0, start) + limit < filtered.length;
    return { items, nextCursor: more ? items[items.length - 1]?.id ?? null : null, counts };
  }

  remove(id: string): boolean {
    return this.removeMany([id]).removed > 0;
  }

  /**
   * Delete artifacts. Mercury's copy always goes; with `originals` (the
   * folders Mercury owns), so does the original when Mercury owns it, so
   * the space really comes back (the copy is usually a hard link to it).
   */
  removeMany(ids: readonly string[], originals?: { roots: readonly string[] }): RemoveResult {
    const want = new Set(ids);
    const items = this.load();
    const gone = items.filter((a) => want.has(a.id));
    if (!gone.length) return { removed: 0, freed: 0, keptOriginals: 0 };
    let freed = 0;
    let keptOriginals = 0;
    const unlink = (path: string) => {
      const n = inode(path);
      try { rmSync(path, { force: true }); } catch { return; }
      if (n && n.links <= 1) freed += n.size;
    };
    for (const a of gone) {
      unlink(a.storedPath);
      if (!originals || !existsSync(a.originalPath)) continue;
      // The same file may be another artifact too (sent in two chats): it stays while one still needs it.
      const shared = items.some((x) => !want.has(x.id) && resolve(x.originalPath) === resolve(a.originalPath));
      if (!shared && ownsOriginal(a, originals.roots)) unlink(a.originalPath);
      else keptOriginals++;
    }
    this.items = items.filter((a) => !want.has(a.id));
    this.save();
    return { removed: gone.length, freed, keptOriginals };
  }

  /** How much space the artifacts take, and what deleting them would free. */
  usage(roots: readonly string[]): ArtifactUsage {
    const seen = new Set<string>();
    const byKind: ArtifactUsage['byKind'] = {};
    let bytes = 0;
    let freeable = 0;
    let outside = 0;
    for (const a of this.load()) {
      const k = (byKind[a.kind] ??= { count: 0, bytes: 0 });
      k.count++;
      const owned = ownsOriginal(a, roots);
      if (!owned && existsSync(a.originalPath)) outside++;
      const files = [inode(a.storedPath), owned ? inode(a.originalPath) : null];
      for (const f of files) {
        if (!f || seen.has(f.key)) continue;
        seen.add(f.key);
        bytes += f.size;
        k.bytes += f.size;
        // Freed only when no link survives: the copy and an owned original are both deleted;
        // a copy linked to a project file Mercury keeps frees nothing.
        const linkedOutside = !owned && f === files[0] && f.links > 1;
        if (!linkedOutside) freeable += f.size;
      }
    }
    return { count: this.load().length, bytes, byKind, freeable, outside };
  }

  /** Every record, newest first (not paged: for sweeps over all of them). */
  all(): Artifact[] {
    return [...this.load()];
  }

  /** The owner's file moved (tidied into the output folder): remember where it is now. */
  relocate(id: string, originalPath: string): Artifact | null {
    const a = this.load().find((x) => x.id === id);
    if (!a) return null;
    a.originalPath = originalPath;
    a.name = basename(originalPath);
    this.save();
    return a;
  }

  /** The thread was deleted: its artifacts go too (Mercury's copies; the owner's originals stay). */
  removeThread(threadId: string): number {
    const items = this.load();
    const gone = items.filter((a) => a.threadId === threadId);
    if (!gone.length) return 0;
    this.items = items.filter((a) => a.threadId !== threadId);
    rmSync(join(this.root, safe(threadId)), { recursive: true, force: true });
    this.save();
    return gone.length;
  }

  /** Drop artifacts of threads that no longer exist, and records whose copy is missing. */
  reconcile(threadExists: (id: string) => boolean): number {
    const items = this.load();
    let removed = 0;
    for (const thread of new Set(items.map((a) => a.threadId))) {
      if (!threadExists(thread)) removed += this.removeThread(thread);
    }
    const left = this.load();
    const missing = left.filter((a) => !existsSync(a.storedPath));
    if (missing.length) {
      this.items = left.filter((a) => existsSync(a.storedPath));
      this.save();
      removed += missing.length;
    }
    return removed;
  }
}

function safe(s: string): string {
  return s.replace(/[^\w.-]+/g, '_').slice(0, 120) || 'file';
}

let shared: ArtifactStore | null = null;
export function artifactStore(): ArtifactStore {
  shared ??= new ArtifactStore();
  return shared;
}
