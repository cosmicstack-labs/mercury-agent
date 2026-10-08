/**
 * Terminal background detection, so TUI colors stay readable on light
 * terminals (yellow and bright cyan nearly vanish on white).
 *
 * `MERCURY_THEME=light|dark` wins; otherwise COLORFGBG ("fg;bg", set by
 * iTerm2, Konsole, rxvt, …) decides: background 7 (light gray) or 10–15
 * (bright colors, 15 = white) is light. Terminals that set neither — e.g.
 * macOS Terminal.app — are assumed dark; light users set MERCURY_THEME.
 */
export type TerminalTheme = 'light' | 'dark';

export function detectTerminalTheme(env: NodeJS.ProcessEnv = process.env): TerminalTheme {
  const forced = env.MERCURY_THEME?.trim().toLowerCase();
  if (forced === 'light' || forced === 'dark') return forced;
  const fgBg = env.COLORFGBG;
  if (!fgBg) return 'dark';
  const parts = fgBg.split(';');
  const bg = Number(parts[parts.length - 1]);
  if (Number.isNaN(bg)) return 'dark';
  return bg === 7 || (bg >= 10 && bg <= 15) ? 'light' : 'dark';
}

/** Resolved once per process: the terminal doesn't change under us. */
export const IS_LIGHT_TERMINAL = detectTerminalTheme() === 'light';
