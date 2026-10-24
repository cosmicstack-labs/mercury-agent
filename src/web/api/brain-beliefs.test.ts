import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDefaultConfig } from '../../utils/config.js';
import { SecondBrainDB, isBetterSqlite3Available } from '../../memory/second-brain-db.js';
import { UserMemoryStore } from '../../memory/user-memory.js';
import app, { setUserMemory } from './brain.js';

/**
 * Owner Model (ADR-026) dashboard API — handlers tested directly via the
 * module's own Hono app, like bots.test.ts. Covers the belief views and verbs,
 * the quarantine review queue, and the fixed GET /api/brain/memory/:id.
 */

const sqliteAvailable = isBetterSqlite3Available();
let root: string;
let mem: UserMemoryStore;
const DAY = 86_400_000;

/** The loose JSON shape the handlers return: enough typing for the assertions, no `any`. */
interface BeliefJson { id: string; status: string; statement: string; confidence: number; ownerStated: boolean; evidence: Array<{ excerpt: string }> }
interface MemoryJson { id: string; scope: string; summary: string }
interface Body {
  available?: boolean; success?: boolean; error?: string; total?: number; days?: number;
  beliefs: BeliefJson[]; pairs: Array<{ a: BeliefJson; b: BeliefJson | null }>; memories: MemoryJson[];
  counts: Record<string, number>; belief: BeliefJson; replaced: BeliefJson; winner: BeliefJson; loser: BeliefJson;
  forgotten: string; memory: MemoryJson | null; summary: string;
  // GET /api/brain/beliefs/:id spreads the belief itself into the body.
  statement: string; evidence: Array<{ excerpt: string }>;
}
const jreq = (res: Response) => res.json() as Promise<Body>;
const post = (path: string, body?: unknown) =>
  app.request(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined, headers: { 'Content-Type': 'application/json' } });

/** Seed one legacy junk row before the store opens, so the migration quarantines it. */
function seedLegacy(dbPath: string): string {
  const db = new SecondBrainDB(dbPath);
  db.init();
  const now = Date.now();
  const id = 'legacy-junk-1';
  db.insert({
    id, user_key: 'user:owner', type: 'preference', categories: '["general"]', shareable: 0,
    summary: "I can help you with that whenever you'd like, just say the word", detail: null, scope: 'durable',
    evidence_kind: 'inferred', source: 'conversation', confidence: 0.75, importance: 0.5, durability: 0.8,
    evidence_count: 1, provenance: null, dismissed: 0, superseded_by: null,
    created_at: now, updated_at: now, last_seen_at: now, last_used_at: null, last_used_query: null,
  });
  db.insert({
    id: 'legacy-real-1', user_key: 'user:owner', type: 'preference', categories: '["general"]', shareable: 0,
    summary: 'User prefers dark mode in every editor', detail: null, scope: 'durable',
    evidence_kind: 'direct', source: 'conversation', confidence: 0.9, importance: 0.7, durability: 0.9,
    evidence_count: 2, provenance: null, dismissed: 0, superseded_by: null,
    created_at: now, updated_at: now, last_seen_at: now, last_used_at: null, last_used_query: null,
  });
  db.close();
  return id;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mercury-web-beliefs-'));
  const dbPath = join(root, 'sb.db');
  seedLegacy(dbPath);
  mem = new UserMemoryStore(getDefaultConfig(), 'user:owner', dbPath);
  setUserMemory(mem);
});

afterEach(() => {
  setUserMemory(null);
  mem.close();
  rmSync(root, { recursive: true, force: true });
});

function held(statement: string, excerpt: string, at = Date.now()) {
  const r = mem.beliefs.apply({ op: 'create', kind: 'preference', statement, excerpt, sessionId: 's1' }, at)!;
  mem.beliefs.apply({ op: 'support', beliefId: r.belief.id, excerpt, sessionId: 's2' }, at + 1);
  return mem.beliefs.get(r.belief.id)!;
}

