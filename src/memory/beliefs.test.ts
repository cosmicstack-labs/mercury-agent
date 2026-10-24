import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SecondBrainDB, isBetterSqlite3Available } from './second-brain-db.js';
import { BeliefStore, RETIRE_BELOW, ftsMatch, isLegacyJunk } from './beliefs.js';

const sqliteAvailable = isBetterSqlite3Available();
const dirs: string[] = [];
const dbs: SecondBrainDB[] = [];
const DAY = 86_400_000;

function make(): { store: BeliefStore; db: SecondBrainDB } {
  const dir = mkdtempSync(join(tmpdir(), 'mercury-beliefs-'));
  dirs.push(dir);
  const db = new SecondBrainDB(join(dir, 'sb.db'));
  db.init();
  dbs.push(db);
  const store = new BeliefStore(db.connection, 'user:owner');
  store.init();
  return { store, db };
}

// Close before removing: Windows refuses to unlink an open database file.
afterEach(() => {
  while (dbs.length) { try { dbs.pop()!.close(); } catch { /* already closed */ } }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe.skipIf(!sqliteAvailable)('BeliefStore', () => {
  it('a belief starts as a candidate and is held after support from two sessions', () => {
    const { store } = make();
    const t0 = Date.now();
    const r1 = store.apply({ op: 'create', kind: 'preference', statement: 'Prefers one command over many manual steps', excerpt: 'just run pandoc', sessionId: 's1' }, t0)!;
    expect(r1.change).toBe('created');
    expect(r1.belief.status).toBe('candidate');
    expect(store.usable(t0)).toHaveLength(0);
    // Same session again: supported, still a candidate.
    const r2 = store.apply({ op: 'support', beliefId: r1.belief.id, excerpt: 'again', sessionId: 's1' }, t0 + 1000)!;
    expect(r2.belief.status).toBe('candidate');
    // A second session: now held, and behaviour-changing because it's a preference.
    const r3 = store.apply({ op: 'support', beliefId: r1.belief.id, excerpt: 'use the tool', sessionId: 's2' }, t0 + 2000)!;
    expect(r3.change).toBe('now-held');
    expect(r3.behaviorChanging).toBe(true);
    expect(store.usable(t0 + 2000).map((b) => b.id)).toEqual([r1.belief.id]);
  });

  it('creating the same claim again supports instead of duplicating', () => {
    const { store } = make();
    const a = store.apply({ op: 'create', kind: 'fact', statement: 'User works at Cosmic Stack', excerpt: 'x', sessionId: 's1' })!;
    const b = store.apply({ op: 'create', kind: 'fact', statement: 'The user works at Cosmic Stack.', excerpt: 'y', sessionId: 's2' })!;
    expect(b.belief.id).toBe(a.belief.id);
    expect(b.change).toBe('now-held');
    expect(store.list()).toHaveLength(1);
  });

  it('what the owner said is confirmed at once and does not decay', () => {
    const { store } = make();
    const t0 = Date.now();
    const r = store.apply({ op: 'owner_stated', kind: 'preference', statement: 'Always ask before publishing anything', excerpt: 'never publish without asking', sessionId: 's1' }, t0)!;
    expect(r.belief.status).toBe('confirmed');
    expect(r.behaviorChanging).toBe(true);
    expect(store.confidence(r.belief, t0 + 400 * DAY)).toBeGreaterThan(0.8);
    // Counter-evidence is logged but does not unseat the owner's word.
    const c = store.apply({ op: 'contradict', beliefId: r.belief.id, excerpt: 'published without asking once', weight: 2 }, t0 + 1)!;
    expect(c.belief.status).toBe('confirmed');
    expect(store.evidenceFor(r.belief.id)).toHaveLength(2);
  });

  it('inferred beliefs decay and retire unless re-supported', () => {
    const { store } = make();
    const t0 = Date.now();
    const r = store.apply({ op: 'create', kind: 'trait', dimension: 'brevity', level: 'terse', statement: 'Prefers short replies', excerpt: 'shorter', sessionId: 's1' }, t0)!;
    store.apply({ op: 'support', beliefId: r.belief.id, excerpt: 'tl;dr', sessionId: 's2' }, t0 + 1);
    const fresh = store.confidence(store.get(r.belief.id)!, t0 + 1);
    const later = store.confidence(store.get(r.belief.id)!, t0 + 130 * DAY);
    expect(later).toBeLessThan(fresh);
    expect(later).toBeLessThan(RETIRE_BELOW);
    expect(store.decayPass(t0 + 130 * DAY)).toBe(1);
    expect(store.get(r.belief.id)!.status).toBe('retired');
    expect(store.get(r.belief.id)!.validTo).not.toBeNull();
    // Re-supported: comes back.
    store.apply({ op: 'support', beliefId: r.belief.id, excerpt: 'keep it short', sessionId: 's3' }, t0 + 131 * DAY);
    expect(store.get(r.belief.id)!.status).toBe('held');
  });

  it('an undisputed fact rests for a long time instead of being retired', () => {
    const { store } = make();
    const t0 = Date.now();
    const r = store.apply({ op: 'create', kind: 'fact', statement: 'User is named Salman Qureshi', excerpt: 'x', sessionId: 's1' }, t0)!;
    expect(store.decayPass(t0 + 200 * DAY)).toBe(0);
    expect(store.get(r.belief.id)!.status).toBe('candidate');
    expect(store.confidence(store.get(r.belief.id)!, t0 + 200 * DAY)).toBeGreaterThan(RETIRE_BELOW);
  });

  it('a correction retires the old belief and holds the replacement as owner-stated', () => {
    const { store } = make();
    const old = store.apply({ op: 'create', kind: 'preference', statement: 'Prefers detailed explanations', excerpt: 'x', sessionId: 's1' })!;
    store.apply({ op: 'support', beliefId: old.belief.id, excerpt: 'y', sessionId: 's2' });
    const r = store.apply({ op: 'correction', beliefId: old.belief.id, statement: 'Prefers short answers; asks for detail when wanted', excerpt: "no, I didn't ask for an essay", sessionId: 's3' })!;
    expect(r.change).toBe('replaced');
    expect(r.replaced!.status).toBe('retired');
    expect(r.replaced!.supersededBy).toBe(r.belief.id);
    expect(r.belief.status).toBe('confirmed');
    expect(r.belief.ownerStated).toBe(true);
    expect(store.usable().map((b) => b.id)).toEqual([r.belief.id]);
  });

  it('two held trait levels on the same dimension and context become contested; the owner settles it', () => {
    const { store } = make();
    const terse = store.apply({ op: 'create', kind: 'trait', dimension: 'brevity', level: 'terse', statement: 'Wants short replies', excerpt: 'a', sessionId: 's1' })!;
    store.apply({ op: 'support', beliefId: terse.belief.id, excerpt: 'b', sessionId: 's2' });
    expect(store.get(terse.belief.id)!.status).toBe('held');
    const thorough = store.apply({ op: 'create', kind: 'trait', dimension: 'brevity', level: 'thorough', statement: 'Wants thorough replies', excerpt: 'c', sessionId: 's3' })!;
    expect(store.get(terse.belief.id)!.status).toBe('contested');
    expect(store.get(thorough.belief.id)!.status).toBe('contested');
    expect(store.usable()).toHaveLength(0);
    expect(store.contested()).toHaveLength(1);
    store.settle(terse.belief.id, thorough.belief.id);
    expect(store.get(terse.belief.id)!.status).toBe('confirmed');
    expect(store.get(thorough.belief.id)!.status).toBe('retired');
    expect(store.contested()).toHaveLength(0);
  });

  it('the same trait in a different context is not a contradiction', () => {
    const { store } = make();
    const a = store.apply({ op: 'create', kind: 'trait', dimension: 'autonomy', level: 'just-do-it', statement: 'Just runs things in own repos', context: 'project:/repo', excerpt: 'a', sessionId: 's1' })!;
    store.apply({ op: 'support', beliefId: a.belief.id, excerpt: 'b', sessionId: 's2' });
    const b = store.apply({ op: 'create', kind: 'trait', dimension: 'autonomy', level: 'ask-first', statement: 'Wants to be asked before publishing', context: 'domain:publishing', excerpt: 'c', sessionId: 's3' })!;
    expect(store.get(a.belief.id)!.status).toBe('held');
    expect(store.get(b.belief.id)!.status).toBe('candidate');
  });

  it('forget hides a belief everywhere, for good', () => {
    const { store } = make();
    const r = store.apply({ op: 'owner_stated', kind: 'fact', statement: 'User lives in Srinagar', excerpt: 'x' })!;
    expect(store.forget(r.belief.id)).toBe(true);
    expect(store.usable()).toHaveLength(0);
    expect(store.list({ statuses: ['candidate', 'held', 'confirmed', 'contested', 'retired'] })).toHaveLength(0);
    expect(store.searchRelevant('Srinagar')).toHaveLength(0);
    expect(store.recentlyLearned(0)).toHaveLength(0);
    expect(store.apply({ op: 'support', beliefId: r.belief.id, excerpt: 'again' })).toBeNull();
  });

  it('acting on a belief without objection adds weak support once per session', () => {
    const { store } = make();
    const r = store.apply({ op: 'create', kind: 'preference', statement: 'Likes a recommendation, not a menu', excerpt: 'x', sessionId: 's1' })!;
    store.actedOnOk([r.belief.id], 's9');
    store.actedOnOk([r.belief.id], 's9');
    expect(store.get(r.belief.id)!.support).toBeCloseTo(1.25);
  });

  it('search finds usable beliefs relevant to a message', () => {
    const { store } = make();
    const r = store.apply({ op: 'owner_stated', kind: 'preference', statement: 'Prefers pandoc for document conversion', excerpt: 'x' })!;
    store.apply({ op: 'create', kind: 'preference', statement: 'Candidate only: likes dark mode', excerpt: 'y' });
    const hits = store.searchRelevant('convert this epub with pandoc please');
    expect(hits.map((b) => b.id)).toEqual([r.belief.id]);
  });

  it('retrieval shows sure beliefs first and fills with candidates, and stopwords never match', () => {
    const { store } = make();
    const sure = store.apply({ op: 'owner_stated', kind: 'preference', statement: 'Prefers pandoc for document conversion', excerpt: 'x' })!;
    const maybe = store.apply({ op: 'create', kind: 'project', statement: 'Is converting the pandoc manual into an epub this week', excerpt: 'y' })!;
    const hits = store.searchRelevant('can you convert this with pandoc for me');
    expect(hits.map((b) => b.id)).toEqual([sure.belief.id, maybe.belief.id]);
    expect(hits[1].status).toBe('candidate');
    // Only stopwords: no query at all, so nothing matches rather than everything.
    expect(store.searchRelevant('what do you want me to do with this')).toEqual([]);
    expect(ftsMatch('the and for you')).toBeNull();
    expect(ftsMatch('Convert the EPUB, please — the epub!')).toBe('"convert" OR "epub"');
  });

  it('strongest() lists sure beliefs before candidates for "what do you know about me"', () => {
    const { store } = make();
    store.apply({ op: 'create', kind: 'goal', statement: 'Wants Mercury to run the launch', excerpt: 'a' });
    const sure = store.apply({ op: 'owner_stated', kind: 'fact', statement: 'Runs Cosmic Stack', excerpt: 'b' })!;
    const top = store.strongest(5);
    expect(top[0].id).toBe(sure.belief.id);
    expect(top).toHaveLength(2);
    expect(top[1].status).toBe('candidate');
  });

  it('migrates legacy memories: junk is quarantined, real ones become beliefs, and it runs once', () => {
    const { store, db } = make();
    const now = Date.now();
    const base = { user_key: 'user:owner', categories: '["general"]', shareable: 0, detail: null, scope: 'durable', source: 'conversation', importance: 0.7, durability: 0.7, provenance: null, dismissed: 0, superseded_by: null, created_at: now, updated_at: now, last_seen_at: now, last_used_at: null, last_used_query: null } as const;
    const rows = [
      { id: 'm1', type: 'preference', summary: "I appreciate the detailed instructions, but I need to clarify my actual capabilities: I'm Claude", evidence_kind: 'inferred', confidence: 0.75, evidence_count: 1 },
      { id: 'm2', type: 'preference', summary: 'Open Slack on your computer', evidence_kind: 'inferred', confidence: 0.75, evidence_count: 1 },
      { id: 'm3', type: 'preference', summary: '**Memory extracted:**', evidence_kind: 'inferred', confidence: 0.75, evidence_count: 1 },
      { id: 'm4', type: 'preference', summary: 'User prefers pragmatic, incremental implementation over full specification adoption', evidence_kind: 'inferred', confidence: 0.8, evidence_count: 1 },
      { id: 'm5', type: 'identity', summary: "User's name is Salman and he founded Cosmic Stack", evidence_kind: 'direct', confidence: 0.95, evidence_count: 1 },
      { id: 'm6', type: 'identity', summary: 'User founded Cosmic Stack, an AI agency', evidence_kind: 'direct', confidence: 0.95, evidence_count: 1 },
    ];
    for (const r of rows) db.insert({ ...base, ...r } as never);
    const first = store.migrateLegacyMemories(now);
    // m5 names the owner: identity lives in the config, so it waits in quarantine instead.
    expect(first).toEqual({ quarantined: 4, converted: 2, skipped: false });
    const quarantined = db.connection.prepare("SELECT id, provenance FROM memories WHERE scope = 'quarantine' ORDER BY id").all() as Array<{ id: string; provenance: string }>;
    expect(quarantined.map((q) => q.id)).toEqual(['m1', 'm2', 'm3', 'm5']);
    expect(quarantined.find((q) => q.id === 'm5')?.provenance).toBe('migration:identity');
    const beliefs = store.list({ statuses: ['candidate', 'held', 'confirmed'] });
    expect(beliefs.map((b) => [b.kind, b.status]).sort()).toEqual([['fact', 'candidate'], ['preference', 'candidate']]);
    expect(store.getMeta('reflection_force')).toBe('1');
    expect(store.migrateLegacyMemories(now).skipped).toBe(true);
    expect(isLegacyJunk({ summary: 'User likes interactive 3D animations in web projects', type: 'preference', evidence_kind: 'inferred', confidence: 0.85, categories: '["technical"]' })).toBe(false);
  });
});
