/**
 * SentenceBuffer — converts an LLM token stream into TTS-friendly chunks.
 *
 * Design principles (from the agreed plan):
 *   - First chunk must flush fast to minimize time-to-first-audio.
 *     Tier-1 rules: 3-5 words OR 250 ms OR any hard punctuation.
 *   - Subsequent chunks should be larger for natural prosody.
 *     Tier-2 rules: 8+ word phrases OR 12 words OR 120 chars OR 400 ms idle.
 *   - Never split mid-word: flush only at whitespace or punctuation.
 *   - Code fences and inline `code` are stripped from the audio path
 *     entirely (still rendered to the screen by the caller).
 *   - Markdown decoration is removed (`**`, `*`, `_`, `~~`, leading `#`,
 *     bullets, link URLs).
 *   - Optional number/URL/symbol normalization for better synthesis.
 *
 * Output ordering is preserved exactly. Each chunk emitted is at least one
 * complete word; consumers may concatenate without re-tokenizing.
 */

export interface SentenceBufferOptions {
  /** When true, applies normalize() to each chunk before yielding. */
  normalize?: boolean;
  /** Override timing for tests. */
  firstChunkMaxMs?: number;
  warmChunkMaxMs?: number;
}

export interface SentenceChunk {
  text: string;
  /** True for the very first chunk of an utterance — useful for telemetry. */
  isFirst: boolean;
  /** True when this is the last chunk; downstream may signal end-of-stream. */
  isLast: boolean;
}

const HARD_PUNCT_RE = /[.!?\n]/;
const SOFT_PUNCT_RE = /[,;:—]/;
const WORD_END_RE   = /[\s\.\!\?,;:\—\n]/;

/* ── Markdown / code stripping helpers ────────────────────────────────── */

export function stripMarkdownForTTS(input: string): string {
  let out = input;
  // Block code fences: remove ```lang\n ... ``` entirely.
  out = out.replace(/```[\s\S]*?```/g, ' ');
  // Inline code: drop `…` content (it almost always reads badly).
  out = out.replace(/`[^`]*`/g, ' ');
  // Markdown links: keep label, drop URL.
  out = out.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Bold/italic/strikethrough markers.
  out = out.replace(/\*\*|\*|__|_|~~/g, '');
  // Leading list bullets / heading markers.
  out = out.replace(/^[\s>]*([*\-+]|\d+\.)\s+/gm, '');
  out = out.replace(/^#+\s+/gm, '');

  // Markdown tables — without this, every `|` was read as the literal
  // word "vertical bar" by Cartesia, and table-separator rows like
  // `|---|---|---|` came out as a long string of "dash, dash, dash".
  //   1. Drop whole separator rows (only pipes, dashes, colons, spaces).
  //   2. Strip leading/trailing pipes on each line so we don't get
  //      "vertical bar" at row boundaries.
  //   3. Convert remaining internal pipes to ", " so cells read as a
  //      natural list rather than running together.
  out = out.replace(/^\s*\|?[\s\-:|]+\|?\s*$/gm, '');
  out = out.replace(/^\s*\|/gm, '');
  out = out.replace(/\|\s*$/gm, '');
  out = out.replace(/\s*\|\s*/g, ', ');

  // Box-drawing characters from ASCII art / nested CLI output tables.
  out = out.replace(/[\u2500-\u257F\u2580-\u259F]/g, ' ');

  // Long horizontal rules ("---", "***", "===" of >=3 chars on a line)
  // would otherwise be read as "dash dash dash …".
  out = out.replace(/^\s*[-*=]{3,}\s*$/gm, '');

  // Markdown blockquote leader.
  out = out.replace(/^\s*>\s?/gm, '');

  // Backslash escapes -> drop the backslash, keep the char.
  out = out.replace(/\\([\\`*_{}\[\]()#+\-.!|>])/g, '$1');

  // Collapse repeated whitespace and punctuation runs introduced by the
  // strips above (e.g. ", , ," after empty cells).
  out = out.replace(/(,\s*){2,}/g, ', ');
  out = out.replace(/[ \t]+/g, ' ');
  // Trim each line and drop blank lines that became blank after stripping.
  out = out
    .split('\n')
    .map((l) => l.trim())
    .filter((l, i, arr) => l !== '' || (i > 0 && arr[i - 1] !== ''))
    .join('\n');
  return out;
}

export function normalizeForTTS(input: string): string {
  let out = input;
  // URLs → "link".
  out = out.replace(/https?:\/\/\S+/g, 'link');
  // Drop most emoji (BMP supplementary blocks). Keeps prose intact.
  out = out.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '');
  // Collapse runs of digits with commas: keep them as-is; TTS providers
  // handle "1,234" reasonably well. We deliberately don't try to spell out
  // numbers — providers do that better.
  return out;
}

/* ── Tiered chunker ───────────────────────────────────────────────────── */

export class SentenceBuffer {
  private buf = '';
  private firstFlushed = false;
  private firstTokenAt = 0;
  private lastTokenAt = 0;
  private closed = false;
  // In-fence tracking: whether we're currently inside a ```code block.
  private inFence = false;
  private pendingFenceMarker = '';

  private readonly opts: Required<SentenceBufferOptions>;

  constructor(opts: SentenceBufferOptions = {}) {
    this.opts = {
      normalize: opts.normalize ?? true,
      firstChunkMaxMs: opts.firstChunkMaxMs ?? 250,
      warmChunkMaxMs: opts.warmChunkMaxMs ?? 400,
    };
  }

