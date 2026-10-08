import type { ChatMessage } from './types.js';
import { TASK_SUMMARY_FILE_LIMIT } from './types.js';
import { normalizeTerminalText } from './terminal-viewport.js';
import { renderMarkdown } from '../utils/markdown.js';
import { devBuildLabel, isDevBuild } from '../utils/dev-build.js';
import { renderMercuryCodeParts } from './pixel-logo.js';
import stringWidth from 'string-width';

export type MercuryTranscriptKind = 'text' | 'code-label' | 'code' | 'system' | 'file' | 'spacer' | 'brand' | 'tool-head' | 'tool-out';

/** Gutter marker on a message's first row: `●` for the agent, `>` for the user. */
export type MercuryTranscriptLead = 'agent' | 'user';

export interface MercuryTranscriptLine {
  key: string;
  kind: MercuryTranscriptKind;
  role: ChatMessage['role'];
  text: string;
  lang?: string;
  /** Secondary colored segment for brand rows (the "CODE" wordmark part). */
  accent?: string;
  /** Set on the first row of a message: the gutter shows the role marker. */
  lead?: MercuryTranscriptLead;
  /** Tool rows: outcome color for the head marker and summary. */
  status?: 'done' | 'error';
  /** First tool-out row of a block: drawn with the ⎿ elbow. */
  elbow?: boolean;
}

// Chalk output is useful elsewhere, but wrapping must operate on visible text.
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

export function stripTerminalAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

export function wrapMercuryText(text: string, width: number): string[] {
  const limit = Math.max(12, width);
  if (text.length === 0) return [''];
  const lines: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let split = remaining.lastIndexOf(' ', limit);
    if (split < Math.floor(limit * 0.4)) split = limit;
    lines.push(remaining.slice(0, split).trimEnd());
    remaining = remaining.slice(split).trimStart();
  }
  lines.push(remaining);
  return lines;
}

// Control characters other than newline/tab. Model output is untrusted: raw
// escape sequences in it must never reach the terminal — only the styling
// renderMarkdown adds itself survives.
const CONTROL_RE = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

// OSC sequences (titles, hyperlinks, clipboard): ESC ] … terminated by BEL or ST.
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;

export function sanitizeTerminalText(text: string): string {
  return stripTerminalAnsi(text.replace(OSC_RE, '')).replace(CONTROL_RE, '');
}

