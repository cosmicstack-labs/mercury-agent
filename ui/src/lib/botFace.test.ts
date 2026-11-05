import { describe, expect, it } from 'vitest';
import { botFace, botFaceColor, botHue, botMonogram } from './botFace.js';

/**
 * The rules the phone already draws with (`BotJson.monogram`, `BotJson.hue`, `BotFace` in
 * `BotsScreen.kt`). Pinned here so the dashboard and the app cannot drift into showing the
 * same bot as "RL" on one and "RE" on the other.
 */
describe('botMonogram', () => {
  it('takes the initials of a two-word name', () => {
    expect(botMonogram('Research Lead', 'x')).toBe('RL');
  });

  it('takes the first two characters of a single-word name', () => {
    expect(botMonogram('Solo', 'solo-1')).toBe('SO');
  });

  it('falls back to the id when the name is blank, then splits it the same way', () => {
    expect(botMonogram('', 'gamma-7')).toBe('G7');
    expect(botMonogram('   ', 'ledger')).toBe('LE');
  });

  it('ignores empty segments, so a leading separator does not eat a letter', () => {
    expect(botMonogram(' lead-ops', 'x')).toBe('LO');
  });

  it('answers a single character when that is all there is', () => {
    expect(botMonogram('A', 'x')).toBe('A');
  });

  it('answers ? when there is neither name nor id', () => {
    expect(botMonogram('', '')).toBe('?');
  });
});

describe('botHue', () => {
  it('is stable for the same id', () => {
    expect(botHue('alpha')).toBe(botHue('alpha'));
  });

  it('matches the phone: 32-bit wrapping hash of the id, modulo 360', () => {
    // 97, 108, 112, 104, 97 folded with `hash * 31 + c` and masked to 31 bits.
    expect(botHue('alpha')).toBe(38);
  });

  it('stays in 0…359 for ids of every shape', () => {
    for (const id of ['a', 'alpha', 'gamma-7', 'bot_with_underscores', 'Ünïcode-id', '0', 'x'.repeat(200)]) {
      const hue = botHue(id);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
      expect(Number.isInteger(hue)).toBe(true);
    }
  });

  it('uses the name when there is no id, and a neutral blue when there is neither', () => {
    expect(botHue('', 'Research Lead')).toBe(botHue('Research Lead'));
    expect(botHue('', '')).toBe(210);
    expect(botHue('   ', '   ')).toBe(210);
  });
});

describe('botFaceColor', () => {
  it('is hsv(h, 45%, 75%) as rgb: full value on the dominant channel, 105 on the floor', () => {
    expect(botFaceColor(0)).toBe('rgb(191, 105, 105)');
    expect(botFaceColor(120)).toBe('rgb(105, 191, 105)');
    expect(botFaceColor(240)).toBe('rgb(105, 105, 191)');
  });

  it('keeps the same lightness for every hue, so no bot is illegible next to another', () => {
    for (let hue = 0; hue < 360; hue += 15) {
      const [r, g, b] = botFaceColor(hue).match(/\d+/g)!.map(Number);
      expect(Math.max(r, g, b)).toBe(191);
      expect(Math.min(r, g, b)).toBe(105);
    }
  });

  it('wraps out-of-range hues instead of rendering nothing', () => {
    expect(botFaceColor(360)).toBe(botFaceColor(0));
    expect(botFaceColor(-120)).toBe(botFaceColor(240));
  });
});

describe('botFace', () => {
  it('gives the letters and the background from one id in one call', () => {
    const face = botFace('alpha', 'Alpha');
    expect(face.monogram).toBe('AL');
    expect(face.background).toBe(botFaceColor(38));
  });
});
