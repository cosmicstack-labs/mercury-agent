import { describe, expect, it } from 'vitest';
import type { Belief } from '../memory/beliefs.js';
import {
  EXTRACT_MAX_OUTPUT_TOKENS, buildSystemPrompt, buildUserPrompt, extractBeliefOperations, levelsFor, parseBeliefOperations,
  relevantBeliefs, shouldExtract, validateOperation, type ExtractDeps, type ExtractInput,
} from './extract.js';
import { collectTurnSignals } from './signals.js';

const ids = new Set(['b1', 'b2']);

function belief(partial: Partial<Belief> & Pick<Belief, 'id' | 'statement'>): Belief {
  const now = Date.now();
  return {
    ownerKey: 'user:owner', kind: 'preference', dimension: null, level: null, detail: null, context: '*', support: 2, against: 0,
    supportSessions: 2, timescale: 'stable', status: 'held', ownerStated: false, validFrom: now, validTo: null, supersededBy: null,
    lastSupportedAt: now, lastUsedAt: null, createdAt: now, updatedAt: now, shareable: false, ...partial,
  };
}

function input(overrides: Partial<ExtractInput> = {}): ExtractInput {
  const ownerMessage = overrides.ownerMessage ?? "don't ask before running tests here";
  return {
    ownerMessage,
    mercuryReply: 'Running the tests now.',
    recentTurns: [{ role: 'owner', content: 'run the tests' }, { role: 'mercury', content: 'May I run npm test?' }],
    signals: collectTurnSignals({ message: ownerMessage, cwd: '/home/o/proj', channelType: 'cli', sessionId: 's1', now: new Date(2026, 9, 24, 10, 0) }),
    ownerName: 'Salman',
    pendingQuestion: null,
    sessionId: 's1',
    turnRef: 'm1',
    ...overrides,
  };
}

