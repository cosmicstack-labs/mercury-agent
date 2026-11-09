import { describe, expect, it } from 'vitest';
import { stripLoneSurrogates, truncateText } from './text-safe.js';

const HEADPHONES = '\u{1F3A7}'; // 🎧 — a surrogate pair

describe('stripLoneSurrogates', () => {
  it('leaves a valid pair intact', () => {
    expect(stripLoneSurrogates(`casque ${HEADPHONES}`)).toBe(`casque ${HEADPHONES}`);
  });

  it('drops an orphaned high half — the one the provider rejects', () => {
    const half = HEADPHONES.slice(0, 1);
    expect(stripLoneSurrogates(`abc${half}`)).toBe('abc');
  });

  it('drops an orphaned low half', () => {
    const half = HEADPHONES.slice(1);
    expect(stripLoneSurrogates(`abc${half}`)).toBe('abc');
  });

  it('keeps the text around it and rejoins the pairs that follow', () => {
    const half = HEADPHONES.slice(0, 1);
    expect(stripLoneSurrogates(`a${half}b${HEADPHONES}c`)).toBe(`ab${HEADPHONES}c`);
  });
});

describe('truncateText', () => {
  it('never cuts through a surrogate pair', () => {
    // The cut lands exactly between the high and the low half: the case that used to go out as a 400.
    const text = `${'x'.repeat(10)}${HEADPHONES}fin`;
    const cut = truncateText(text, 11);
    expect(cut).toBe('x'.repeat(10));
    expect(cut.charCodeAt(cut.length - 1)).toBeLessThan(0xd800);
  });

  it('produces a JSON body no strict parser refuses', () => {
    const text = `${'x'.repeat(10)}${HEADPHONES}fin`;
    const body = JSON.stringify({ content: truncateText(text, 11) });
    expect(body).not.toMatch(/\\u[dD][89abAB]/); // no lone \udXXX
  });

  it('keeps the whole text when it fits, minus any lone surrogate', () => {
    const half = HEADPHONES.slice(0, 1);
    expect(truncateText(`court${half}`, 100)).toBe('court');
    expect(truncateText('court', 100)).toBe('court');
  });

  it('returns an empty string for a zero or negative limit', () => {
    expect(truncateText('abc', 0)).toBe('');
    expect(truncateText('abc', -5)).toBe('');
  });
});
