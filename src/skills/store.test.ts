import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillStore, INDEX_FILENAME } from './store.js';
import { RegistryClient } from './registry.js';

function makeFakeRegistry(opts: {
  bodyById?: Record<string, string>;
  detailById?: Record<string, any>;
  notFound?: string[];
} = {}): RegistryClient {
  const defaultBody = '# Prompt Engineering\n\nBody content.\n';
  const fakeFetch: typeof fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    // Detail endpoint — we no longer hit /install at all (the live registry
    // serves a tar.gz there). The detail JSON carries the raw markdown body
    // and all frontmatter fields we need.
    if (url.includes('/api/skills/') && !url.endsWith('/install')) {
      const id = url.replace(/.*\/api\/skills\/([^/]+\/[^/]+)$/, '$1');
      if (opts.notFound?.includes(id)) return new Response('', { status: 404 });
      const body = opts.bodyById?.[id] ?? defaultBody;
      const detail = opts.detailById?.[id] ?? {
        id,
        name: id.split('/')[1],
        title: 'Prompt Engineering',
        description: 'Patterns...',
        category: 'AI / ML',
        categorySlug: 'ai-ml',
        tags: ['llm'],
        version: '1.0.0',
        body,
      };
      return new Response(JSON.stringify(detail), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('', { status: 404 });
  };
  return new RegistryClient({ registry: 'https://example.test', fetchImpl: fakeFetch, cacheDir: mkdtempSync(join(tmpdir(), 'mercury-cache-')) });
}

describe('SkillStore — path traversal guard', () => {
  let dir: string;
  let store: SkillStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mercury-skills-'));
    store = new SkillStore({ installRoot: dir });
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('rejects ids without exactly one slash', () => {
    expect(() => store.pathFor('foo')).toThrow();
    expect(() => store.pathFor('foo/bar/baz')).toThrow();
  });

  it('rejects ids with traversal characters', () => {
    expect(() => store.pathFor('../etc/passwd')).toThrow();
    expect(() => store.pathFor('foo/..')).toThrow();
    expect(() => store.pathFor('FOO/BAR')).toThrow(); // uppercase
    expect(() => store.pathFor('foo bar/baz')).toThrow();
    expect(() => store.pathFor('foo/bar.md')).toThrow();
  });

  it('accepts well-formed ids and pins them under installRoot', () => {
    const p = store.pathFor('ai-ml/prompt-engineering');
    expect(p.startsWith(dir)).toBe(true);
    expect(p.endsWith('SKILL.md')).toBe(true);
  });
});

describe('SkillStore — install lifecycle', () => {
  let dir: string;
  let store: SkillStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mercury-skills-'));
    store = new SkillStore({ installRoot: dir });
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('installs a skill atomically and updates the index', async () => {
    const reg = makeFakeRegistry();
    const r = await store.install('ai-ml/prompt-engineering', { registry: reg });
    expect(r.status).toBe('installed');
    expect(existsSync(r.path)).toBe(true);
    // The store reconstructs SKILL.md from the registry detail payload.
    const written = readFileSync(r.path, 'utf-8');
    expect(written.startsWith('---\n')).toBe(true);
    expect(written).toMatch(/name: prompt-engineering/);
    expect(written).toMatch(/# Prompt Engineering/);
    const idx = JSON.parse(readFileSync(join(dir, INDEX_FILENAME), 'utf-8'));
    expect(idx.skills['ai-ml/prompt-engineering'].version).toBe('1.0.0');
  });

  it('is a no-op when same version already installed', async () => {
    const reg = makeFakeRegistry();
    await store.install('ai-ml/prompt-engineering', { registry: reg });
    const r2 = await store.install('ai-ml/prompt-engineering', { registry: reg });
    expect(r2.status).toBe('already-installed');
  });

  it('re-downloads with force=true', async () => {
    const reg = makeFakeRegistry();
    await store.install('ai-ml/prompt-engineering', { registry: reg });
    const r2 = await store.install('ai-ml/prompt-engineering', { registry: reg, force: true });
    expect(r2.status).toBe('reinstalled');
  });

  it('rejects when the registry returns no markdown body', async () => {
    const fakeFetch: typeof fetch = async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.endsWith('/api/skills/ai-ml/prompt-engineering')) {
        return new Response(JSON.stringify({
          id: 'ai-ml/prompt-engineering',
          name: 'prompt-engineering',
          version: '1.0.0',
          // body intentionally omitted
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('', { status: 404 });
    };
    const reg = new RegistryClient({ registry: 'https://example.test', fetchImpl: fakeFetch, cacheDir: mkdtempSync(join(tmpdir(), 'mercury-cache-')) });
    await expect(store.install('ai-ml/prompt-engineering', { registry: reg })).rejects.toThrow(/no markdown body/i);
    expect(store.isInstalled('ai-ml/prompt-engineering')).toBe(false);
  });

  it('returns a clear error for registry 404', async () => {
    const reg = makeFakeRegistry({ notFound: ['ai-ml/does-not-exist'] });
    await expect(store.install('ai-ml/does-not-exist', { registry: reg })).rejects.toThrow(/not found/i);
  });

  it('removes a skill and prunes the index', async () => {
    const reg = makeFakeRegistry();
    const r = await store.install('ai-ml/prompt-engineering', { registry: reg });
    expect(existsSync(r.path)).toBe(true);
    expect(store.remove('ai-ml/prompt-engineering')).toBe(true);
    expect(existsSync(r.path)).toBe(false);
    expect(store.isInstalled('ai-ml/prompt-engineering')).toBe(false);
  });

  it('remove() returns false for skills not in the index', () => {
    expect(store.remove('ai-ml/nope')).toBe(false);
  });

  it('list() reads from the index', async () => {
    const reg = makeFakeRegistry();
    await store.install('ai-ml/prompt-engineering', { registry: reg });
    const items = store.list();
    expect(items.length).toBe(1);
    expect(items[0].id).toBe('ai-ml/prompt-engineering');
    expect(items[0].version).toBe('1.0.0');
  });

  it('installFromBody supports advanced --from installs', () => {
    const body = `---
name: prompt-engineering
id: ai-ml/prompt-engineering
title: Prompt Engineering
description: Patterns for designing reliable LLM prompts.
version: 1.0.0
---

# Prompt Engineering

Body content.
`;
    const r = store.installFromBody(body, { source: 'file:/tmp/SKILL.md' });
    expect(r.id).toBe('ai-ml/prompt-engineering');
    expect(existsSync(r.path)).toBe(true);
  });

  it('health() reports orphans when files are missing under the index', async () => {
    const reg = makeFakeRegistry();
    const r = await store.install('ai-ml/prompt-engineering', { registry: reg });
    rmSync(r.path);
    const h = store.health();
    expect(h.orphaned).toContain('ai-ml/prompt-engineering');
  });
});

describe('SkillStore — index rollback', () => {
  it('does not write index when frontmatter verification fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mercury-skills-'));
    try {
      const store = new SkillStore({ installRoot: dir });
      const fakeFetch: typeof fetch = async () => new Response(JSON.stringify({
        id: 'ai-ml/prompt-engineering',
        // name and body both missing → buildSkillMd will still try, body check will fail first
      }), { status: 200, headers: { 'content-type': 'application/json' } });
      const reg = new RegistryClient({ registry: 'https://example.test', fetchImpl: fakeFetch, cacheDir: mkdtempSync(join(tmpdir(), 'mercury-cache-')) });
      await expect(store.install('ai-ml/prompt-engineering', { registry: reg })).rejects.toThrow();
      expect(existsSync(join(dir, INDEX_FILENAME))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('RegistryClient — feed caching', () => {
  it('caches and reuses the feed within TTL', async () => {
    let calls = 0;
    const cacheDir = mkdtempSync(join(tmpdir(), 'mercury-cache-'));
    const fakeFetch: typeof fetch = async () => {
      calls++;
      return new Response(JSON.stringify({ skills: [], categories: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const reg = new RegistryClient({
      registry: 'https://example.test',
      fetchImpl: fakeFetch,
      cacheDir,
      cacheTtlSeconds: 600,
    });
    await reg.getFeed();
    await reg.getFeed();
    expect(calls).toBe(1);
    rmSync(cacheDir, { recursive: true, force: true });
  });
});
