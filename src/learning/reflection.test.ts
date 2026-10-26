import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SecondBrainDB, isBetterSqlite3Available } from '../memory/second-brain-db.js';
import { BeliefStore } from '../memory/beliefs.js';
import type { Session, SessionMessage } from '../sessions/types.js';
import {
  applyReflection, buildReflectionPrompt, collectSince, computeStatistics, formatOwnerTurns, parseReflectionOutput,
  runReflection, REFLECTION_SYSTEM_PROMPT, type ReflectionDeps,
} from './reflection.js';
import { buildOwnerSections, createOwnerSectionsMemo, parseOwnerNotes, readStoredBrief, writeOwnerFile } from './owner-brief.js';

const sqliteAvailable = isBetterSqlite3Available();
const dirs: string[] = [];
const dbs: SecondBrainDB[] = [];
const T0 = Date.UTC(2026, 9, 20, 9, 0, 0); // 2026-10-20 09:00 UTC
const HOUR = 3_600_000;

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function makeStore(): BeliefStore {
  const db = new SecondBrainDB(join(tmp('mercury-reflection-'), 'sb.db'));
  db.init();
  dbs.push(db);
  const store = new BeliefStore(db.connection, 'user:owner');
  store.init();
  return store;
}

// Close before removing: Windows refuses to unlink an open database file.
afterEach(() => {
  while (dbs.length) { try { dbs.pop()!.close(); } catch { /* already closed */ } }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

let seq = 0;
function msg(sessionId: string, role: SessionMessage['role'], content: string, at: number, extra: Partial<SessionMessage> = {}): SessionMessage {
  seq++;
  return { id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`, sessionId, role, kind: 'message', content, timestamp: at, sequence: seq, metadata: { channelType: 'cli', channelId: 'cli' }, ...extra };
}

function session(id: string, title: string, messages: SessionMessage[]): Session {
  const last = messages.at(-1)?.timestamp ?? T0;
  return { id, shortId: id.slice(0, 8), alias: id.slice(0, 4), title, titleSource: 'fallback', createdAt: messages[0]?.timestamp ?? T0, updatedAt: last, status: 'active', revision: 1, bindings: [], messages };
}

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';

function fixtureSessions(): Session[] {
  return [
    session(S1, 'Convert the epubs', [
      msg(S1, 'user', 'convert all the epubs in ~/books to markdown', T0),
      msg(S1, 'assistant', 'Done. I used pandoc on 12 files.', T0 + 60_000),
      msg(S1, 'assistant', '[Tool activity in my previous turn]\n- run_command pandoc a.epub → ok\n- run_command pandoc b.epub → ok\n- read_file ~/books/index → ok', T0 + 61_000, { kind: 'tool-call' }),
      msg(S1, 'user', 'too long, just give me the command next time', T0 + 120_000),
      msg(S1, 'user', '/memory', T0 + 130_000),
      msg(S1, 'user', 'internal prompt that must be ignored', T0 + 140_000, { metadata: { channelType: 'internal' } }),
    ]),
    session(S2, 'Deploy', [
      msg(S2, 'user', 'ship it, no need to ask me about each step in this repo', T0 + 13 * HOUR, { metadata: { channelType: 'telegram', channelId: 't1', workCwd: '/repo' } }),
      msg(S2, 'assistant', 'Shipped.', T0 + 13 * HOUR + 1000),
      msg(S2, 'user', 'no, that is not what I asked — explain why the build failed', T0 + 13 * HOUR + 60_000, { metadata: { channelType: 'telegram', channelId: 't1' } }),
      msg(S2, 'system', 'Allow all', T0 + 13 * HOUR + 70_000, { kind: 'permission' }),
    ]),
  ];
}

describe('reflection: collection and statistics', () => {
  it('collects only the owner turns since the watermark, newest first, with channel and cwd', () => {
    const c = collectSince(fixtureSessions(), 0);
    expect(c.turns.map((t) => t.content.slice(0, 12))).toEqual(['no, that is ', 'ship it, no ', 'too long, ju', 'convert all ']);
    expect(c.turns[1].channel).toBe('telegram');
    expect(c.turns[1].cwd).toBe('/repo');
    expect(c.traces).toHaveLength(1);
    expect(c.permissions).toHaveLength(1);
    // Watermark after the first session: only the second session's turns remain.
    const later = collectSince(fixtureSessions(), T0 + 200_000);
    expect(later.turns).toHaveLength(2);
    expect(later.sessions.map((s) => s.id)).toEqual([S2]);
  });

  it('computes the behavioural statistics in code', () => {
    const c = collectSince(fixtureSessions(), 0);
    const hourOf = (at: number) => new Date(at).getUTCHours();
    const s = computeStatistics(c, hourOf);
    expect(s.ownerMessages).toBe(4);
    expect(s.sessions).toHaveLength(2);
    expect(s.sessions.find((x) => x.id === S1)?.ownerMessages).toBe(2);
    const lengths = c.turns.map((t) => t.content.length).sort((a, b) => a - b);
    expect(s.medianOwnerLength).toBe(Math.round((lengths[1] + lengths[2]) / 2));
    expect(s.hourHistogram[9]).toBe(2);
    expect(s.hourHistogram[22]).toBe(2);
    expect(s.toolsUsed).toEqual({ run_command: 2, read_file: 1 });
    expect(s.corrections).toBe(2);
    expect(s.brevityAsks.shorter).toBe(1);
    expect(s.brevityAsks.longer).toBe(1);
    expect(s.permissionAnswers.always).toBe(1);
  });

  it('caps the owner turns at the token budget and truncates long turns', () => {
    const turns = Array.from({ length: 200 }, (_, i) => ({ sessionId: S1, at: T0 + i, channel: 'cli', content: 'x'.repeat(1000) }));
    const text = formatOwnerTurns(turns, 2000);
    expect(text.length).toBeLessThanOrEqual(8000);
    expect(text.split('\n').length).toBeGreaterThan(5);
    expect(text).toContain('…');
  });

  it('the prompt carries the statistics, the beliefs and the rules', () => {
    const c = collectSince(fixtureSessions(), 0);
    const p = buildReflectionPrompt({ ownerName: 'Salman', turns: c.turns, stats: computeStatistics(c, (at) => new Date(at).getUTCHours()), traits: 'id1 | brevity=terse | * | 2/0 | held', others: '', since: 0, now: T0 + 14 * HOUR });
    expect(p).toContain('Owner: Salman');
    expect(p).toContain('brevity=terse');
    expect(p).toContain('Corrections by the owner (regex, approximate): 2');
    expect(p).toContain('[2026-10-20 22:00 telegram 22222222 /repo]');
    expect(REFLECTION_SYSTEM_PROMPT).toContain('Never infer personality types');
    expect(REFLECTION_SYSTEM_PROMPT).toContain('brevity: terse | balanced | thorough');
  });
});

describe('reflection: parsing', () => {
  const known = new Set(['b1', 'b2']);

  it('rejects anything that is not a JSON object', () => {
    expect(parseReflectionOutput('Sure! Here is what I learned...', known)).toBeNull();
    expect(parseReflectionOutput('[]', known)).toBeNull();
    expect(parseReflectionOutput('{"ops": "nope"}', known)).toBeNull();
  });

  it('accepts a fenced object, drops invalid ops and unknown ids, keeps the brief', () => {
    const text = '```json\n' + JSON.stringify({
      ops: [
        { op: 'create', kind: 'trait', dimension: 'brevity', level: 'terse', statement: 'Wants short replies with the result first', excerpt: 'too long, just give me the command', context: '*' },
        { op: 'create', kind: 'trait', dimension: 'brevity', level: 'very-short', statement: 'bad level', excerpt: 'x' },
        { op: 'create', kind: 'trait', dimension: 'mbti', level: 'intj', statement: 'personality type', excerpt: 'x' },
        { op: 'create', kind: 'trait', dimension: 'risk:publishing', level: 'cautious', statement: 'Wants to be asked before anything is published', excerpt: 'never publish without asking', context: 'bogus context' },
        { op: 'support', beliefId: 'b1', excerpt: 'again', weight: 9 },
        { op: 'support', beliefId: 'zzz', excerpt: 'unknown id' },
        { op: 'create', kind: 'fact', statement: 'short', excerpt: 'x' },
        { op: 'create', kind: 'fact', statement: 'No excerpt means no evidence' },
        { op: 'owner_stated', kind: 'preference', statement: 'Wants Mercury to just act in /repo', context: 'project:/repo', excerpt: 'no need to ask me about each step in this repo' },
        { op: 'explode' },
      ],
      merges: [{ keepId: 'b1', mergeId: 'b2' }, { keepId: 'b1', mergeId: 'b1' }, { keepId: 'b1', mergeId: 'nope' }],
      contested: [{ aId: 'b1', bId: 'b2' }, { aId: 'b1', bId: 'x' }],
      brief: { about: 'Works on Mercury.', howToWork: 'Keep replies short.' },
    }) + '\n```';
    const out = parseReflectionOutput(text, known)!;
    expect(out).not.toBeNull();
    expect(out.ops.map((o) => `${o.op}:${o.dimension ?? o.beliefId ?? o.kind}`)).toEqual(['create:brevity', 'create:risk:publishing', 'support:b1', 'owner_stated:preference']);
    expect(out.ops[1].context).toBe('*');
    expect(out.ops[2].weight).toBe(2);
    expect(out.ops[3].context).toBe('project:/repo');
    expect(out.ops[3].evidenceKind).toBe('owner');
    expect(out.merges).toEqual([{ keepId: 'b1', mergeId: 'b2' }]);
    expect(out.contested).toEqual([{ aId: 'b1', bId: 'b2' }]);
    expect(out.brief).toEqual({ about: 'Works on Mercury.', howToWork: 'Keep replies short.' });
  });
});

