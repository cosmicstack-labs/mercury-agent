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

  it('the mark is fully solid — no shade characters anywhere', () => {
    // Regression history: per-column shading punched holes mid-letter, and
    // even per-row shaded bands read as gaps between blocks in real
    // terminal fonts. The BRAND MARK (the splash) is now 100% solid bright
    // blocks; the shading API remains for callers that opt in explicitly.
    const splash = renderMercuryCodeSplash();
    expect(splash.join('\n')).not.toContain('▓');
    expect(splash.join('\n')).not.toContain('▒');
    // The shading API still bands per-row when explicitly requested.
    const shaded = renderPixelWord('CODE', '████▓');
    expect(shaded[0]).not.toContain('▓');
    expect(shaded[4]).not.toContain('█');
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