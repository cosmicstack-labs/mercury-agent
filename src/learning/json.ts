/**
 * Lenient JSON for model output: strips code fences and repairs output that
 * was cut off by the token limit (unclosed strings, objects and arrays are
 * closed at the last complete value). Returns null when nothing parses.
 */
export function parseJsonLenient(text: string): unknown {
  let raw = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)(?:\s*```)?\s*$/i.exec(raw);
  if (fence) raw = fence[1].trim();
  const start = raw.search(/[[{]/);
  if (start < 0) return null;
  raw = raw.slice(start);
  const end = Math.max(raw.lastIndexOf('}'), raw.lastIndexOf(']'));
  if (end >= 0 && raw.slice(end + 1).trim() === '') raw = raw.slice(0, end + 1);
  try { return JSON.parse(raw); } catch { /* repair below */ }
  // Cut back to the last complete value, close what is open, retry.
  let cut = raw.length;
  for (let attempt = 0; attempt < 60; attempt++) {
    const candidate = closeOpen(raw.slice(0, cut));
    if (candidate) {
      try { return JSON.parse(candidate); } catch { /* keep cutting */ }
    }
    const prev = Math.max(raw.lastIndexOf('}', cut - 2), raw.lastIndexOf(']', cut - 2), raw.lastIndexOf(',', cut - 2));
    if (prev <= 0) break;
    cut = prev + 1;
  }
  return null;
}

/** Drop a trailing partial token, then append the closers for every open bracket. */
function closeOpen(s: string): string | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of s) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      if (stack.pop() !== ch) return null;
    }
  }
  let out = inString ? s + '"' : s;
  out = out.replace(/,\s*$/, '').replace(/:\s*$/, ': null').replace(/,\s*"[^"]*"?\s*$/, '');
  return out + stack.reverse().join('');
}
