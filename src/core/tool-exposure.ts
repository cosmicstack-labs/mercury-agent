/**
 * Mode-aware tool exposure.
 *
 * Every tool schema is re-sent on every step of a turn (up to 75 steps), and
 * niche groups cost real tokens: the 14 Spotify tools alone are roughly 1.7K
 * tokens of schema. They stay registered — the model can still be routed to
 * them — but they are only included in a request when the turn looks like it
 * is about them. Returns undefined when nothing should be trimmed so callers
 * can pass the AI SDK `activeTools` option through unchanged.
 */

const SPOTIFY_PREFIX = 'spotify_';
const SPOTIFY_HINT = /\b(spotify|music|song|songs|playlist|playlists|track|tracks|album|albums|artist|volume|play|pause|resume|skip|shuffle|now playing|listening|queue)\b/i;

/** How many recent history entries count as context for the hint check. */
const RECENT_CONTEXT_ENTRIES = 4;

export function selectActiveTools(
  allToolNames: readonly string[],
  message: string,
  recentHistory: readonly string[] = [],
): string[] | undefined {
  const spotify = allToolNames.filter((name) => name.startsWith(SPOTIFY_PREFIX));
  if (spotify.length === 0) return undefined;
  const corpus = [message, ...recentHistory.slice(-RECENT_CONTEXT_ENTRIES)].join('\n');
  if (SPOTIFY_HINT.test(corpus)) return undefined;
  return allToolNames.filter((name) => !name.startsWith(SPOTIFY_PREFIX));
}
