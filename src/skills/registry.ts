/**
 * Registry client for skills.mercuryagent.sh.
 *
 * Read-only HTTP client; no auth. All endpoints are CDN-cached JSON / markdown.
 * Pure functions where possible — the only state is the on-disk feed cache.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '../utils/logger.js';

export const DEFAULT_REGISTRY = 'https://skills.mercuryagent.sh';
export const DEFAULT_CACHE_TTL_SECONDS = 600;

export interface RegistrySkillSummary {
  id: string;                 // "<category>/<slug>"
  title: string;
  description: string;
  category: string;           // human label, e.g. "AI / ML"
  categorySlug: string;
  tags: string[];
  version: string;
  author?: string;
  githubUrl?: string;
}

export interface RegistryCategory {
  slug: string;
  name: string;
  count: number;
}

export interface RegistryFeed {
  skills: RegistrySkillSummary[];
  categories: RegistryCategory[];
  generatedAt?: string;
}

export interface RegistrySkillDetail extends RegistrySkillSummary {
  /** Raw markdown body (no frontmatter). The registry returns this on the detail endpoint. */
  body?: string;
  /** Some metadata fields are only present on the detail payload. */
  name?: string;
  slug?: string;
  installCommand?: string;
  updatedAt?: string;
}

export class RegistryError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly id?: string,
  ) {
    super(message);
    this.name = 'RegistryError';
  }
}

export interface RegistryClientOptions {
  registry?: string;
  cacheDir?: string;
  cacheTtlSeconds?: number;
  fetchImpl?: typeof fetch;
}

interface CachedFeed {
  fetchedAt: number;          // epoch ms
  etag?: string;
  feed: RegistryFeed;
}

const ID_RE = /^[a-z0-9-]+\/[a-z0-9-]+$/;

export function isValidSkillId(id: string): boolean {
  return ID_RE.test(id);
}

export function assertValidSkillId(id: string): void {
  if (!isValidSkillId(id)) {
    throw new RegistryError(
      `Invalid skill id "${id}". Expected "<category-slug>/<skill-slug>" (lowercase, hyphens, digits).`,
      undefined,
      id,
    );
  }
}

export class RegistryClient {
  readonly registryUrl: string;
  readonly cacheDir: string;
  readonly cacheTtlMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly feedCachePath: string;

  constructor(opts: RegistryClientOptions = {}) {
    this.registryUrl = (opts.registry || DEFAULT_REGISTRY).replace(/\/$/, '');
    this.cacheDir = opts.cacheDir || join(homedir(), '.mercury', 'cache');
    this.cacheTtlMs = (opts.cacheTtlSeconds ?? DEFAULT_CACHE_TTL_SECONDS) * 1000;
    this.fetchImpl = opts.fetchImpl || ((globalThis.fetch as typeof fetch));
    this.feedCachePath = join(this.cacheDir, 'registry-feed.json');
  }