describe.skipIf(!sqliteAvailable)('reflection: applying and the owner brief', () => {
  it('applies ops, merges, contested pairs, decay, and the brief; owner.md is written and notes are read back', async () => {
    const store = makeStore();
    const home = tmp('mercury-home-');
    // Seed: a held preference (two sessions), its near-duplicate, and two rival held traits.
    const pref = store.apply({ op: 'create', kind: 'preference', statement: 'Prefers one command over many manual steps', excerpt: 'just run pandoc', sessionId: 'a' }, T0)!;
    store.apply({ op: 'support', beliefId: pref.belief.id, excerpt: 'use the tool', sessionId: 'b' }, T0 + 1);
    const dupe = store.apply({ op: 'create', kind: 'preference', statement: 'Likes a single command that does the whole job rather than steps', excerpt: 'one command', sessionId: 'c' }, T0 + 2)!;
    const fact = store.apply({ op: 'owner_stated', kind: 'fact', statement: 'Founder of Cosmic Stack, an AI-agent lab', excerpt: 'I founded Cosmic Stack', sessionId: 'a' }, T0 + 3)!;
    const tA = store.apply({ op: 'create', kind: 'trait', dimension: 'autonomy', level: 'just-do-it', statement: 'Wants Mercury to act without asking', context: 'project:/repo', excerpt: 'ship it', sessionId: 'a' }, T0 + 4)!;
    store.apply({ op: 'support', beliefId: tA.belief.id, excerpt: 'again', sessionId: 'b' }, T0 + 5);
    expect(store.get(tA.belief.id)!.status).toBe('held');

    const scripted = {
      ops: [
        { op: 'create', kind: 'trait', dimension: 'brevity', level: 'terse', statement: 'Wants short replies that lead with the result', excerpt: 'too long, just give me the command next time', context: '*', weight: 2 },
        { op: 'support', beliefId: pref.belief.id, excerpt: 'convert all the epubs' },
        { op: 'create', kind: 'trait', dimension: 'expertise:typescript', level: 'expert', statement: 'Fluent in TypeScript', excerpt: 'vocabulary in session 1' },
      ],
      merges: [{ keepId: pref.belief.id, mergeId: dupe.belief.id }],
      contested: [],
      brief: { about: 'Founder of Cosmic Stack. Seems to prefer one command over many steps.', howToWork: 'Keep replies short; lead with the result. In /repo, just do it.' },
    };
    let seenPrompt = '';
    const deps: ReflectionDeps = {
      beliefs: store,
      sessions: { list: () => fixtureSessions() },
      providers: { getDefault: () => ({ name: 'scripted', getModel: () => 'm', getModelInstance: () => null }) },
      tokenBudget: { canAfford: () => true, recordUsage: () => {} },
      learningPaused: () => false,
      ownerName: 'Salman',
      home,
      hourOf: (at) => new Date(at).getUTCHours(),
      generate: async ({ prompt }) => { seenPrompt = prompt; return { text: JSON.stringify(scripted), usage: { inputTokens: 10, outputTokens: 5 } }; },
    };
    const r = await runReflection(deps, { now: T0 + 15 * HOUR });
    expect(r.ran).toBe(true);
    expect(r.turns).toBe(4);
    expect(r.applied).toBe(3);
    expect(r.merged).toBe(1);
    expect(r.brief).toBe(true);
    expect(seenPrompt).toContain(pref.belief.id);
    expect(seenPrompt).toContain(tA.belief.id);
    // Merge: the duplicate is retired and superseded; the keeper carries its support.
    expect(store.get(dupe.belief.id)!.status).toBe('retired');
    expect(store.get(dupe.belief.id)!.supersededBy).toBe(pref.belief.id);
    expect(store.get(pref.belief.id)!.support).toBe(4);
    // The new trait is a candidate with the scripted weight.
    const brevity = store.list({ dimension: 'brevity' })[0];
    expect(brevity.level).toBe('terse');
    expect(brevity.status).toBe('candidate');
    expect(brevity.support).toBe(2);
    // Watermark advanced to the newest owner turn; a second run has nothing new.
    expect(Number(store.getMeta('reflection_watermark'))).toBe(T0 + 13 * HOUR + 60_000);
    const again = await runReflection(deps, { now: T0 + 16 * HOUR });
    expect(again.ran).toBe(false);
    expect(again.reason).toBe('nothing-new');
    // The brief was stored and is preferred by the section builder while fresh.
    expect(readStoredBrief(store)?.about).toContain('Founder of Cosmic Stack');
    const sections = buildOwnerSections(store, 'Salman');
    expect(sections.about).toBe('Founder of Cosmic Stack. Seems to prefer one command over many steps.');
    // owner.md was written with both sections and a notes section.
    const path = join(home, 'soul', 'owner.md');
    const file = readFileSync(path, 'utf-8');
    expect(file).toContain('## About Salman');
    expect(file).toContain('## How to work with Salman');
    expect(file).toContain('## My notes');
    // The owner adds notes; the next pass reads them back as confirmed facts, once.
    writeFileSync(path, file + '- I prefer answers in British English\n- Lives in Karachi\n', 'utf-8');
    const withNotes = await runReflection(deps, { now: T0 + 17 * HOUR });
    expect(withNotes.notesApplied).toBe(2);
    const british = store.list().find((b) => /British English/.test(b.statement))!;
    expect(british.status).toBe('confirmed');
    expect(british.ownerStated).toBe(true);
    const third = await runReflection(deps, { now: T0 + 18 * HOUR });
    expect(third.notesApplied).toBe(0);
    expect(store.list().filter((b) => /British English/.test(b.statement))).toHaveLength(1);
    // The notes survive a rewrite of the file.
    expect(readFileSync(path, 'utf-8')).toContain('- Lives in Karachi');
    // A belief change after the brief makes the deterministic build win again.
    expect(buildOwnerSections(store, 'Salman').about).toContain('Lives in Karachi');
    expect(fact.belief.id).toBeTruthy();
  });

  it('does nothing on invalid model output, and skips when paused or over budget', async () => {
    const store = makeStore();
    const base: ReflectionDeps = {
      beliefs: store,
      sessions: { list: () => fixtureSessions() },
      providers: { getDefault: () => ({ name: 'scripted', getModel: () => 'm', getModelInstance: () => null }) },
      tokenBudget: { canAfford: () => true, recordUsage: () => {} },
      learningPaused: () => false,
      ownerName: 'Salman',
      home: tmp('mercury-home-'),
      generate: async () => ({ text: 'I think the owner is an INTJ.' }),
    };
    expect((await runReflection({ ...base, learningPaused: () => true })).reason).toBe('paused');
    expect((await runReflection({ ...base, tokenBudget: { canAfford: () => false, recordUsage: () => {} } })).reason).toBe('budget');
    const r = await runReflection(base, { now: T0 + 15 * HOUR });
    expect(r.ran).toBe(false);
    expect(r.reason).toBe('invalid-output');
    expect(store.list()).toHaveLength(0);
    // The turns were still consumed: no retry loop on a bad answer.
    expect(Number(store.getMeta('reflection_watermark'))).toBeGreaterThan(0);
  });

  it('contested pairs are set only when both are held; decay retires stale candidates', () => {
    const store = makeStore();
    const a = store.apply({ op: 'create', kind: 'trait', dimension: 'decision-style', level: 'options', statement: 'Wants options', context: '*', excerpt: 'give me options', sessionId: 's1' }, T0)!;
    store.apply({ op: 'support', beliefId: a.belief.id, excerpt: 'options please', sessionId: 's2' }, T0 + 1);
    const b = store.apply({ op: 'create', kind: 'trait', dimension: 'decision-style', level: 'recommendation', statement: 'Wants a recommendation', context: 'domain:infra', excerpt: 'what should I do', sessionId: 's1' }, T0 + 2)!;
    store.apply({ op: 'support', beliefId: b.belief.id, excerpt: 'just tell me', sessionId: 's2' }, T0 + 3);
    // An episode from 200 days ago (half-life 30 days) is stale; an undisputed fact would rest instead.
    const stale = store.apply({ op: 'create', kind: 'episode', statement: 'Was travelling last spring for a conference', excerpt: 'x', sessionId: 's1' }, T0 - 200 * 86_400_000)!;
    const counts = applyReflection(store, { ops: [], merges: [], contested: [{ aId: a.belief.id, bId: b.belief.id }], brief: null }, T0 + 10);
    expect(counts.contested).toBe(1);
    expect(store.get(a.belief.id)!.status).toBe('contested');
    expect(store.get(b.belief.id)!.status).toBe('contested');
    expect(counts.retired).toBe(1);
    expect(store.get(stale.belief.id)!.status).toBe('retired');
  });

  it('builds the two sections deterministically from held and confirmed beliefs, and caches on the signature', () => {
    const store = makeStore();
    store.apply({ op: 'owner_stated', kind: 'fact', statement: 'Founder of Cosmic Stack, an AI-agent lab', excerpt: 'x', sessionId: 'a' }, T0);
    store.apply({ op: 'owner_stated', kind: 'preference', statement: 'Never publish a release without asking first', excerpt: 'x', sessionId: 'a' }, T0);
    const proj = store.apply({ op: 'create', kind: 'project', statement: 'Building Mercury, an open-source personal agent', excerpt: 'x', sessionId: 'a' }, T0)!;
    store.apply({ op: 'support', beliefId: proj.belief.id, excerpt: 'y', sessionId: 'b' }, T0 + 1);
    const cand = store.apply({ op: 'create', kind: 'goal', statement: 'Wants to raise a seed round next quarter', excerpt: 'x', sessionId: 'a' }, T0)!;
    const brev = store.apply({ op: 'create', kind: 'trait', dimension: 'brevity', level: 'terse', statement: 'Wants short replies', context: '*', excerpt: 'x', sessionId: 'a' }, T0)!;
    store.apply({ op: 'support', beliefId: brev.belief.id, excerpt: 'y', sessionId: 'b' }, T0 + 1);
    store.apply({ op: 'owner_stated', kind: 'trait', dimension: 'autonomy', level: 'just-do-it', statement: 'Wants Mercury to just act in the Mercury repo', context: 'project:/Users/me/mercury', excerpt: 'x', sessionId: 'a' }, T0);
    const ts = store.apply({ op: 'create', kind: 'trait', dimension: 'expertise:typescript', level: 'expert', statement: 'Expert in TypeScript', context: '*', excerpt: 'x', sessionId: 'a' }, T0)!;
    store.apply({ op: 'support', beliefId: ts.belief.id, excerpt: 'y', sessionId: 'b' }, T0 + 1);
    const risk = store.apply({ op: 'create', kind: 'trait', dimension: 'risk:publishing', level: 'cautious', statement: 'Cautious about publishing', context: '*', excerpt: 'x', sessionId: 'a' }, T0)!;
    store.apply({ op: 'support', beliefId: risk.belief.id, excerpt: 'y', sessionId: 'b' }, T0 + 1);

    const s = buildOwnerSections(store, 'Salman', T0 + 2);
    expect(s.about).toContain('Facts:\n- Founder of Cosmic Stack, an AI-agent lab');
    expect(s.about).toContain('- Never publish a release without asking first');
    expect(s.about).toContain('- Building Mercury, an open-source personal agent — seems so, not confirmed');
    expect(s.about).not.toContain('seed round'); // candidate
    expect(s.about).not.toContain('short replies'); // traits live in the other section
    expect(s.howToWork).toContain('- Just do it in /Users/me/mercury');
    expect(s.howToWork).toContain('- Keep replies short; lead with the result and skip preamble. (observed so far)');
    expect(s.howToWork).toContain('- Expert in typescript: no explanations of basics, assume fluency. (observed so far)');
    expect(s.howToWork).toContain('- Always confirm before publishing. (observed so far)');
    expect(s.howToWork).toContain('- Never publish a release without asking first');
    expect(s.about.length).toBeLessThanOrEqual(1700);
    expect(s.howToWork.length).toBeLessThanOrEqual(1100);

    const memo = createOwnerSectionsMemo();
    const first = memo(store, 'Salman');
    expect(memo(store, 'Salman')).toBe(first);
    store.confirm(cand.belief.id);
    const second = memo(store, 'Salman');
    expect(second).not.toBe(first);
    expect(second!.about).toContain('seed round');
  });

  it('owner.md: notes are parsed from the notes section only, comments ignored', () => {
    const home = tmp('mercury-home-');
    mkdirSync(join(home, 'soul'), { recursive: true });
    const path = writeOwnerFile({ about: 'A', howToWork: 'B' }, 'Salman', { home, now: new Date(T0) });
    const text = readFileSync(path, 'utf-8');
    expect(text).toContain('Generated by Mercury from its beliefs');
    expect(parseOwnerNotes(text)).toEqual([]);
    expect(parseOwnerNotes(text + '- I run on a Mac\n\n* Kids: two\n<!-- hidden -->\n## Something else\n- not a note\n')).toEqual(['I run on a Mac', 'Kids: two']);
    expect(parseOwnerNotes('no notes heading here')).toEqual([]);
  });
});
