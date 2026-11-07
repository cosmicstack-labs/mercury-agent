import { describe, expect, it } from 'vitest';
import { PersonVerifier, parsePersonCheck, personCheckPrompt, type PersonCheckItem, type PersonVerdict } from './person-verifier.js';
import { isLikelyHumanName } from './user-memory.js';

function host(items: PersonCheckItem[]) {
  const applied: Record<string, PersonVerdict> = {};
  return {
    applied,
    pendingPersonChecks: (limit: number) => items.filter((i) => !(i.person_id in applied)).slice(0, limit),
    countPersonChecks: () => items.filter((i) => !(i.person_id in applied)).length,
    applyPersonCheck: (id: string, v: PersonVerdict) => { applied[id] = v; },
  };
}

describe('person checks', () => {
  it('rejects ordinary words and product names before anything is stored', () => {
    for (const bad of ['Married', 'During', 'She', 'Heer The', 'Heer User', 'Brain Graph', 'System Fixes User', 'Mercury Agent Web', 'Optimus Prime', 'The Architect', 'Battlefield', 'Working']) {
      expect(isLikelyHumanName(bad)).toBe(false);
    }
    for (const good of ['Heer', 'Zayd', 'Shehzen', 'Salman Qureshi']) expect(isLikelyHumanName(good)).toBe(true);
  });

  it('checks a batch in one call and applies each verdict', async () => {
    const h = host([
      { person_id: 'a', name: 'Zayd', context: 'Zayd is my son' },
      { person_id: 'b', name: 'Bruno', context: 'walked Bruno, our dog' },
      { person_id: 'c', name: 'Tesla', context: 'bought Tesla shares' },
    ]);
    let calls = 0;
    const v = new PersonVerifier(h, async (items) => { calls++; return parsePersonCheck('1: person\n2: pet\n3: not_person', items); });
    expect(await v.runOnce()).toBe(3);
    expect(calls).toBe(1);
    expect(h.applied).toEqual({ a: 'person', b: 'pet', c: 'not_person' });
    expect(await v.runOnce()).toBe(0); // queue empty: no call
    expect(calls).toBe(1);
  });

  it('never exceeds the daily cap', async () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ person_id: `p${i}`, name: `Name${i}`, context: '' }));
    const h = host(items);
    let calls = 0;
    const v = new PersonVerifier(h, async () => { calls++; return {}; }, { batch: 2, dailyCap: 3 });
    for (let i = 0; i < 6; i++) await v.runOnce();
    expect(calls).toBe(3);
    expect(v.status().callsToday).toBe(3);
  });

  it('a failed call leaves the names queued and reports the error', async () => {
    const h = host([{ person_id: 'a', name: 'Zayd', context: '' }]);
    const v = new PersonVerifier(h, async () => { throw new Error('rate limited'); });
    expect(await v.runOnce()).toBe(0);
    expect(h.countPersonChecks()).toBe(1);
    expect(v.status().lastError).toBe('rate limited');
  });

  it('prompt numbers the names and the parser tolerates loose formatting', () => {
    const items = [{ id: 'x', name: 'Heer', context: 'my wife Heer' }, { id: 'y', name: 'Rex', context: '' }];
    expect(personCheckPrompt(items)).toContain('1. name: "Heer"');
    expect(parsePersonCheck('1) Person\n2 - not a person\nnoise', items)).toEqual({ x: 'person', y: 'not_person' });
  });
});
