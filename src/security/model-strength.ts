/**
 * Is this a frontier model? (ADR-044 amendment.)
 *
 * Large models notice and refuse instructions planted in what they read; the
 * report that started ADR-044 was a small model obeying an HTML comment that
 * big ones ignored. So the owner is asked to approve actions after an
 * outside read only when the model is small or unknown. With a strong model
 * the in-chat warning and the note after the content stay, and data leaving
 * in an address or command (exfil.ts) is still asked about: being talked
 * into sending a key out is not a size problem.
 *
 * Anything not recognised here counts as not strong: a new or unknown model
 * keeps the full protection until it is added.
 */

/** Small variants of strong families: never strong. */
const SMALL = /(?:^|[^a-z])(mini|nano|flash|lite|haiku|small|tiny|micro|gemma|phi)(?:[^a-z]|$)|(?:^|[^0-9])(?:[0-9]|[1-6][0-9])(?:\.\d+)?b(?:[^a-z]|$)/;

/** Families and sizes that resist planted instructions. Matched anywhere in the model id ("anthropic/claude-sonnet-4.5"). */
const STRONG: RegExp[] = [
  /claude[-_.\w]*(opus|sonnet|fable)|claude-(opus|sonnet|fable)/,
  /(^|[^a-z])gpt-?(4o|4\.1|4\.5|5)(?![\w.]*-(mini|nano))/,
  /(^|[^a-z])o[134](-pro)?(?:$|[^a-z0-9-]|-\d{4})/,
  /gemini[-_.\w]*pro/,
  /grok-?[34](?![\w.]*mini)/,
  /deepseek[-_.\w]*(v3|r1|reasoner|chat)/,
  /mistral-large|qwen3?-max|qwen3-235b|kimi-k2/,
];

export function isStrongModel(model: string | null | undefined): boolean {
  const id = String(model ?? '').toLowerCase().trim();
  if (!id) return false;
  if (SMALL.test(id)) return false;
  return STRONG.some((re) => re.test(id));
}
