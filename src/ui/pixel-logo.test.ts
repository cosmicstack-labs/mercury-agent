import { describe, expect, it } from 'vitest';
import {
  renderPixelWord,
  renderMercuryCodeParts,
  renderMercuryCodeSplash,
  PIXEL_FONT_HEIGHT,
} from './pixel-logo.js';

describe('pixel wordmark', () => {
  it('renders MERCURY CODE with aligned two-tone parts', () => {
    const parts = renderMercuryCodeParts();
    expect(parts).toHaveLength(PIXEL_FONT_HEIGHT);
    // The left block is padded to a constant width so CODE starts at the
    // same column on every row.
    expect(new Set(parts.map((p) => p.left.length)).size).toBe(1);
    expect(parts.every((p) => p.right.length > 0)).toBe(true);
  });

  it('shading is per-row: no shade cell ever sits above a solid one', () => {
    // Regression: per-column shading scattered ▓ holes inside letters
    // (`█ ▓ █`). Shading must band horizontally — every filled cell in a
    // row uses the same fill character.
    const rows = renderPixelWord('MERCURY CODE', '████▓');
    for (const row of rows) {
      const fills = new Set([...row.replace(/ /g, '')]);
      expect(fills.size, `mixed fills in one row: ${row}`).toBeLessThanOrEqual(1);
    }
    // Three solid rows, then the shaded bottom band.
    expect(rows[0]).not.toContain('▓');
    expect(rows[2]).not.toContain('▓');
    expect(rows[4]).not.toContain('█');
    expect(rows[4]).toContain('▓');
  });

  it('solid default fill has no shade characters anywhere', () => {
    const rows = renderPixelWord('CODE');
    for (const row of rows) {
      expect(row).not.toContain('▓');
    }
  });

  it('unknown characters fall back to space without breaking alignment', () => {
    const rows = renderPixelWord('V1.2');
    expect(rows).toHaveLength(PIXEL_FONT_HEIGHT);
    const widths = new Set(rows.map((r) => r.length));
    expect(widths.size).toBe(1);
  });

  it('splash rows are trimmed and non-empty', () => {
    const splash = renderMercuryCodeSplash();
    expect(splash).toHaveLength(PIXEL_FONT_HEIGHT);
    for (const row of splash) {
      expect(row.length).toBeGreaterThan(0);
      expect(row.endsWith(' ')).toBe(false);
    }
  });
});