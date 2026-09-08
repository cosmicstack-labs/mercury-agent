import type { ChatMessage } from './types.js';
import { normalizeTerminalText } from './terminal-viewport.js';
import { renderMarkdown } from '../utils/markdown.js';
import { renderMercuryCodeHdParts, renderMercuryCodeParts } from './pixel-logo.js';

export type MercuryTranscriptKind = 'header' | 'text' | 'code-label' | 'code' | 'system' | 'file' | 'spacer' | 'brand';

export interface MercuryTranscriptLine {
  key: string;
  kind: MercuryTranscriptKind;
  role: ChatMessage['role'];
  text: string;
  lang?: string;
  /** Secondary colored segment for brand rows (the "CODE" wordmark part). */
  accent?: string;
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

function renderedTextLines(markdown: string, width: number): string[] {
  const rendered = stripTerminalAnsi(renderMarkdown(markdown));
  return rendered.split('\n').flatMap((line) => wrapMercuryText(line, width));
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
  // Double-resolution mark (10 pixel rows via half-blocks) when the terminal
  // is wide enough; the 5-row solid block mark otherwise.
  const hdParts = cols >= 80 ? renderMercuryCodeHdParts() : null;
  const parts = hdParts ?? renderMercuryCodeParts();
  const maxLen = Math.max(...parts.map((p) => p.left.length + 2 + p.right.length));
  const indent = Math.max(0, Math.floor((cols - maxLen) / 2));
  const versionStr = `v${version}`;
  const versionIndent = Math.max(0, indent + maxLen - versionStr.length - 1);
  const rows: MercuryTranscriptLine[] = parts.map((part, i) => ({
    key: `brand:${i}`,
    kind: 'brand' as const,
    role: 'system' as const,
    text: ' '.repeat(indent) + part.left,
    accent: part.right.length > 0 ? `  ${part.right}` : '',
  }));
  rows.push({
    key: 'brand:version',
    kind: 'brand',
    role: 'system',
    text: ' '.repeat(versionIndent) + versionStr,
    accent: '',
  });
  rows.push({ key: 'brand:spacer', kind: 'spacer', role: 'system', text: '' });
  return rows;
}

/** Visible rows per code block before it collapses to a pointer. */
export const CODE_BLOCK_VISIBLE_ROWS = 40;

export function buildMercuryMessageLines(message: ChatMessage, width: number): MercuryTranscriptLine[] {
  if (message.id.startsWith('heartbeat-')) return [];
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
          push('code-label', language.toUpperCase(), language);
        }
        continue;
      }
      if (inCode) {
        const chunks = wrapMercuryText(sourceLine, contentWidth);
        for (const chunk of chunks) push('code', chunk, language);
      } else {
        prose.push(sourceLine);
      }
    }
    flushProse();
  } else {
    push('header', message.role === 'user' ? 'YOU' : 'MERCURY');
    const source = normalizeTerminalText(message.content).split('\n');
    let prose: string[] = [];
    let inCode = false;
    let language = '';
    // Code-block collapse tracking (per message).
    let codeRowsEmitted = 0;
    let codeCollapsed = false;

    const flushProse = () => {
      if (prose.length === 0) return;
      for (const line of renderedTextLines(prose.join('\n'), contentWidth)) push('text', line);
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
          push('code-label', language.toUpperCase(), language);
        }
        continue;
      }
      if (inCode) {
        // Collapse long code blocks: the model quoting a 300-line file must
        // not push the conversation out of the transcript. The full content
        // is on disk / in the session store.
        if (codeRowsEmitted < CODE_BLOCK_VISIBLE_ROWS) {
          const chunks = wrapMercuryText(sourceLine, contentWidth);
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
  }

  if (message.fileChanges?.length) {
    push('system', `FILES CHANGED · ${message.fileChanges.length}`);
    for (const file of message.fileChanges) {
      const stats = file.added == null || file.removed == null ? 'binary' : `+${file.added} -${file.removed}`;
      for (const line of wrapMercuryText(`${file.path}  ${stats}`, contentWidth)) push('file', line);
    }
  }
  push('spacer', '');
  return lines;
}