describe('parseBeliefOperations', () => {
  it('returns [] for prose, invalid JSON and non-arrays (never a prose fallback)', () => {
    expect(parseBeliefOperations('The user prefers short answers.\n- likes tests', ids)).toEqual([]);
    expect(parseBeliefOperations('{"op":"create"', ids)).toEqual([]);
    expect(parseBeliefOperations('{"op":"support","beliefId":"b1","excerpt":"x"}', ids)).toEqual([]);
    expect(parseBeliefOperations('', ids)).toEqual([]);
    expect(parseBeliefOperations('null', ids)).toEqual([]);
  });

  it('accepts a fenced array and stamps session and turn', () => {
    const ops = parseBeliefOperations('```json\n[{"op":"support","beliefId":"b1","excerpt":"same as before"}]\n```', ids, { sessionId: 's1', turnRef: 'm1' });
    expect(ops).toEqual([{ op: 'support', beliefId: 'b1', excerpt: 'same as before', sessionId: 's1', turnRef: 'm1' }]);
  });

  it('drops references to unknown beliefs and ops without an excerpt', () => {
    expect(parseBeliefOperations('[{"op":"support","beliefId":"nope","excerpt":"x"}]', ids)).toEqual([]);
    expect(parseBeliefOperations('[{"op":"contradict","beliefId":"b1"}]', ids)).toEqual([]);
    expect(parseBeliefOperations('[{"op":"delete","beliefId":"b1","excerpt":"x"}]', ids)).toEqual([]);
  });

  it('validates created beliefs: kind, statement length, trait dimension and level', () => {
    const ok = validateOperation({ op: 'owner_stated', kind: 'trait', dimension: 'autonomy', level: 'just-do-it', statement: 'Wants tests run without asking in this repo', context: 'project:/home/o/proj', excerpt: "don't ask before running tests here" }, ids);
    expect(ok).toMatchObject({ op: 'owner_stated', kind: 'trait', dimension: 'autonomy', level: 'just-do-it', context: 'project:/home/o/proj', timescale: 'stable' });
    expect(validateOperation({ op: 'create', kind: 'trait', dimension: 'autonomy', level: 'always', statement: 'Wants tests run without asking', excerpt: 'x' }, ids)).toBeNull();
    expect(validateOperation({ op: 'create', kind: 'trait', dimension: 'mood', level: 'happy', statement: 'Is a happy person generally', excerpt: 'x' }, ids)).toBeNull();
    expect(validateOperation({ op: 'create', kind: 'trait', statement: 'A trait without a dimension at all', excerpt: 'x' }, ids)).toBeNull();
    expect(validateOperation({ op: 'create', kind: 'personality', statement: 'Is an INTJ according to themselves', excerpt: 'x' }, ids)).toBeNull();
    expect(validateOperation({ op: 'create', kind: 'fact', statement: 'too short', excerpt: 'x' }, ids)).toBeNull();
    expect(validateOperation({ op: 'create', kind: 'fact', statement: 'x'.repeat(221), excerpt: 'x' }, ids)).toBeNull();
    const scoped = validateOperation({ op: 'create', kind: 'trait', dimension: 'expertise:typescript', level: 'expert', statement: 'Expert in TypeScript, skips basic explanations', excerpt: 'I know TS' }, ids);
    expect(scoped).toMatchObject({ dimension: 'expertise:typescript', level: 'expert' });
    expect(levelsFor('risk:publishing')).toEqual(['cautious', 'normal', 'bold']);
    expect(levelsFor('risk:')).toBeNull();
    expect(levelsFor('unknown')).toBeNull();
  });

  it('forces situations to situational and episodes to episodic; non-traits carry no dimension', () => {
    const sit = validateOperation({ op: 'create', kind: 'situation', timescale: 'stable', statement: 'Is in a hurry to ship before the demo', excerpt: 'quick, demo in 10' }, ids);
    expect(sit).toMatchObject({ kind: 'situation', timescale: 'situational' });
    expect(sit).not.toHaveProperty('dimension');
    const ep = validateOperation({ op: 'create', kind: 'episode', dimension: 'brevity', level: 'terse', statement: 'Mercury set up the release script for proj', excerpt: 'set up releases' }, ids);
    expect(ep).toMatchObject({ kind: 'episode', timescale: 'episodic' });
    expect(ep).not.toHaveProperty('dimension');
  });

  it('truncates long excerpts and caps the number of operations', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ op: 'support', beliefId: 'b1', excerpt: `e${i} ${'y'.repeat(300)}` }));
    const ops = parseBeliefOperations(JSON.stringify(many), ids);
    expect(ops).toHaveLength(5);
    expect(ops[0].excerpt.length).toBe(200);
  });

  it('validates corrections with and without a replacement statement', () => {
    expect(validateOperation({ op: 'correction', beliefId: 'b2', excerpt: 'no, shorter' }, ids)).toEqual({ op: 'correction', beliefId: 'b2', excerpt: 'no, shorter' });
    expect(validateOperation({ op: 'correction', beliefId: 'b2', statement: 'Wants replies kept to a few lines', dimension: 'brevity', level: 'terse', excerpt: 'shorter please' }, ids))
      .toMatchObject({ op: 'correction', beliefId: 'b2', statement: 'Wants replies kept to a few lines', dimension: 'brevity', level: 'terse' });
    expect(validateOperation({ op: 'correction', beliefId: 'b2', statement: 'short', excerpt: 'x' }, ids)).toBeNull();
    expect(validateOperation({ op: 'correction', beliefId: 'b2', statement: 'A valid replacement statement', dimension: 'brevity', level: 'loud', excerpt: 'x' }, ids)).toBeNull();
    expect(validateOperation({ op: 'correction', beliefId: 'zz', statement: 'A valid replacement statement', excerpt: 'x' }, ids)).toBeNull();
  });
});

describe('prompt', () => {
  it('labels Mercury\'s reply as never a source and lists the trait dimensions', () => {
    const sys = buildSystemPrompt('Salman');
    expect(sys).toContain('NEVER a source for beliefs about the owner');
    expect(sys).toContain('autonomy: ask-first | ask-when-risky | just-do-it');
    expect(sys).toContain('expertise:<domain>');
    expect(sys).toContain('Output [] when nothing durable was learned');
    const user = buildUserPrompt(input(), [belief({ id: 'b1', statement: 'Prefers to be asked before commands run', kind: 'trait', dimension: 'autonomy', level: 'ask-first' })]);
    expect(user).toContain('id=b1 [trait autonomy=ask-first] Prefers to be asked before commands run (status: held');
    expect(user).toContain('MERCURY SAID (never a source for beliefs about the owner');
    expect(user).toContain("OWNER SAID: don't ask before running tests here");
    expect(user).toContain('autonomy request: just-do-it');
    expect(user).toContain('PENDING QUESTION: none');
  });
});

