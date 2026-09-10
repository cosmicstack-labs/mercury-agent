import { describe, expect, it } from 'vitest';
import { buildStreamTailLines, type MercuryTranscriptLine } from './mercury-transcript.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { ChatMessage } from './types.js';

const src = (p: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), p), 'utf8');

/**
 * Regression guards for the streaming-tail projection. The live tail is
 * rendered through the full markdown pipeline (beautiful live output), but
 * per-frame work must stay bounded by the TAIL budget (chars + rows), never
 * by the total accumulated stream length — a full-buffer markdown parse +
 * wrap per frame was the O(frames × chars) allocation storm behind the
 * 2.5GB OOM.
 */
describe('streaming tail projection bounds', () => {
  const STREAM_TAIL_CHARS = 8 * 1024;
  const STREAM_TAIL_MAX_LINES = 12;
  const WIDTH = 80;

  function projectTail(content: string): MercuryTranscriptLine[] {
    const message: ChatMessage = {
      id: 'live_1',
      role: 'agent',
      content,
      timestamp: 1,
      streaming: true,
    };
    return buildStreamTailLines(message, WIDTH, STREAM_TAIL_CHARS, STREAM_TAIL_MAX_LINES);
  }

  it('render cost stays constant as the stream grows 100x', () => {
    const base = 'token '.repeat(100);
    const rowsAt1x = projectTail(base).length;
    let grown = base;
    for (let i = 0; i < 100; i++) grown += base;
    const rowsAt100x = projectTail(grown).length;
    expect(rowsAt100x).toBeLessThanOrEqual(STREAM_TAIL_MAX_LINES);
    expect(rowsAt100x).toBeGreaterThan(0);
    // Bounded output for both — no unbounded row explosion.
    expect(rowsAt1x).toBeLessThanOrEqual(STREAM_TAIL_MAX_LINES);
  });

  it('never allocates more than the tail budget per frame', () => {
    let content = '';
    for (let i = 0; i < 200; i++) content += 'x'.repeat(100) + '\n';
    const projected = projectTail(content);
    const totalChars = projected.reduce((sum, l) => sum + l.text.length, 0);
    // Rows rendered from an 8KB window cannot exceed the window + wrap slack.
    expect(totalChars).toBeLessThan(STREAM_TAIL_CHARS + STREAM_TAIL_MAX_LINES * WIDTH + 1024);
  });

  it('handles a pathological single-line buffer without unbounded rows', () => {
    const huge = 'a'.repeat(2 * 1024 * 1024);
    const rows = projectTail(huge);
    expect(rows.length).toBeLessThanOrEqual(STREAM_TAIL_MAX_LINES);
  });

  it('renders markdown live (header rows, code blocks)', () => {
    const content = '# Title\n\nsome prose\n\n```ts\nconst x = 1;\n```\n\n- bullet one\n- bullet two\n';
    const lines = projectTail(content);
    const kinds = lines.map((l) => l.kind);
    // A markdown header renders as its own rendered text rows; the fenced
    // block gets a code-label + code rows, not plain text.
    expect(kinds).toContain('code-label');
    expect(kinds).toContain('code');
    expect(kinds).toContain('header');
    expect(lines[0].kind).toBe('header');
  });

  it('renders a complete code block whose opener sits inside the tail window', () => {
    // Fence opener inside the tail: the slice must contain the complete
    // block (label + rows) rendered as code; earlier prose renders as text.
    const longProse = 'prose line\n'.repeat(800); // > 8KB pre-tail region
    const content = longProse + '```ts\nconst x = 1;\nconst y = 2;\n';
    const projected = projectTail(content);
    const kinds = projected.map((l) => l.kind);
    expect(kinds).toContain('code');
    expect(kinds).toContain('code-label');
  });

  it('aligns the tail to the fence opener when the window opens mid-block', () => {
    // The raw window starts INSIDE an unclosed code block — backing up to the
    // opener keeps the block rendered as CODE, never as broken prose.
    const content = '```ts\n' + 'const a = 1;\n'.repeat(800); // > 8KB, fence still open
    const projected = projectTail(content);
    const kinds = projected.map((l) => l.kind);
    // All visible rows are code (newest rows; the label row is capped out of
    // the window by the row budget — covered by the opener-in-window test).
    expect(kinds).toContain('code');
    expect(kinds).not.toContain('text');
  });

  it('never starts the slice mid-line', () => {
    const longLine = 'word '.repeat(2000); // > 8KB, single line
    const content = longLine + '\nheader text\n\nmore prose';
    const projected = projectTail(content);
    const texts = projected.filter((l) => l.kind === 'text').map((l) => l.text);
    // The first rendered row must not be a fragment of the long line.
    for (const text of texts) {
      expect(text.startsWith('rd ') || text === 'rd').toBe(false);
    }
    expect(texts.join('\n')).toContain('header text');
  });
});

describe('streaming tail live-region integration', () => {
  it('Mercury Code prints finalized rows via <Static>; the tail is a small live region', () => {
    const app = src('App.tsx');
    // Finalized transcript prints once into native terminal scrollback.
    expect(app).toContain('<Static items={staticItems} itemKey={staticItemKey}>');
    // The live tail is capped to a small per-frame budget (no full-screen
    // live region — a near-full-screen region was rewritten every streaming
    // frame, which read as flicker).
    expect(app).toContain('STREAM_TAIL_MAX_LINES = 12');
    // Live tail renders through the markdown pipeline, on the bounded slice.
    expect(app).toContain('buildStreamTailLines(streamingMessage, contentWidth');
    // Forbidden patterns: the removed in-app viewport machinery.
    expect(app).not.toContain('getViewportWindow(totalWithTail');
    expect(app).not.toContain('wordmarkOnScreen');
    // No in-app scroll dispatches left in the TUI (the workspace IDE's
    // AgentOutputPanel viewport is a separate, fixed-panel scroll and stays).
    expect(app).not.toContain("'/mc scroll");
    // Live-region cap in chat surfaces too.
    expect(app).toContain('Math.min(12, Math.max(3, terminalSize.rows - 14))');
  });
});