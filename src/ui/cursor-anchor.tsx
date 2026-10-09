import React from 'react';
import { Text } from 'ink';

/**
 * The input's cursor cell, and the anchor for the REAL terminal cursor
 * (#41, #66, ADR-017).
 *
 * Ink hides the hardware cursor and leaves it on the line below the live
 * region, so IME preedit text and candidate windows open in the wrong place,
 * and some terminals suppress IME composition entirely while the cursor is
 * hidden. The vendored ink (vendor/ink, "Hardware cursor" hunk) looks for a
 * host element carrying the `internal_cursor` attribute after every frame and
 * parks the terminal cursor on that cell (`CSI ?25h` + relative moves); when
 * no element is marked the cursor stays hidden.
 *
 * The attribute is read from ink's DOM node, not through a ref: refs attach in
 * React's layout phase, after ink has already rendered the committed frame,
 * so a ref-based anchor would always lag one frame behind.
 *
 * The inverse "fake" cell is kept: it is the cursor on terminals that ignore
 * `?25h` (or inside multiplexers that hide it), and it marks the position in
 * screenshots and recordings.
 */
export function CursorCell({ glyph, active }: { glyph: string; active: boolean }): React.ReactElement {
  // `ink-box` is ink's host element (what <Box> renders). Only `style` and
  // `internal_*` props are interpreted; everything else lands in
  // node.attributes, which is where the renderer reads `internal_cursor`.
  return React.createElement(
    'ink-box',
    { style: { flexShrink: 0 }, internal_cursor: active },
    <Text inverse>{glyph}</Text>,
  );
}

/** `MERCURY_HW_CURSOR=0` keeps the hardware cursor hidden (fake cell only). */
export function hardwareCursorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.MERCURY_HW_CURSOR ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

/** Apply the env switch to the vendored ink's global cursor toggle. */
export function configureHardwareCursor(env: NodeJS.ProcessEnv = process.env): void {
  const anchor = (globalThis as any).__mercuryCursorAnchor as { enabled: boolean } | undefined;
  if (anchor) anchor.enabled = hardwareCursorEnabled(env);
}