// Visible prefix that continuation rows of a wrapped line should hang under:
// list bullets / numbers, blockquote rules, or plain leading indentation.
const HANGING_PREFIX_RE = /^(\s*(?:[•\-*]|\d+\.|│)\s+|\s+)(?=\S)/;
const SGR_RE = /\x1b\[([0-9;]*)m/g;
// SGR open code → the code that closes it (bold and dim share 22).
const SGR_CLOSERS: Record<string, string> = { 1: '22', 2: '22', 3: '23', 4: '24', 7: '27', 9: '29' };

function sgrCloser(code: string): string | undefined {
  const n = Number(code.split(';')[0]);
  if ((n >= 30 && n <= 38) || (n >= 90 && n <= 97)) return '39';
  if ((n >= 40 && n <= 48) || (n >= 100 && n <= 107)) return '49';
  return SGR_CLOSERS[code];
}

/** Replay SGR codes onto the active-style list (open codes, oldest first). */
function applySgr(active: string[], code: string): void {
  if (code === '' || code === '0') {
    active.length = 0;
    return;
  }
  const closesSomething = active.some((open) => sgrCloser(open) === code);
  if (closesSomething) {
    for (let i = active.length - 1; i >= 0; i--) if (sgrCloser(active[i]) === code) active.splice(i, 1);
    return;
  }
  active.push(code);
}

/**
 * Greedy word-wrap over plain text: row ranges [start, end). Rows after the
 * first get `width - indent` columns. Pure-ASCII text (the common case) skips
 * per-character width lookups entirely.
 */
function wrapRanges(plain: string, width: number, indent: number): Array<[number, number]> {
  const n = plain.length;
  const ascii = !/[^\x20-\x7e]/.test(plain);
  const widthAt = (i: number): number => {
    if (ascii) return 1;
    const code = plain.codePointAt(i)!;
    return code < 0x300 ? 1 : stringWidth(String.fromCodePoint(code));
  };
  const unitAt = (i: number): number => (plain.codePointAt(i)! > 0xffff ? 2 : 1);
  const ranges: Array<[number, number]> = [];
  let i = 0;
  while (i < n) {
    const limit = ranges.length === 0 ? width : width - indent;
    let col = 0;
    let j = i;
    let lastSpace = -1;
    while (j < n) {
      const w = widthAt(j);
      if (col + w > limit) break;
      if (plain[j] === ' ') lastSpace = j;
      col += w;
      j += unitAt(j);
    }
    if (j >= n) {
      ranges.push([i, n]);
      break;
    }
    // Break at a space when there is one in reach; hard-break long words.
    let end = plain[j] === ' ' ? j : lastSpace > i ? lastSpace : j;
    if (end === i) end = i + unitAt(i); // a single glyph wider than the row
    let trimmed = end;
    while (trimmed > i && plain[trimmed - 1] === ' ') trimmed--;
    ranges.push([i, trimmed]);
    i = end;
    while (i < n && plain[i] === ' ') i++;
  }
  return ranges;
}

/**
 * Wrap one styled (SGR) line to `width` visible columns. Breaks are computed
 * on the plain text and mapped back onto the styled string; each row reopens
 * the styles active at its start and resets at its end, so every row renders
 * correctly on its own. Continuation rows hang under the line's bullet/indent
 * (blockquotes repeat their rule). Hot path: runs per frame on the live tail.
 */
export function wrapStyledLine(line: string, width: number): string[] {
  const limit = Math.max(12, width);
  // plainPos[k] = index in `line` of plain char k; codes = SGR runs in order.
  const plainPos: number[] = [];
  const codes: Array<{ at: number; code: string }> = [];
  let plain = '';
  let last = 0;
  SGR_RE.lastIndex = 0;
  for (let m = SGR_RE.exec(line); m; m = SGR_RE.exec(line)) {
    for (let k = last; k < m.index; k++) plainPos.push(k);
    plain += line.slice(last, m.index);
    codes.push({ at: m.index, code: m[1] });
    last = m.index + m[0].length;
  }
  for (let k = last; k < line.length; k++) plainPos.push(k);
  plain += line.slice(last);
  if (plain.length === 0) return [''];

  const prefixMatch = HANGING_PREFIX_RE.exec(plain);
  const indent = prefixMatch && prefixMatch[1].length < limit / 2 ? prefixMatch[1].length : 0;
  const ranges = wrapRanges(plain, limit, indent);
  if (ranges.length === 1 && codes.length === 0) return [plain.slice(ranges[0][0], ranges[0][1])];

  const active: string[] = [];
  let codeIdx = 0;
  const advanceTo = (pos: number) => {
    while (codeIdx < codes.length && codes[codeIdx].at < pos) applySgr(active, codes[codeIdx++].code);
  };
  const reopen = () => active.map((c) => `\x1b[${c}m`).join('');
  const slice = (a: number, b: number): string => {
    const from = plainPos[a];
    const to = b < plain.length ? plainPos[b] : line.length;
    advanceTo(from);
    const open = reopen();
    advanceTo(to);
    return open + line.slice(from, to) + (active.length > 0 ? '\x1b[0m' : '');
  };
  // Blockquotes repeat their styled rule; everything else hangs on spaces.
  const continuation = plain.trimStart().startsWith('│') ? slice(0, indent) : ' '.repeat(indent);
  codeIdx = 0;
  active.length = 0;
  return ranges.map(([a, b], i) => (i === 0 ? '' : continuation) + slice(a, b));
}

function renderedTextLines(markdown: string, width: number): string[] {
  const rendered = renderMarkdown(sanitizeTerminalText(markdown));
  return rendered.split('\n').flatMap((line) => wrapStyledLine(line, width));
}

/**
 * Brand rows rendered as the transcript's leading rows. Scrolling treats
 * them like any other content: new messages push them up and away, exactly
 * like a web page header scrolling out of view. Empty accent = solid row;
 * non-empty accent splits the row into (text, accent) two-tone rendering.
 * `indent` centers the block exactly like the original standalone wordmark:
 * the indent is baked into `text`, so scroll math never has to special-case it.
 */
export function buildMercuryBrandLines(version: string, cols: number): MercuryTranscriptLine[] {
  const parts = renderMercuryCodeParts();
  const maxLen = Math.max(...parts.map((p) => p.left.length + 2 + p.right.length));
  const indent = Math.max(0, Math.floor((cols - maxLen) / 2));
  const versionStr = `v${version}`;
  // Dev builds badge the version row two-tone (accent) — an unmistakable
  // marker that this binary is a channel preview, on every TUI boot.
  const devSuffix = isDevBuild(version) ? `  ⚠ ${devBuildLabel(version)}` : '';
  const versionTotal = versionStr.length + devSuffix.length;
  const versionIndent = Math.max(0, indent + maxLen - versionTotal - 1);
  // Top padding: a clean band of air above the mark.
  const padRow: MercuryTranscriptLine = { key: 'brand:pad-top', kind: 'spacer', role: 'system', text: '' };
  const rows: MercuryTranscriptLine[] = [padRow, ...parts.map((part, i) => ({
    key: `brand:${i}`,
    kind: 'brand' as const,
    role: 'system' as const,
    text: ' '.repeat(indent) + part.left,
    accent: part.right.length > 0 ? `  ${part.right}` : '',
  }))];
  rows.push({
    key: 'brand:version',
    kind: 'brand',
    role: 'system',
    text: ' '.repeat(versionIndent) + versionStr,
    accent: devSuffix,
  });
  rows.push({ key: 'brand:spacer', kind: 'spacer', role: 'system', text: '' });
  return rows;
}

/** Visible rows per code block before it collapses to a pointer. */
export const CODE_BLOCK_VISIBLE_ROWS = 40;

/**
 * Live, rendered tail of a streaming message.
 *
 * The full markdown pipeline (renderMarkdown + code highlighting + wrap)
 * runs on the TAIL SLICE only, so per-frame work stays bounded by the tail
 * budget — never O(full buffer), which caused multi-GB allocation storms
 * during long streams.
 *
 * The slice is line-aligned and, when the pre-tail region ends inside a code
 * fence, backed up to the fence opener so the live block always contains a
 * complete fence (label + code rows) and renders as code — never as broken
 * prose. The capped row budget keeps the live frame small either way.
 */
export function buildStreamTailLines(
  message: ChatMessage,
  width: number,
  tailChars = 32 * 1024,
  maxLines = 48,
  options?: MessageLinesOptions,
): MercuryTranscriptLine[] {
  const content = message.content;
  if (content.length === 0) return [];
  const rawStart = Math.max(0, content.length - tailChars);
  const head = content.slice(0, rawStart);
  const insideFence = (head.match(/```/g) || []).length % 2 === 1;
  // Plain line alignment: never start the slice mid-line.
  let start = rawStart === 0 ? 0 : content.indexOf('\n', rawStart) + 1;
  if (start === 0 && rawStart > 0) start = rawStart; // no newline (single-line buffer)
  if (insideFence) {
    // Back up to the last fence opener at or before the raw start so the
    // slice contains the complete block. The scan is WINDOWED (bounded to
    // the tail budget before the slice start): scanning the whole head with
    // String.lastIndexOf ran O(head) per recompute on every throttle window.
    // An opener older than the window is beyond the tail budget anyway —
    // its block's visible rows are capped out by the row cap below.
    const windowStart = Math.max(0, start - tailChars);
    const opener = content.slice(windowStart, start).lastIndexOf('```');
    if (opener >= 0) start = windowStart + opener;
  }
  const tailMessage: ChatMessage = { ...message, content: content.slice(start) };
  // A sliced tail is never the start of the message: no role marker.
  const lines = buildMercuryMessageLines(tailMessage, width, start > 0 ? { showHeader: false } : options);
  // Newest rows win when the block outgrows the row cap.
  return lines.length > maxLines ? lines.slice(-maxLines) : lines;
}

export interface MessageLinesOptions {
  /** Mark the first row with the role marker. False for continuation chunks. */
  showHeader?: boolean;
}

/**
 * Progressive streaming flush.
 *
 * While a message streams, only complete markdown blocks are safe to print
 * into <Static> (which never repaints a printed item): a block is SETTLED
 * when its structure can no longer change as more content arrives —
 *
 *   - immediately after a closing code-fence line (fence parity even), or
 *   - after a blank line (fence parity even) that is followed, further down,
 *     by more content — i.e. the blank line terminated the block.
 *
 * The rule is PREFIX-STABLE: a boundary that qualifies on partial content
 * keeps qualifying as the stream grows (it only depends on already-fixed
 * context), so chunk indices — and therefore <Static> item keys — are the
 * same during streaming and after finalization. That is what lets the live
 * tail hand blocks to scrollback mid-stream without anything being printed
 * twice when the message finalizes.
 */
const FENCE_RE = /^```\s*([^\s`]*)/;

