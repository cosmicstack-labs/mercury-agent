/**
 * Pixel/block-font renderer for the Mercury Code splash screen.
 *
 * Each glyph is a fixed-width bitmap (1 = filled). All glyphs in a word
 * share one baseline and one column width, and rows are padded — never
 * ragged — so concatenating a second word cannot misalign rows. Filled
 * cells use single-codepoint block characters only (U+2588/U+2593), which
 * every terminal font metrics-treats as exactly one cell wide: the mark is
 * pixel-precise across devices. Color/vibrancy is applied by the caller.
 */

const GLYPHS: Record<string, string[]> = {
  A: [
    '0110',
    '1001',
    '1111',
    '1001',
    '1001',
  ],
  B: [
    '1110',
    '1001',
    '1110',
    '1001',
    '1110',
  ],
  C: [
    '0111',
    '1000',
    '1000',
    '1000',
    '0111',
  ],
  D: [
    '1110',
    '1001',
    '1001',
    '1001',
    '1110',
  ],
  E: [
    '1111',
    '1000',
    '1110',
    '1000',
    '1111',
  ],
  G: [
    '0111',
    '1000',
    '1011',
    '1001',
    '0111',
  ],
  H: [
    '1001',
    '1001',
    '1111',
    '1001',
    '1001',
  ],
  I: [
    '111',
    ' 1 ',
    ' 1 ',
    ' 1 ',
    '111',
  ],
  M: [
    '10001',
    '11011',
    '10101',
    '10001',
    '10001',
  ],
  N: [
    '1001',
    '1101',
    '1011',
    '1001',
    '1001',
  ],
  O: [
    '0110',
    '1001',
    '1001',
    '1001',
    '0110',
  ],
  P: [
    '1110',
    '1001',
    '1110',
    '1000',
    '1000',
  ],
  R: [
    '1110',
    '1001',
    '1110',
    '1010',
    '1001',
  ],
  S: [
    '0111',
    '1000',
    '0110',
    '0001',
    '1110',
  ],
  T: [
    '111',
    ' 1 ',
    ' 1 ',
    ' 1 ',
    ' 1 ',
  ],
  U: [
    '1001',
    '1001',
    '1001',
    '1001',
    '0110',
  ],
  V: [
    '10001',
    '10001',
    '10001',
    '01010',
    '00100',
  ],
  W: [
    '10001',
    '10001',
    '10101',
    '11011',
    '10001',
  ],
  X: [
    '1001',
    '0110',
    '0110',
    '0110',
    '1001',
  ],
  Y: [
    '1001',
    '1001',
    '0110',
    '0110',
    '0110',
  ],
  Z: [
    '1111',
    '0001',
    '0110',
    '1000',
    '1111',
  ],
  ' ': [
    '  ',
    '  ',
    '  ',
    '  ',
    '  ',
  ],
};

export const PIXEL_FONT_HEIGHT = 5;

/**
 * Render a word as pixel-font rows.
 * @param shading Cycle of block characters for filled pixels, cycled per
 *   glyph column (e.g. '██▓' = two bright pixels then a shaded one — the
 *   subtle texture banding of the reference mark). Cycle resets per glyph
 *   so every letter shows the same pattern.
 */
export function renderPixelWord(word: string, shading: string = '██▓'): string[] {
  const fills = shading.length > 0 ? shading.split('') : ['▓'];
  const width = GLYPHS['M']?.length ?? 0; // widest glyph governs nothing; width is per-glyph
  void width;
  const rows: string[] = Array.from({ length: PIXEL_FONT_HEIGHT }, () => '');
  for (const ch of word.toUpperCase()) {
    const glyph = GLYPHS[ch] ?? GLYPHS[' '];
    for (let y = 0; y < PIXEL_FONT_HEIGHT; y++) {
      const glyphRow = glyph[y] ?? '';
      let rendered = '';
      let col = 0;
      for (const bit of glyphRow) {
        if (bit === '1') {
          rendered += fills[col % fills.length] ?? fills[0];
        } else {
          rendered += ' ';
        }
        col += 1;
      }
      rows[y] += rendered + ' ';
    }
  }
  return rows;
}

/**
 * Two-tone "MERCURY CODE" as alignment-safe parts for colored rendering.
 * The left block ("MERCURY") is padded to a constant width so the right
 * block ("CODE") starts at the same column on every row — pixel-precise
 * on any terminal. Both use the `██▓` bright-with-shade texture.
 */
export function renderMercuryCodeParts(): Array<{ left: string; right: string }> {
  const mercury = renderPixelWord('MERCURY', '██▓');
  const code = renderPixelWord('CODE', '██▓');
  const trimEnd = (s: string) => s.replace(/\s+$/, '');
  const leftTrimmed = mercury.map(trimEnd);
  const leftW = Math.max(...leftTrimmed.map((r) => r.length));
  return leftTrimmed.map((row, i) => ({
    left: row.padEnd(leftW, ' '),
    right: trimEnd(code[i] ?? ''),
  }));
}

/** Flat two-tone splash (single string per row). Kept for simple dumps. */
export function renderMercuryCodeSplash(): string[] {
  return renderMercuryCodeParts().map(({ left, right }) =>
    `${left}  ${right}`.replace(/\s+$/, ''),
  );
}