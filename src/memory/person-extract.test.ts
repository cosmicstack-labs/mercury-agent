import { describe, expect, it } from 'vitest';
import { extractAliases, extractOwnerRelations, extractPersonLinks, isOwnerName, ownerNameSet, stripAliasNotes } from './person-extract.js';

const owner = ownerNameSet('Salman');
// Stand-in for the store's name finder: capitalised words that are not common English.
const names = (s: string) => (s.match(/\b[A-Z][a-z]+\b/g) ?? []).filter((n) => !['User', 'The', 'My', 'MTech', 'Married'].includes(n));
const isName = (n: string) => /^[A-Z][a-z]+$/.test(n);
const rel = (t: string, social = true) => extractOwnerRelations(t, owner, names, { social }).map((r) => `${r.name}:${r.relation}`).sort();

describe('people from real memory phrasing', () => {
  it('knows the owner is not a person', () => {
    expect(isOwnerName('Salman', owner)).toBe(true);
    expect(isOwnerName('user', owner)).toBe(true);
    expect(isOwnerName('Heer', owner)).toBe(false);
    expect(rel('Salman is the user interacting with the assistant.')).toEqual([]);
  });

  it('reads a relationship to the owner in every common form', () => {
    expect(rel("User's wife is Heer")).toEqual(['Heer:wife']);
    expect(rel('Heer is my wife.')).toEqual(['Heer:wife']);
    expect(rel("Heer is the user's wife, married since 2019.")).toEqual(['Heer:wife']);
    expect(rel("Heer is Salman's wife, married since 2019")).toEqual(['Heer:wife']);
    expect(rel("User's partner Heer has been with them through major life events since 2019.")).toEqual(['Heer:partner']);
    expect(rel("Zayd and Shehzen are Salman's MTech friends")).toEqual(['Shehzen:friend', 'Zayd:friend']);
    expect(rel("Shehzen is the user's friend")).toEqual(['Shehzen:friend']);
    expect(rel("Zaid (Zayd) is user's MTech friend who hates Shehzen, another MTech friend")).toEqual(['Zaid:friend']);
    expect(rel('Zaid (Zayd) dislikes Shehzen, a friend of Salman from MTech days')).toEqual(['Shehzen:friend']);
    expect(rel("Shazain is a colleague/co-worker in user's office")).toEqual(['Shazain:colleague']);
  });

  it('reads marriage as a spouse', () => {
    expect(rel('Salman married Heer on October 9, 2025.')).toEqual(['Heer:spouse']);
    expect(rel('User is married to someone named Heer.')).toEqual(['Heer:spouse']);
    expect(rel('Married to Heer since 2019, with major life events together.')).toEqual(['Heer:spouse']);
  });

  it('keeps son and daughter apart instead of lumping them as family', () => {
    expect(rel('My son Ayaan started school')).toEqual(['Ayaan:son']);
    expect(rel('Zoya is my daughter')).toEqual(['Zoya:daughter']);
  });

  it('needs "my/user\'s" outside relationship beliefs', () => {
    expect(rel('Castor is a client tool for casting video', false)).toEqual([]);
  });

  it('finds aliases and reads past them', () => {
    expect(extractAliases('Zaid (Zayd) dislikes Shehzen')).toEqual([['Zaid', 'Zayd']]);
    expect(extractAliases('Shehzen (also spelled Shezan) is a friend')).toEqual([['Shehzen', 'Shezan']]);
    expect(extractAliases('Zaid (also Zayd) is close to the user')).toEqual([['Zaid', 'Zayd']]);
    expect(stripAliasNotes('Zaid (Zayd) is user\'s friend')).toBe("Zaid is user's friend");
  });

  it('finds relationships between two people, never with the owner', () => {
    expect(extractPersonLinks('Zaid (Zayd) dislikes Shehzen, a friend of Salman', owner, isName)).toEqual([{ a: 'Zaid', b: 'Shehzen', type: 'dislikes' }]);
    expect(extractPersonLinks("Zaid is user's MTech friend who hates Shehzen", owner, isName)).toEqual([]);
    expect(extractPersonLinks('Ali is Sara\'s brother', owner, isName)).toEqual([{ a: 'Ali', b: 'Sara', type: 'brother' }]);
    expect(extractPersonLinks('Salman dislikes Mondays', owner, isName)).toEqual([]);
  });
});