export function settledChunkEnds(content: string): number[] {
  if (content.length === 0) return [];
  const lines = content.split('\n');
  // Index of the last non-blank line: a blank-line boundary after line i
  // settles only if content resumes after the blank (i.e. the blank
  // TERMINATED a block rather than trailing the stream's current end).
  let lastNonBlank = -1;
  for (let i = 0; i < lines.length; i++) if (lines[i].trim() !== '') lastNonBlank = i;
  const ends: number[] = [];
  let inFence = false;
  let prevClosed = false; // previous line closed a fence and already settled a boundary
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineEnd = offset + line.length + 1; // + newline (virtual on the last line)
    offset = lineEnd;
    if (FENCE_RE.test(line)) inFence = !inFence;
    if (inFence) {
      prevClosed = false;
      continue;
    }
    const blank = line.trim() === '';
    const prevBlank = i > 0 && lines[i - 1].trim() === '';
    if (blank) {
      // Settle after the FIRST blank of a run (later blanks ride along in the
      // next chunk), and not right after a fence close (that line already
      // settled its own boundary).
      if (i > 0 && !prevBlank && !prevClosed && lastNonBlank > i) ends.push(lineEnd);
      prevClosed = false;
      continue;
    }
    if (FENCE_RE.test(line)) {
      // Non-blank line that just closed a fence: the block is complete now.
      ends.push(lineEnd);
      prevClosed = true;
      continue;
    }
    prevClosed = false;
  }
  return ends;
}

