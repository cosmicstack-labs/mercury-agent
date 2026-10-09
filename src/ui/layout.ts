/**
 * Width rules for the TUI (ROADMAP §3B / P2.8). Every horizontal measure is
 * derived from the live terminal width instead of fixed 60/50/34+56/26
 * constants, so Termux phones and split panes (40–60 columns) never wrap a
 * live-region row into a second line — a wrapped row changes the live
 * region's height, which is what makes ink's erase arithmetic churn.
 */

/** Below this width the splash and the side panels collapse to one column. */
export const NARROW_COLS = 60;

export function isNarrow(cols: number): boolean {
  return cols < NARROW_COLS;
}

/** A horizontal rule that fits inside `gutter` columns of padding. */
export function ruleWidth(cols: number, max: number, gutter = 2): number {
  return Math.max(1, Math.min(max, cols - gutter));
}

/** Width of the coding/chat side panel, or 0 when it collapses. */
export function sidePanelWidth(cols: number, preferred: number): number {
  return isNarrow(cols) ? 0 : preferred;
}

/** Truncate to `max` display cells (ASCII-safe; callers pass plain labels). */
export function fitText(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  if (max === 1) return '…';
  return text.slice(0, max - 1) + '…';
}

/** Keep the END of a path-like label (the useful part), e.g. "…/src/ui". */
export function fitTail(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  if (max <= 3) return text.slice(-max);
  return '...' + text.slice(-(max - 3));
}

/**
 * Columns of the Mercury Code hint table that fit: command · description ·
 * key at full width, dropping the description (then the key) when narrow.
 */
export function hintColumns(cols: number, cmdW: number, descW: number, keyW: number): { desc: boolean; key: boolean } {
  const avail = cols - 4;
  if (cmdW + 2 + descW + 2 + keyW <= avail) return { desc: true, key: true };
  if (cmdW + 2 + keyW <= avail) return { desc: false, key: true };
  return { desc: false, key: false };
}
