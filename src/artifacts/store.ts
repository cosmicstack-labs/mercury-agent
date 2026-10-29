import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
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
}

export interface ArtifactQuery { kind?: ArtifactKind | 'all'; q?: string; threadId?: string; cursor?: string; limit?: number }

export class ArtifactStore {
  private items: Artifact[] | null = null;
  constructor(readonly root = join(getMercuryHome(), 'artifacts')) {}

  private get indexPath(): string { return join(this.root, 'index.json'); }

  private load(): Artifact[] {
    if (this.items) return this.items;
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
    writeFileSync(tmp, JSON.stringify(this.load()), { encoding: 'utf-8', mode: 0o600 });
    renameSync(tmp, this.indexPath);
  }

  /** Keep a copy of a file as an artifact of a thread. The same file twice in a thread is one artifact. */
  add(input: { threadId: string; path: string; kind: ArtifactKind; tool?: string; surface?: 'chat' | 'code' }, now = Date.now()): Artifact {
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
    const items = this.load();
    const a = items.find((x) => x.id === id);
    if (!a) return false;
    rmSync(a.storedPath, { force: true });
    items.splice(items.indexOf(a), 1);
    this.save();
    return true;
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