/** Module cache: settled-chunk scans are O(content) per call, and static
 * items are rebuilt every frame — finalized messages must be scanned once,
 * not per frame. Keyed by id + content length (content is append-only while
 * streaming, so length+prefix identifies the scan). */
const chunkCache = new Map<string, ChatMessage[]>();

function cachedChunks(key: string, content: string, compute: () => ChatMessage[]): ChatMessage[] {
  const hit = chunkCache.get(key);
  // Cheap staleness guard: content is append-only while streaming, so the
  // first chunk's head must always be a prefix of the current content.
  if (hit && hit.length > 0 && content.startsWith(hit[0].content.slice(0, 32))) return hit;
  const chunks = compute();
  if (chunkCache.size > 200) chunkCache.clear();
  chunkCache.set(key, chunks);
  return chunks;
}

function sliceChunks(message: ChatMessage, ends: number[], finalEnd: number): ChatMessage[] {
  const bounds = [...ends, finalEnd];
  return bounds.map((end, i) => ({
    ...message,
    id: `${message.id}#c${i}`,
    content: message.content.slice(i === 0 ? 0 : bounds[i - 1], end),
    fileChanges: i === bounds.length - 1 ? message.fileChanges : undefined,
    streaming: false,
  }));
}

/**
 * Chunks of a FINALIZED message: settled boundaries plus the tail as the
 * last chunk. Keys are identical to the chunks printed while the message
 * streamed, so finalization adds exactly one new <Static> item.
 */
