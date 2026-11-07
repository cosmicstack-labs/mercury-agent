import { describe, expect, it } from 'vitest';
import { capKnown, cardinalityOf, exclusiveGroup, normalizeRelationship, standingOf, type PersonEvidence } from './person-standing.js';

const base: PersonEvidence = { mentions: 0, socialMentions: 0, distinctDays: 0, relationship: null, personLinks: 0, kind: 'unverified', verifiedBy: null, ownerEdited: false };
const s = (e: Partial<PersonEvidence>) => standingOf({ ...base, ...e });

describe('person standing', () => {
  it('a single mention is never known', () => {
    expect(s({ mentions: 1, socialMentions: 1, relationship: 'wife' }).tier).toBe('shadow');
    expect(s({ mentions: 1 }).tier).toBe('faint');
  });

  it('recurrence plus a relationship makes someone known', () => {
    const st = s({ mentions: 3, socialMentions: 2, relationship: 'wife', distinctDays: 2 });
    expect(st.tier).toBe('known');
    expect(st.reasons).toContain('your wife');
  });

  it('frequent mentions without any relationship stay a shadow (a city, a product)', () => {
    const st = s({ mentions: 12, socialMentions: 3, distinctDays: 5 });
    expect(st.score).toBeGreaterThanOrEqual(55);
    expect(st.tier).toBe('shadow');
    expect(st.reasons).toContain('no relationship yet');
  });

  it('a link to another person counts as a tie', () => {
    expect(s({ mentions: 4, socialMentions: 2, personLinks: 1 }).tier).toBe('known');
  });

  it('owner decisions win; model rejections lose', () => {
    expect(s({ ownerEdited: true }).score).toBe(100);
    expect(s({ mentions: 9, relationship: 'friend', verifiedBy: 'model-rejected' }).score).toBe(0);
  });

  it('soft-caps the known list: strong ties stay, weak ones fade, owner-confirmed never move', () => {
    const scores = [100, 90, 60, 58, 72];
    const people = scores.map((score, i) => ({ id: `p${i}`, ownerEdited: i === 0, standing: { score, tier: 'known' as const, reasons: [] as string[] } }));
    capKnown(people, 3);
    // Room for two besides the owner (p1 90, p4 72); past it the bar is 70, so p2 (60) and p3 (58) fade.
    expect(people.filter((p) => p.standing.tier === 'known').map((p) => p.id).sort()).toEqual(['p0', 'p1', 'p4']);
    const strong = Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, ownerEdited: false, standing: { score: 95, tier: 'known' as const, reasons: [] as string[] } }));
    capKnown(strong, 3);
    expect(strong.every((p) => p.standing.tier === 'known')).toBe(true);
    expect(people.flatMap((p) => p.standing.reasons).join(' ')).not.toMatch(/limit|cap/);
  });
});

describe('relationships and cardinality', () => {
  it('normalises words and keeps specific family roles', () => {
    expect(normalizeRelationship('Mom')).toBe('mother');
    expect(normalizeRelationship('co-workers')).toBe('colleague');
    expect(normalizeRelationship('sons')).toBe('son');
  });

  it('knows one-to-one from one-to-many', () => {
    expect(cardinalityOf('wife')).toBe('one');
    expect(cardinalityOf('mother')).toBe('one');
    expect(cardinalityOf('friend')).toBe('many');
    expect(cardinalityOf('son')).toBe('many');
    expect(exclusiveGroup('husband')).toBe('spouse');
    expect(exclusiveGroup('partner')).toBe('spouse');
    expect(exclusiveGroup('friend')).toBeNull();
  });
});