function deps(overrides: Partial<ExtractDeps> & { text?: string; afford?: boolean; paused?: boolean; found?: Belief[] } = {}): ExtractDeps & { calls: number; usage: unknown[] } {
  const found = overrides.found ?? [];
  const state = { calls: 0, usage: [] as unknown[] };
  return Object.assign(state, {
    providers: { getDefault: () => ({ name: 'scripted', getModel: () => 'scripted-1', getModelInstance: () => ({}) }) },
    tokenBudget: { canAfford: () => overrides.afford ?? true, recordUsage: (u: unknown) => { state.usage.push(u); } },
    beliefs: { searchRelevant: () => found.map((b) => ({ ...b, confidence: 0.8 })), findSimilar: () => found },
    learningPaused: () => overrides.paused ?? false,
    generate: async () => { state.calls++; return { text: overrides.text ?? '[]', usage: { inputTokens: 100, outputTokens: 20 } }; },
    ...overrides,
  });
}

describe('extractBeliefOperations', () => {
  it('skips trivial messages, paused learning, general-access channels and a thin budget without a model call', async () => {
    const d = deps();
    expect(await extractBeliefOperations(d, input({ ownerMessage: 'thanks!' }))).toEqual([]);
    expect(await extractBeliefOperations(deps({ paused: true }), input())).toEqual([]);
    expect(await extractBeliefOperations(deps({ afford: false }), input())).toEqual([]);
    expect(await extractBeliefOperations(d, input({ channelAccess: 'general' }))).toEqual([]);
    expect(d.calls).toBe(0);
    expect(shouldExtract(d, { ownerMessage: 'hello there' })).toBe(false);
    expect(shouldExtract(d, { ownerMessage: 'please stop asking before tests' })).toBe(true);
    // A correction that happens to open with "no" is the most valuable turn there is.
    expect(shouldExtract(d, { ownerMessage: "No no, I said British spelling. Fix the blog post and stop using 'color'." })).toBe(true);
    expect(shouldExtract(d, { ownerMessage: 'ok do it' })).toBe(false);
  });

  it('calls the model once, records usage, and returns validated ops referencing only known beliefs', async () => {
    const existing = belief({ id: 'b1', statement: 'Prefers to be asked before commands run', kind: 'trait', dimension: 'autonomy', level: 'ask-first' });
    const d = deps({
      found: [existing],
      text: JSON.stringify([
        { op: 'correction', beliefId: 'b1', statement: 'Wants tests run without asking in this repo', dimension: 'autonomy', level: 'just-do-it', context: 'project:/home/o/proj', excerpt: "don't ask before running tests here" },
        { op: 'support', beliefId: 'ghost', excerpt: 'x' },
        { op: 'create', kind: 'episode', statement: 'Mercury ran the test suite for the owner', excerpt: 'run the tests' },
      ]),
    });
    const ops = await extractBeliefOperations(d, input());
    expect(d.calls).toBe(1);
    expect(d.usage).toEqual([{ provider: 'scripted', model: 'scripted-1', inputTokens: 100, outputTokens: 20, totalTokens: 120, channelType: 'internal', agentId: undefined }]);
    expect(ops.map((o) => o.op)).toEqual(['correction', 'create']);
    expect(ops[0]).toMatchObject({ beliefId: 'b1', level: 'just-do-it', sessionId: 's1', turnRef: 'm1' });
    expect(ops[1]).toMatchObject({ kind: 'episode', timescale: 'episodic' });
  });

  it('returns [] when the model answers in prose', async () => {
    const d = deps({ text: 'The owner seems to prefer running tests without being asked.' });
    expect(await extractBeliefOperations(d, input())).toEqual([]);
    expect(d.calls).toBe(1);
  });

  it('uses the configured output cap', () => {
    expect(EXTRACT_MAX_OUTPUT_TOKENS).toBe(600);
  });

  it('merges relevant and similar beliefs without duplicates', () => {
    const a = belief({ id: 'a', statement: 'Likes short answers' });
    const b = belief({ id: 'b', statement: 'Works on Mercury' });
    const found = relevantBeliefs({ searchRelevant: () => [{ ...a, confidence: 0.9 }], findSimilar: () => [a, b] }, 'short answers mercury');
    expect(found.map((x) => x.id)).toEqual(['a', 'b']);
  });
});

describe('parseBeliefOperations excerpt fallback', () => {
  it('an op the model emitted without an excerpt cites the owner message instead of being dropped', () => {
    const text = JSON.stringify([{ op: 'owner_stated', kind: 'trait', dimension: 'brevity', level: 'terse', statement: 'Prefers short answers on the phone', context: '*' }]);
    expect(parseBeliefOperations(text, new Set())).toEqual([]);
    const ops = parseBeliefOperations(text, new Set(), { defaultExcerpt: '[Voice call: …] Always keep the answer short, I read these on my phone.' });
    expect(ops).toHaveLength(1);
    expect(ops[0].excerpt).toBe('[Voice call: …] Always keep the answer short, I read these on my phone.');
  });
});
