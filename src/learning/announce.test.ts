import { describe, expect, it } from 'vitest';
import type { ApplyResult, Belief } from '../memory/beliefs.js';
import { ASK_COOLDOWN_MS, composeLearnedNote, pendingQuestion, restate } from './announce.js';

function belief(partial: Partial<Belief> & Pick<Belief, 'id' | 'statement'>): Belief {
  const now = 1_700_000_000_000;
  return {
    ownerKey: 'user:owner', kind: 'preference', dimension: null, level: null, detail: null, context: '*', support: 2, against: 0,
    supportSessions: 2, timescale: 'stable', status: 'held', ownerStated: false, validFrom: now, validTo: null, supersededBy: null,
    lastSupportedAt: now, lastUsedAt: null, createdAt: now, updatedAt: now, shareable: false, ...partial,
  };
}

function fakeStore(pairs: Array<{ a: Belief; b: Belief | null }> = []) {
  const meta = new Map<string, string>();
  return {
    meta,
    contested: () => pairs,
    getMeta: (k: string) => meta.get(k) ?? null,
    setMeta: (k: string, v: string) => { meta.set(k, v); },
  };
}

const result = (belief: Belief, change: ApplyResult['change'], behaviorChanging = true): ApplyResult => ({ belief, change, behaviorChanging });

describe('restate', () => {
  it('turns traits into second-person phrases with their context', () => {
    expect(restate(belief({ id: 'x', kind: 'trait', dimension: 'autonomy', level: 'just-do-it', statement: 'Runs things without asking', context: 'project:/home/o/mercury' })))
      .toBe("you'd rather I just run things without asking in mercury");
    expect(restate(belief({ id: 'x', kind: 'trait', dimension: 'brevity', level: 'terse', statement: 'Short', context: 'channel:telegram' })))
      .toBe("you'd rather I keep replies short on telegram");
    expect(restate(belief({ id: 'x', kind: 'trait', dimension: 'expertise:typescript', level: 'expert', statement: 'TS expert' }))).toBe("you're an expert in typescript");
    expect(restate(belief({ id: 'x', kind: 'trait', dimension: 'risk:publishing', level: 'cautious', statement: 'Careful' }))).toBe("you're cautious about publishing");
  });

  it('rewrites third-person statements into "you"', () => {
    expect(restate(belief({ id: 'x', statement: 'Owner prefers one command over many manual steps.' }))).toBe('you prefer one command over many manual steps');
    expect(restate(belief({ id: 'x', statement: 'The user is based in Lahore' }))).toBe('you are based in lahore'.replace('lahore', 'Lahore'));
    expect(restate(belief({ id: 'x', statement: 'Prefers tabs over spaces' }))).toBe('prefers tabs over spaces');
  });
});

describe('composeLearnedNote', () => {
  it('returns null when nothing behaviour-changing happened', () => {
    const store = fakeStore();
    const fact = belief({ id: 'f', kind: 'fact', statement: 'Lives in Lahore' });
    expect(composeLearnedNote([], { beliefs: store })).toBeNull();
    expect(composeLearnedNote([result(fact, 'created', false), null, result(fact, 'supported', false)], { beliefs: store })).toBeNull();
    // A fact is trivia even if flagged.
    expect(composeLearnedNote([result(fact, 'now-held', false)], { beliefs: store })).toBeNull();
  });

  it('writes one Noted line for a behaviour-changing result', () => {
    const store = fakeStore();
    const trait = belief({ id: 't', kind: 'trait', dimension: 'autonomy', level: 'just-do-it', statement: 'x', context: 'project:/home/o/mercury', status: 'confirmed', ownerStated: true });
    const other = belief({ id: 'p', statement: 'Owner prefers short commit messages' });
    const line = composeLearnedNote([result(trait, 'replaced'), result(other, 'now-held')], { beliefs: store });
    expect(line).toBe('☿ Noted: you\'d rather I just run things without asking in mercury. Say "forget that" to undo.');
  });

  it('asks about a contested pair at most once a day, then falls back to a note', () => {
    const a = belief({ id: 'a', kind: 'trait', dimension: 'brevity', level: 'terse', statement: 'Short', status: 'contested' });
    const b = belief({ id: 'b', kind: 'trait', dimension: 'brevity', level: 'thorough', statement: 'Long', status: 'contested' });
    const store = fakeStore([{ a, b }]);
    const now = 1_700_000_000_000;
    const q = composeLearnedNote([result(b, 'contested')], { beliefs: store, now });
    expect(q).toBe("☿ I've noticed you'd rather I keep replies short but also you'd rather I answer thoroughly. Which should I go with?");
    expect(store.meta.get('asked:a')).toBe(new Date(now).toISOString());
    expect(store.meta.get('asked:b')).toBe(new Date(now).toISOString());
    // Asked again within the day: silent (no other result).
    expect(composeLearnedNote([result(b, 'contested')], { beliefs: store, now: now + 1000 })).toBeNull();
    // ...but a note for another result still goes out.
    const other = belief({ id: 'p', statement: 'Owner prefers short commit messages' });
    expect(composeLearnedNote([result(b, 'contested'), result(other, 'now-held')], { beliefs: store, now: now + 1000 })).toContain('☿ Noted: you prefer short commit messages');
    // After the cooldown it may be asked again.
    expect(composeLearnedNote([result(b, 'contested')], { beliefs: store, now: now + ASK_COOLDOWN_MS + 1 })).toContain('Which should I go with?');
  });
});

describe('pendingQuestion', () => {
  it('returns the oldest un-asked pair, preferring one asked within the last day', () => {
    const now = 1_700_000_000_000;
    const a1 = belief({ id: 'a1', statement: 'Owner likes options', updatedAt: now - 5000, status: 'contested' });
    const b1 = belief({ id: 'b1', statement: 'Owner wants a verdict', status: 'contested' });
    const a2 = belief({ id: 'a2', statement: 'Owner wants morning pings', updatedAt: now - 9000, status: 'contested' });
    const store = fakeStore([{ a: a1, b: b1 }, { a: a2, b: null }]);
    expect(pendingQuestion(store, now)).toBe("☿ I've noticed you want morning pings, but I'm no longer sure. Is that still right?");
    store.setMeta('asked:a1', new Date(now - 60_000).toISOString());
    expect(pendingQuestion(store, now)).toBe("☿ I've noticed you like options but also you want a verdict. Which should I go with?");
    expect(pendingQuestion(fakeStore(), now)).toBeNull();
  });
});
