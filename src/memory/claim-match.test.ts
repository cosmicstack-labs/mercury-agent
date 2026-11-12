import { describe, expect, it } from 'vitest';
import { claimSignature, sameClaim } from './claim-match.js';

const owner = ['salman qureshi', 'salman'];
const same = (a: string, b: string) => sameClaim(claimSignature(a, owner), claimSignature(b, owner));

describe('same claim', () => {
  it('every way of saying the owner is married to Heer is one claim', () => {
    const ways = ["Heer is my wife.", "User's wife is Heer", 'User is married to Heer.', 'User is married to someone named Heer.', "Heer is user's spouse", "Heer is Salman's wife"];
    for (const a of ways) for (const b of ways) expect(same(a, b), `${a} / ${b}`).toBe(true);
  });

  it('the same claim with a little more detail is the same claim', () => {
    expect(same('Heer is my wife.', "Heer is the user's wife, married since 2019.")).toBe(true);
    expect(same('User decided to purchase the Kobo Libra Colour e-reader', 'User decided to buy the Kobo Libra Colour e-reader for reading freedom')).toBe(true);
    expect(same('Pitch Mercury agent to Y Combinator', 'Pitching Mercury Agent to Y Combinator')).toBe(true);
  });

  it('a claim that says something new is not a copy', () => {
    expect(same('Heer is my wife.', 'Married to Heer; about to become a father')).toBe(false);
    expect(same("Zayd and Shehzen are Salman's MTech friends", 'Zaid (Zayd) dislikes Shehzen, a friend of Salman from MTech days')).toBe(false);
    expect(same('Zunaira is two years old', "Zunaira is Salman's two-year-old niece")).toBe(false);
    expect(same('Heer is my wife', 'Planning a birthday surprise for Heer with flowers and a cake for my wife')).toBe(false);
  });

  it('different numbers, negations and people are different claims', () => {
    expect(same('Salman married Heer in 2019', 'Salman married Heer on October 9, 2025')).toBe(false);
    expect(same('Likes dark mode in the terminal', "Doesn't like dark mode in the terminal")).toBe(false);
    expect(same('Zaid is my friend', 'Shehzen is my friend')).toBe(false);
    expect(same('Prefers TypeScript', 'Prefers Rust')).toBe(false);
  });
});
