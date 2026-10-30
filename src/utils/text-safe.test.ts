import { describe, expect, it } from 'vitest';
import { stripLoneSurrogates, truncateText } from './text-safe.js';

const HEADPHONES = '\u{1F3A7}'; // 🎧 — une paire de surrogates

describe('stripLoneSurrogates', () => {
  it('laisse une paire valide intacte', () => {
    expect(stripLoneSurrogates(`casque ${HEADPHONES}`)).toBe(`casque ${HEADPHONES}`);
  });

  it('jette une moitié haute orpheline, celle qui fait échouer le fournisseur', () => {
    const half = HEADPHONES.slice(0, 1);
    expect(stripLoneSurrogates(`abc${half}`)).toBe('abc');
  });

  it('jette une moitié basse orpheline', () => {
    const half = HEADPHONES.slice(1);
    expect(stripLoneSurrogates(`abc${half}`)).toBe('abc');
  });

  it('conserve le texte autour et recolle les paires suivantes', () => {
    const half = HEADPHONES.slice(0, 1);
    expect(stripLoneSurrogates(`a${half}b${HEADPHONES}c`)).toBe(`ab${HEADPHONES}c`);
  });
});

describe('truncateText', () => {
  it('ne coupe pas une paire de surrogates au milieu', () => {
    // La coupe tombe exactement entre le high et le low : c'est le cas qui partait en 400.
    const text = `${'x'.repeat(10)}${HEADPHONES}fin`;
    const cut = truncateText(text, 11);
    expect(cut).toBe('x'.repeat(10));
    expect(cut.charCodeAt(cut.length - 1)).toBeLessThan(0xd800);
  });

  it('produit un corps JSON que plus aucun parseur strict ne refuse', () => {
    const text = `${'x'.repeat(10)}${HEADPHONES}fin`;
    const body = JSON.stringify({ content: truncateText(text, 11) });
    expect(body).not.toMatch(/\\u[dD][89abAB]/); // aucun \udXXX isolé
  });

  it('garde le texte entier quand il tient, sans surrogates isolés', () => {
    const half = HEADPHONES.slice(0, 1);
    expect(truncateText(`court${half}`, 100)).toBe('court');
    expect(truncateText('court', 100)).toBe('court');
  });

  it('rend une chaîne vide pour une limite nulle ou négative', () => {
    expect(truncateText('abc', 0)).toBe('');
    expect(truncateText('abc', -5)).toBe('');
  });
});