  /** Fetch (or read from cache) the full registry feed. */
  async getFeed(force = false): Promise<RegistryFeed> {
    const cached = this.readFeedCache();
    const now = Date.now();
    if (!force && cached && now - cached.fetchedAt < this.cacheTtlMs) {
      return cached.feed;
    }

    const headers: Record<string, string> = { accept: 'application/json' };
    if (cached?.etag) headers['if-none-match'] = cached.etag;

    const url = `${this.registryUrl}/api/feed.json`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers });
    } catch (err: any) {
      if (cached) {
        logger.warn({ err: err?.message, url }, 'registry feed fetch failed; using stale cache');
        return cached.feed;
      }
      throw new RegistryError(`Failed to reach registry at ${url}: ${err?.message || err}`);
    }

    if (res.status === 304 && cached) {
      // refresh fetchedAt to extend TTL
      this.writeFeedCache({ ...cached, fetchedAt: now });
      return cached.feed;
    }
    if (!res.ok) {
      if (cached) {
        logger.warn({ status: res.status, url }, 'registry feed non-OK; using stale cache');
        return cached.feed;
      }
      throw new RegistryError(`Registry feed request failed: ${res.status} ${res.statusText}`, res.status);
    }

    const feed = (await res.json()) as RegistryFeed;
    if (!feed || !Array.isArray(feed.skills)) {
      throw new RegistryError('Registry returned malformed feed (no skills array).');
    }
    this.writeFeedCache({
      fetchedAt: now,
      etag: res.headers.get('etag') || undefined,
      feed,
    });
    return feed;
  }

  /** Fetch metadata + body for a single skill. 404 → RegistryError with status 404. */
  async getSkill(id: string): Promise<RegistrySkillDetail> {
    assertValidSkillId(id);
    const url = `${this.registryUrl}/api/skills/${id}`;
    const res = await this.fetchImpl(url, { headers: { accept: 'application/json' } });
    if (res.status === 404) {
      throw new RegistryError(`Skill not found in registry: ${id}`, 404, id);
    }
    if (!res.ok) {
      throw new RegistryError(`Failed to fetch skill ${id}: ${res.status} ${res.statusText}`, res.status, id);
    }
    const data = (await res.json()) as RegistrySkillDetail;
    if (!data || !data.id) {
      throw new RegistryError(`Registry returned malformed payload for ${id}.`, undefined, id);
    }
    return data;
  }

  /**
   * Reconstruct a canonical SKILL.md (frontmatter + body) for a given skill.
   *
   * The registry's `/install` endpoint serves a tar.gz archive — useful for
   * mass-installs but not what we want for the single-file Mercury layout.
   * Instead we synthesize the SKILL.md from the JSON detail payload, which
   * exposes both the metadata and the raw markdown body. This produces a file
   * byte-identical (modulo YAML key ordering) to the source SKILL.md in the
   * skills repo.
   */
  async fetchSkillMarkdown(id: string): Promise<{ body: string; etag?: string }> {
    assertValidSkillId(id);
    const detail = await this.getSkill(id);
    if (typeof detail.body !== 'string' || detail.body.length === 0) {
      throw new RegistryError(`Registry returned no markdown body for ${id}.`, undefined, id);
    }
    const body = buildSkillMd(detail);
    return { body, etag: undefined };
  }

  /** Quick reachability check used by `skills doctor`. */
  async ping(): Promise<{ ok: boolean; status?: number; error?: string }> {
    try {
      const res = await this.fetchImpl(`${this.registryUrl}/api/feed.json`, {
        method: 'HEAD',
      });
      return { ok: res.ok, status: res.status };
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  webUrl(id: string): string {
    return `${this.registryUrl}/skills/${id}`;
  }

  private readFeedCache(): CachedFeed | null {
    try {
      if (!existsSync(this.feedCachePath)) return null;
      const raw = readFileSync(this.feedCachePath, 'utf-8');
      const parsed = JSON.parse(raw) as CachedFeed;
      if (!parsed?.feed?.skills) return null;
      return parsed;
    } catch (err) {
      logger.warn({ err }, 'failed to read registry feed cache');
      return null;
    }
  }

  private writeFeedCache(value: CachedFeed): void {
    try {
      if (!existsSync(this.cacheDir)) mkdirSync(this.cacheDir, { recursive: true });
      writeFileSync(this.feedCachePath, JSON.stringify(value), 'utf-8');
    } catch (err) {
      logger.warn({ err }, 'failed to write registry feed cache');
    }
  }
}

/** Score a single feed entry against a query. Higher = better. 0 = no match. */
export function scoreSkill(skill: RegistrySkillSummary, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const tokens = q.split(/\s+/).filter(Boolean);

  const title = (skill.title || '').toLowerCase();
  const desc = (skill.description || '').toLowerCase();
  const tags = (skill.tags || []).map((t) => t.toLowerCase());
  const category = (skill.category || '').toLowerCase();
  const id = (skill.id || '').toLowerCase();

  let score = 0;
  // Whole-query substring boosts
  if (title.includes(q)) score += 3;
  if (id.includes(q)) score += 2.5;
  if (tags.some((t) => t.includes(q))) score += 2;
  if (desc.includes(q)) score += 1;
  if (category.includes(q)) score += 0.5;

  // Per-token matches (helps multi-word queries)
  for (const tok of tokens) {
    if (title.includes(tok)) score += 1.5;
    if (tags.some((t) => t.includes(tok))) score += 1;
    if (desc.includes(tok)) score += 0.5;
    if (category.includes(tok)) score += 0.25;
  }
  return score;
}

export interface ScoredSkill {
  skill: RegistrySkillSummary;
  score: number;
}

export function searchFeed(feed: RegistryFeed, query: string, limit = 10): ScoredSkill[] {
  return feed.skills
    .map((skill) => ({ skill, score: scoreSkill(skill, query) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id))
    .slice(0, Math.max(1, limit));
}

/**
 * Render a canonical SKILL.md (YAML frontmatter + markdown body) from a
 * registry detail payload. Output always starts with `---\n` so it passes the
 * sentinel check enforced by SkillStore.
 */
export function buildSkillMd(detail: RegistrySkillDetail): string {
  const frontmatter: Record<string, unknown> = {};
  const name = detail.name || detail.slug || detail.id.split('/').pop();
  if (name) frontmatter.name = name;
  if (detail.title) frontmatter.title = detail.title;
  if (detail.description) frontmatter.description = detail.description;
  if (detail.categorySlug) frontmatter.category = detail.categorySlug;
  if (detail.version) frontmatter.version = detail.version;
  if (detail.author) frontmatter.author = detail.author;
  if (detail.tags && detail.tags.length > 0) frontmatter.tags = detail.tags;
  frontmatter.id = detail.id;

  const lines: string[] = ['---'];
  for (const [k, v] of Object.entries(frontmatter)) {
    if (Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const item of v) lines.push(`  - ${yamlScalar(item)}`);
    } else {
      lines.push(`${k}: ${yamlScalar(v)}`);
    }
  }
  lines.push('---');
  lines.push('');
  const body = detail.body!.replace(/\r\n/g, '\n');
  lines.push(body.endsWith('\n') ? body.slice(0, -1) : body);
  return lines.join('\n') + '\n';
}

function yamlScalar(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  // Quote if it contains characters that would be ambiguous in YAML flow scalars.
  if (/[:#\n\r"'\\]|^[\s-]|[\s]$/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}