export function splitFinalMessage(message: ChatMessage): ChatMessage[] {
  return cachedChunks(
    `${message.id}:${message.content.length}:final:${message.fileChanges?.length ?? -1}`,
    message.content,
    () => sliceChunks(message, settledChunkEnds(message.content), message.content.length),
  );
}

/** Settled chunks of a still-streaming message (tail excluded — it is still
 * growing) plus the offset where the unsettled remainder begins. */
export function splitStreamingMessage(message: ChatMessage): { chunks: ChatMessage[]; remainderStart: number } {
  const chunks = cachedChunks(
    `${message.id}:${message.content.length}:live:${message.fileChanges?.length ?? -1}`,
    message.content,
    () => sliceChunks(message, settledChunkEnds(message.content), message.content.length).slice(0, -1),
  );
  // Chunks are contiguous from offset 0, so the remainder starts where they end.
  const remainderStart = chunks.reduce((sum, c) => sum + c.content.length, 0);
  return { chunks, remainderStart };
}

/** True for synthetic progressive-chunk items (id `${msgId}#c<i>`). */
export function parseChunkIndex(id: string): number | null {
  const match = /#c(\d+)$/.exec(id);
  return match ? parseInt(match[1], 10) : null;
}

/** Columns taken by the ⎿ elbow / continuation indent of tool output rows. */
export const TOOL_OUT_INDENT = 5;

function truncateColumns(text: string, width: number): string {
  if (stringWidth(text) <= width) return text;
  let out = '';
  for (const ch of text) {
    if (stringWidth(out + ch) > width - 1) break;
    out += ch;
  }
  return `${out}…`;
}

/** Rows of a finished tool call: `● Title(target)`, the ⎿ summary, then the
 * excerpt. Output rows are truncated, not wrapped — a block stays compact. */
function buildToolLines(message: ChatMessage, width: number): MercuryTranscriptLine[] {
  const tool = message.tool!;
  const lines: MercuryTranscriptLine[] = [];
  let index = 0;
  const push = (line: Omit<MercuryTranscriptLine, 'key' | 'role'>) => {
    lines.push({ key: `${message.id}:${index++}`, role: message.role, ...line });
  };
  const target = sanitizeTerminalText(tool.target);
  const headWidth = Math.max(12, width - 2 - stringWidth(tool.title) - 2);
  push({ kind: 'tool-head', text: tool.title, accent: target ? truncateColumns(target, headWidth) : '', status: tool.status });
  const outWidth = Math.max(12, width - TOOL_OUT_INDENT);
  push({ kind: 'tool-out', text: truncateColumns(sanitizeTerminalText(tool.summary), outWidth), status: tool.status, elbow: true });
  for (const row of tool.body?.lines ?? []) {
    const clean = sanitizeTerminalText(row).replace(/\t/g, '  ');
    // "… +N lines" markers are prose, not code — never highlight them.
    const marker = /^… /.test(clean);
    push({ kind: 'tool-out', text: truncateColumns(clean, outWidth), lang: marker ? undefined : tool.body!.lang || undefined, status: tool.status });
  }
  push({ kind: 'spacer', text: '' });
  return lines;
}