describe.skipIf(!sqliteAvailable)('web brain API — beliefs (ADR-026)', () => {
  it('GET /api/brain/beliefs lists with confidence, counts and filters', async () => {
    const b = held('Prefers one command over many manual steps', 'just run pandoc');
    const all = await jreq(await app.request('/api/brain/beliefs'));
    expect(all.available).toBe(true);
    const row = all.beliefs.find((x) => x.id === b.id)!;
    expect(row.status).toBe('held');
    expect(row.confidence).toBeGreaterThan(0.5);
    expect(all.counts.held).toBeGreaterThanOrEqual(1);
    const none = await jreq(await app.request('/api/brain/beliefs?status=contested'));
    expect(none.beliefs).toEqual([]);
    const prefs = await jreq(await app.request('/api/brain/beliefs?kind=preference&status=held,confirmed'));
    expect(prefs.beliefs.some((x) => x.id === b.id)).toBe(true);
  });

  it('GET /api/brain/beliefs/learned?days= returns recent beliefs with their latest evidence', async () => {
    const old = held('Likes short replies', 'keep it short');
    const recent = held('Prefers dark mode', 'dark mode please');
    // The store stamps updated_at with the wall clock; back-date the old one through a second connection.
    const side = new SecondBrainDB(join(root, 'sb.db'));
    side.init();
    side.connection.prepare('UPDATE beliefs SET updated_at = ? WHERE id = ?').run(Date.now() - 10 * DAY, old.id);
    side.close();
    const r3 = await jreq(await app.request('/api/brain/beliefs/learned?days=3'));
    expect(r3.days).toBe(3);
    const ids3 = r3.beliefs.map((x) => x.id);
    expect(ids3).toContain(recent.id);
    expect(ids3).not.toContain(old.id);
    expect(r3.beliefs.find((x) => x.id === recent.id)!.evidence[0].excerpt).toBe('dark mode please');
    const r30 = await jreq(await app.request('/api/brain/beliefs/learned?days=30'));
    const ids30 = r30.beliefs.map((x) => x.id);
    expect(ids30).toContain(old.id);
    expect(ids30).toContain(recent.id);
  });

  it('GET /api/brain/beliefs/:id returns the belief with evidence; 404 when unknown', async () => {
    const b = held('Works at Cosmic Stack', 'cosmic stack');
    const res = await app.request(`/api/brain/beliefs/${b.id}`);
    expect(res.status).toBe(200);
    const body = await jreq(res);
    expect(body.statement).toBe('Works at Cosmic Stack');
    expect(body.evidence.length).toBeGreaterThanOrEqual(2);
    expect((await app.request('/api/brain/beliefs/nope')).status).toBe(404);
  });

  it('confirm, forget and correct verbs change the store', async () => {
    const a = held('Prefers dark mode', 'dark');
    const b = held('Likes bullet lists', 'bullets');
    const c = held('Works mostly in Python', 'python');

    const confirmed = await jreq(await post(`/api/brain/beliefs/${a.id}/confirm`));
    expect(confirmed.belief.status).toBe('confirmed');
    expect(mem.beliefs.get(a.id)!.ownerStated).toBe(true);

    const forgotten = await jreq(await post(`/api/brain/beliefs/${b.id}/forget`));
    expect(forgotten).toEqual({ success: true, forgotten: 'Likes bullet lists' });
    expect(mem.beliefs.get(b.id)!.status).toBe('forgotten');

    expect((await post(`/api/brain/beliefs/${c.id}/correct`, { statement: '' })).status).toBe(400);
    const corrected = await jreq(await post(`/api/brain/beliefs/${c.id}/correct`, { statement: 'Works mostly in TypeScript' }));
    expect(corrected.replaced.id).toBe(c.id);
    expect(corrected.replaced.status).toBe('retired');
    expect(corrected.belief.statement).toBe('Works mostly in TypeScript');
    expect(corrected.belief.status).toBe('confirmed');

    expect((await post('/api/brain/beliefs/nope/confirm')).status).toBe(404);
    expect((await post('/api/brain/beliefs/nope/forget')).status).toBe(404);
  });

  it('contested pairs are listed and settle confirms the winner, retires the loser', async () => {
    const now = Date.now();
    const a = mem.beliefs.apply({ op: 'create', kind: 'trait', dimension: 'autonomy', level: 'just-do-it', statement: 'Just runs things', excerpt: 'go', sessionId: 's1' }, now)!;
    mem.beliefs.apply({ op: 'support', beliefId: a.belief.id, excerpt: 'go on', sessionId: 's2' }, now + 1);
    const b = mem.beliefs.apply({ op: 'create', kind: 'trait', dimension: 'autonomy', level: 'ask-first', statement: 'Wants to be asked first', excerpt: 'ask', sessionId: 's3' }, now + 2)!;
    const list = await jreq(await app.request('/api/brain/beliefs/contested'));
    expect(list.total).toBe(1);
    expect([list.pairs[0].a.id, list.pairs[0].b!.id].sort()).toEqual([a.belief.id, b.belief.id].sort());

    expect((await post('/api/brain/beliefs/settle', { winnerId: a.belief.id })).status).toBe(400);
    const settled = await jreq(await post('/api/brain/beliefs/settle', { winnerId: b.belief.id, loserId: a.belief.id }));
    expect(settled.winner.status).toBe('confirmed');
    expect(settled.loser.status).toBe('retired');
    expect((await jreq(await app.request('/api/brain/beliefs/contested'))).total).toBe(0);
  });

  it('quarantine lists the migration junk and restore brings a row back as durable', async () => {
    const q = await jreq(await app.request('/api/brain/quarantine'));
    expect(q.total).toBe(1);
    expect(q.memories[0].id).toBe('legacy-junk-1');
    expect(q.memories[0].scope).toBe('quarantine');
    // The real row was converted into a held belief, not quarantined.
    expect(mem.beliefs.list().some((b) => b.statement === 'User prefers dark mode in every editor')).toBe(true);

    expect((await post('/api/brain/quarantine/nope/restore')).status).toBe(404);
    const restored = await jreq(await post('/api/brain/quarantine/legacy-junk-1/restore'));
    expect(restored.success).toBe(true);
    expect(restored.memory!.scope).toBe('durable');
    expect((await jreq(await app.request('/api/brain/quarantine'))).total).toBe(0);
    // Restored rows become beliefs the owner vouched for (new id, confirmed, never decays).
    expect(restored.memory!.id).not.toBe('legacy-junk-1');
    expect(mem.getRecent(50).some((m) => m.id === restored.memory!.id)).toBe(true);
    expect(mem.beliefs.get(restored.memory!.id)?.status).toBe('confirmed');
  });

  it('GET /api/brain/memory/:id looks the row up by id, not by text search', async () => {
    const res = await app.request('/api/brain/memory/legacy-real-1');
    expect(res.status).toBe(200);
    expect((await jreq(res)).summary).toBe('User prefers dark mode in every editor');
    expect((await app.request('/api/brain/memory/does-not-exist')).status).toBe(404);
  });
});
