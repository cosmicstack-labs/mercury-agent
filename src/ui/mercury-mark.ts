/**
 * The Mercury mark: the planetary symbol ☿ (crescent, ring, cross) drawn as
 * half-block pixel art. Every filled cell is a single-codepoint block
 * character (█ ▀ ▄), which terminals render exactly one cell wide, so the
 * mark is pixel-aligned everywhere — the earlier box-drawing outline had
 * corners and sides in different columns and broke apart on screen.
 *
 * Both sizes are generated from the same geometry (crescent arc above a
 * ring, a stem with a crossbar below) and are left/right symmetric around
 * their centre column. Keep them as literals: generating at runtime would
 * make the art depend on floating-point rounding.
 */

/** Hero mark: 19 cols × 13 rows. Used on the launch pad at ≥ 60 columns. */
export const MERCURY_MARK = [
  '██               ██',
  '▀██▄           ▄██▀',
  '  ▀▀███▄▄▄▄▄███▀▀',
  '     ▄▄▄▄▄▄▄▄▄',
  ' ▄▄██▀▀     ▀▀██▄▄',
  '███             ███',
  '███             ███',
  ' ▀▀██▄▄     ▄▄██▀▀',
  '     ▀▀▀███▀▀▀',
  '        ███',
  '   █████████████',
  '        ███',
  '        ███',
] as const;

/** Compact mark: 15 cols × 10 rows, for medium-width terminals. */
export const MERCURY_MARK_SMALL = [
  '██           ██',
  ' ▀██▄▄▄▄▄▄▄██▀',
  '    ▄█████▄',
  ' ▄█▀▀     ▀▀█▄',
  '███         ███',
  ' ▀█▄▄     ▄▄█▀',
  '    ▀▀███▀▀',
  '   ▄▄▄███▄▄▄',
  '   ▀▀▀███▀▀▀',
  '      ███',
] as const;

export const MERCURY_MARK_WIDTH = 19;
export const MERCURY_MARK_SMALL_WIDTH = 15;