export function buildMercuryMessageLines(
  message: ChatMessage,
  width: number,
  options?: MessageLinesOptions,
): MercuryTranscriptLine[] {
  if (message.id.startsWith('heartbeat-')) return [];
  if (message.tool) return buildToolLines(message, Math.max(12, width - 4));
  const contentWidth = Math.max(12, width - 4);
  const lines: MercuryTranscriptLine[] = [];
  let index = 0;
  const push = (kind: MercuryTranscriptKind, text: string, lang?: string) => {
    lines.push({ key: `${message.id}:${index++}`, kind, role: message.role, text, lang });
  };

  if (message.role === 'system') {
    // System messages can carry fenced blocks (file-change previews with
    // diff/code excerpts) — parse fences so the TUI renders them with the
    // same syntax highlighting as agent code, just without a header row.
    const source = normalizeTerminalText(message.content).split('\n');
    let inCode = false;
    let language = '';
    let prose: string[] = [];

    const flushProse = () => {
      if (prose.length === 0) return;
      for (const line of renderedTextLines(prose.join('\n'), contentWidth)) push('system', line);
      prose = [];
    };

    for (const sourceLine of source) {
      const fence = /^```\s*([^\s`]*)/.exec(sourceLine);
      if (fence) {
        if (inCode) {
          inCode = false;
          language = '';
        } else {
          flushProse();
          inCode = true;
          language = fence[1] || 'text';
          push('code-label', language, language);
        }
        continue;
      }
      if (inCode) {
        const chunks = wrapMercuryText(sanitizeTerminalText(sourceLine), contentWidth);
        for (const chunk of chunks) push('code', chunk, language);
      } else {
        prose.push(sourceLine);
      }
    }
    flushProse();
  } else {
    const source = normalizeTerminalText(message.content).split('\n');
    let prose: string[] = [];
    let inCode = false;
    let language = '';
    // Code-block collapse tracking (per message).
    let codeRowsEmitted = 0;
    let codeCollapsed = false;

    // One blank row between a fenced block and the prose around it.
    const gap = () => {
      const last = lines[lines.length - 1];
      if (last && !(last.kind === 'text' && stripTerminalAnsi(last.text).trim() === '')) push('text', '');
    };

    const flushProse = () => {
      if (prose.length === 0) return;
      const last = lines[lines.length - 1];
      if (last && last.kind !== 'text') gap();
      // User input is shown as typed; agent prose renders as markdown.
      const rows = message.role === 'user'
        ? prose.flatMap((line) => wrapMercuryText(sanitizeTerminalText(line), contentWidth))
        : renderedTextLines(prose.join('\n'), contentWidth);
      for (const line of rows) push('text', line);
      prose = [];
    };

    for (const sourceLine of source) {
      const fence = /^```\s*([^\s`]*)/.exec(sourceLine);
      if (fence && message.role !== 'user') {
        if (inCode) {
          inCode = false;
          language = '';
        } else {
          flushProse();
          gap();
          inCode = true;
          language = fence[1] || 'text';
          push('code-label', language, language);
        }
        continue;
      }
      if (inCode) {
        // Collapse long code blocks: the model quoting a 300-line file must
        // not push the conversation out of the transcript. The full content
        // is on disk / in the session store.
        if (codeRowsEmitted < CODE_BLOCK_VISIBLE_ROWS) {
          const chunks = wrapMercuryText(sanitizeTerminalText(sourceLine), contentWidth);
          for (const chunk of chunks) push('code', chunk, language);
          codeRowsEmitted += chunks.length;
        } else if (!codeCollapsed) {
          codeCollapsed = true;
          push('system', `… code continues — ${'full content on disk'}`);
        }
      } else {
        prose.push(sourceLine);
      }
    }
    flushProse();
    // Headings render with a blank row above them; at the top of a message
    // that row would push the role marker off the first visible line.
    while (lines.length > 0 && lines[0].kind === 'text' && stripTerminalAnsi(lines[0].text).trim() === '') lines.shift();
    if (options?.showHeader !== false && lines.length > 0) lines[0].lead = message.role === 'user' ? 'user' : 'agent';
  }

  if (message.fileChanges?.length) {
    push('system', `FILES CHANGED · ${message.fileChanges.length}`);
    // End-of-task summary rule: list at most TASK_SUMMARY_FILE_LIMIT paths —
    // the count line above still shows the full number, the complete list
    // lives in git.
    const files = message.fileChanges;
    for (const file of files.slice(0, TASK_SUMMARY_FILE_LIMIT)) {
      const stats = file.added == null || file.removed == null ? 'binary' : `+${file.added} -${file.removed}`;
      for (const line of wrapMercuryText(`${file.path}  ${stats}`, contentWidth)) push('file', line);
    }
    if (files.length > TASK_SUMMARY_FILE_LIMIT) {
      push('file', `… ${files.length - TASK_SUMMARY_FILE_LIMIT} more`);
    }
  }
  push('spacer', '');
  return lines;
}
