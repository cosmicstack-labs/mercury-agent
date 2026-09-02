import type { ChatMessage } from './types.js';
import { normalizeTerminalText } from './terminal-viewport.js';
import { renderMarkdown } from '../utils/markdown.js';

export type MercuryTranscriptKind = 'header' | 'text' | 'code-label' | 'code' | 'system' | 'file' | 'spacer';

export interface MercuryTranscriptLine {
  key: string;
  kind: MercuryTranscriptKind;
  role: ChatMessage['role'];
  text: string;
  lang?: string;
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

export function buildMercuryMessageLines(message: ChatMessage, width: number): MercuryTranscriptLine[] {
  if (message.id.startsWith('heartbeat-')) return [];
  const contentWidth = Math.max(12, width - 4);
  const lines: MercuryTranscriptLine[] = [];
  let index = 0;
  const push = (kind: MercuryTranscriptKind, text: string, lang?: string) => {
    lines.push({ key: `${message.id}:${index++}`, kind, role: message.role, text, lang });
  };

  if (message.role === 'system') {
    for (const line of renderedTextLines(normalizeTerminalText(message.content), contentWidth)) push('system', line);
  } else {
    push('header', message.role === 'user' ? 'YOU' : 'MERCURY');
    const source = normalizeTerminalText(message.content).split('\n');
    let prose: string[] = [];
    let inCode = false;
    let language = '';

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
        const chunks = wrapMercuryText(sourceLine, contentWidth);
        for (const chunk of chunks) push('code', chunk, language);
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
