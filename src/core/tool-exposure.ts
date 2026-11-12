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

/**
 * Niche groups: left out of a request unless the turn (or the last few
 * messages) is about them. Only groups with an unmistakable vocabulary are
 * gated — a missed general-purpose tool would make Mercury refuse work it
 * can do; a missed diagram tool costs one "draw it" follow-up at most.
 */
const NICHE_GROUPS: ReadonlyArray<{ prefix: string; hint: RegExp }> = [
  {
    prefix: 'spotify_',
    hint: /\b(spotify|music|song|songs|playlist|playlists|track|tracks|album|albums|artist|volume|play|pause|resume|skip|shuffle|now playing|listening|queue)\b/i,
  },
  {
    // draw.io plugin: ~7 KB of schemas on every request otherwise (ADR-039).
    prefix: 'drawio__',
    hint: /\b(draw\.?io|diagrams?|flow ?charts?|mermaid|uml|erd|sequence chart|architecture (?:chart|drawing|sketch)|org ?chart|mind ?map|wireframes?|drawing|draw)\b/i,
  },
];

/** How many recent history entries count as context for the hint check. */
const RECENT_CONTEXT_ENTRIES = 4;

export function selectActiveTools(
  allToolNames: readonly string[],
  message: string,
  recentHistory: readonly string[] = [],
): string[] | undefined {
  const corpus = [message, ...recentHistory.slice(-RECENT_CONTEXT_ENTRIES)].join('\n');
  const dropped = NICHE_GROUPS.filter((g) => allToolNames.some((n) => n.startsWith(g.prefix)) && !g.hint.test(corpus));
  if (dropped.length === 0) return undefined;
  return allToolNames.filter((name) => !dropped.some((g) => name.startsWith(g.prefix)));
}
