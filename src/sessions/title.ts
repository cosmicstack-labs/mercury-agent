export function normalizeGeneratedSessionTitle(raw: string): string | null {
  const firstLine = raw.split(/\r?\n/, 1)[0]
    .replace(/^\s*(?:title\s*:\s*)?/i, '')
    .replace(/^[`*_"'“”‘’]+|[`*_"'“”‘’]+$/g, '')
    .replace(/[.!?,;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const words = firstLine.split(' ').filter(Boolean).slice(0, 7);
  if (words.length < 3) return null;
  let title = '';
  for (const word of words) {
    const candidate = title ? `${title} ${word}` : word;
    if (candidate.length > 80) break;
    title = candidate;
  }
  if (title.split(' ').length < 3) title = words.join(' ').slice(0, 80).trim();
  return title || null;
}
