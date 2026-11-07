/**
 * Text that is safe to put in a JSON body sent to a provider.
 *
 * A lone UTF-16 surrogate — what any index-based slice of a string holding an emoji produces —
 * travels through `JSON.stringify` as `\ud83c`, and some servers reject the whole body for it:
 * DeepSeek answers "400 Failed to parse the request body as JSON: messages[6].content: unexpected
 * end of hex escape". Measured against api.deepseek.com: the same string with the *raw* surrogate
 * in UTF-8 passes (200), the same one as an escape sequence is rejected (400). So a cut has to land
 * between two code points, and the text we send must no longer hold half a pair.
 */

const HIGH_SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdbff;
const LOW_SURROGATE_START = 0xdc00;
const LOW_SURROGATE_END = 0xdfff;

function isHigh(code: number): boolean {
  return code >= HIGH_SURROGATE_START && code <= HIGH_SURROGATE_END;
}

function isLow(code: number): boolean {
  return code >= LOW_SURROGATE_START && code <= LOW_SURROGATE_END;
}

/**
 * Drops lone surrogates. A valid pair (an emoji) is kept as it is: only the orphaned halves — the
 * ones that make the server fail — disappear.
 */
export function stripLoneSurrogates(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (isHigh(code)) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (isLow(next)) {
        out += text[i] + text[i + 1];
        i += 1;
        continue;
      }
      continue; // high without low: drop the half
    }
    if (isLow(code)) continue; // low without high: drop the half
    out += text[i];
  }
  return out;
}

/**
 * Cuts at `max` characters without ever splitting a surrogate pair, then drops whatever would still
 * be lone. `max` counts UTF-16 units, like `String.prototype.length`.
 */
export function truncateText(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return stripLoneSurrogates(text);
  let end = max;
  if (end > 0 && isHigh(text.charCodeAt(end - 1))) end -= 1; // the pair started just before the cut
  return stripLoneSurrogates(text.slice(0, end));
}