  /**
   * Feed a token (or arbitrary text fragment) from the LLM stream.
   * Returns any chunks ready to flush, in order. Empty array is common.
   */
  push(token: string): SentenceChunk[] {
    if (this.closed || !token) return [];
    const now = performance.now();
    if (this.firstTokenAt === 0) this.firstTokenAt = now;
    this.lastTokenAt = now;

    // Track code-fence state so we can suppress code from the audio path.
    // We accumulate into a small holding buffer that may contain partial
    // backticks across multiple push() calls.
    this.pendingFenceMarker += token;
    const { stripped, inFence } = stripCodeFences(this.pendingFenceMarker, this.inFence);
    this.inFence = inFence;
    this.pendingFenceMarker = '';
    this.buf += stripped;

    return this.tryFlush(now);
  }

  /**
   * Signal end of stream. Returns any remaining buffered text as the
   * final chunk (marked isLast).
   */
  end(): SentenceChunk[] {
    if (this.closed) return [];
    this.closed = true;
    const out: SentenceChunk[] = [];
    const remaining = this.buf.trim();
    if (remaining.length > 0) {
      out.push(this.makeChunk(remaining, /* isLast */ true));
      this.buf = '';
    } else if (this.firstFlushed) {
      // Empty trailing chunk so consumers can clean up.
      out.push({ text: '', isFirst: false, isLast: true });
    }
    return out;
  }

  /**
   * Called periodically (e.g. on a 50–100 ms timer) to trigger time-based
   * flushes when no new tokens arrive. Returns ready chunks.
   */
  tick(): SentenceChunk[] {
    if (this.closed || this.buf.length === 0) return [];
    return this.tryFlush(performance.now());
  }

  reset(): void {
    this.buf = '';
    this.firstFlushed = false;
    this.firstTokenAt = 0;
    this.lastTokenAt = 0;
    this.closed = false;
    this.inFence = false;
    this.pendingFenceMarker = '';
  }

  /* ── Internal ──────────────────────────────────────────────────────── */

  private tryFlush(now: number): SentenceChunk[] {
    const out: SentenceChunk[] = [];
    while (true) {
      const idx = this.firstFlushed
        ? this.findWarmFlushIndex(now)
        : this.findFirstFlushIndex(now);
      if (idx < 0) break;
      const slice = this.buf.slice(0, idx + 1);
      this.buf = this.buf.slice(idx + 1);
      const cleaned = slice.trim();
      if (cleaned.length === 0) continue;
      out.push(this.makeChunk(cleaned, /* isLast */ false));
      this.firstFlushed = true;
    }
    return out;
  }

  /** Tier-1: flush as soon as we have 3–5 words, hard punct, or 250 ms. */
  private findFirstFlushIndex(now: number): number {
    const elapsed = now - this.firstTokenAt;
    const wordCount = countWords(this.buf);

    // Hard punctuation at any point → flush there.
    const hard = lastIndexOfMatch(this.buf, HARD_PUNCT_RE);
    if (hard >= 0) return hard;

    // 5 words with at least one terminal word boundary → flush at the boundary.
    if (wordCount >= 5) {
      const end = lastWordBoundary(this.buf);
      if (end > 0) return end;
    }

    // Timeout: 3+ words and >= firstChunkMaxMs → flush at last boundary.
    if (elapsed >= this.opts.firstChunkMaxMs && wordCount >= 3) {
      const end = lastWordBoundary(this.buf);
      if (end > 0) return end;
    }
    return -1;
  }

  /** Tier-2: longer chunks for prosody. */
  private findWarmFlushIndex(now: number): number {
    const wordCount = countWords(this.buf);

    // Hard punctuation always wins.
    const hard = lastIndexOfMatch(this.buf, HARD_PUNCT_RE);
    if (hard >= 0) return hard;

    // Soft punctuation after >= 8 words.
    if (wordCount >= 8) {
      const soft = lastIndexOfMatch(this.buf, SOFT_PUNCT_RE);
      if (soft >= 0) return soft;
    }

    // Hard caps.
    if (wordCount >= 12 || this.buf.length >= 120) {
      const end = lastWordBoundary(this.buf);
      if (end > 0) return end;
    }

    // Idle timeout.
    const idle = now - this.lastTokenAt;
    if (idle >= this.opts.warmChunkMaxMs && wordCount >= 3) {
      const end = lastWordBoundary(this.buf);
      if (end > 0) return end;
    }
    return -1;
  }

  private makeChunk(raw: string, isLast: boolean): SentenceChunk {
    let text = stripMarkdownForTTS(raw).trim();
    if (this.opts.normalize) text = normalizeForTTS(text);
    text = text.replace(/\s+/g, ' ').trim();
    const isFirst = !this.firstFlushed;
    return { text, isFirst, isLast };
  }
}

/* ── String helpers ───────────────────────────────────────────────────── */

function countWords(s: string): number {
  const t = s.trim();
  if (!t) return 0;
  return t.split(/\s+/).length;
}

function lastWordBoundary(s: string): number {
  for (let i = s.length - 1; i > 0; i--) {
    if (WORD_END_RE.test(s[i])) return i;
  }
  return -1;
}

function lastIndexOfMatch(s: string, re: RegExp): number {
  for (let i = s.length - 1; i >= 0; i--) {
    if (re.test(s[i])) return i;
  }
  return -1;
}

/**
 * Strip ```code fences``` from a streaming buffer while tracking whether
 * we end inside an open fence. Inline triple-backticks anywhere toggle
 * state. Returns the cleaned text (with fences replaced by a space) plus
 * the new in-fence state.
 */
function stripCodeFences(s: string, startInFence: boolean): { stripped: string; inFence: boolean } {
  let out = '';
  let inFence = startInFence;
  let i = 0;
  while (i < s.length) {
    if (s[i] === '`' && s[i + 1] === '`' && s[i + 2] === '`') {
      inFence = !inFence;
      i += 3;
      continue;
    }
    if (!inFence) out += s[i];
    i++;
  }
  return { stripped: out, inFence };
}
