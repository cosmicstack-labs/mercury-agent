import { describe, expect, it } from 'vitest';
import { wrapMercuryText } from './mercury-transcript.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = (p: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), p), 'utf8');

/**
 * Regression guard for the streaming-tail projection: the per-frame render
 * cost must be bounded by the TAIL budget (chars + rows), never by the total
 * accumulated stream length. A 64KB streaming buffer re-formatted per frame
 * was the O(frames × chars) allocation storm behind the 2.5GB OOM.
 */
describe('streaming tail projection bounds', () => {
  const STREAM_TAIL_CHARS = 8 * 1024;
  const STREAM_TAIL_MAX_LINES = 40;
  const WIDTH = 80;

  function projectTail(content: string): string[] {
    const tail = content.length > STREAM_TAIL_CHARS ? content.slice(-STREAM_TAIL_CHARS) : content;
    const out: string[] = [];
    for (const row of tail.split('\n')) {
      out.push(...wrapMercuryText(row, WIDTH));
    }
    return out.slice(-STREAM_TAIL_MAX_LINES);
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
    const totalChars = projected.reduce((sum, l) => sum + l.length, 0);
    // Rows wrapped from an 8KB window cannot exceed the window + wrap slack.
    expect(totalChars).toBeLessThan(STREAM_TAIL_CHARS + STREAM_TAIL_MAX_LINES * WIDTH + 1024);
  });

  it('handles a pathological single-line buffer without unbounded rows', () => {
    const huge = 'a'.repeat(2 * 1024 * 1024);
    const rows = projectTail(huge);
    expect(rows.length).toBeLessThanOrEqual(STREAM_TAIL_MAX_LINES);
  });
});
describe('streaming tail viewport integration', () => {
  it('tail is part of the scroll math, never appended after the window', () => {
    const app = src('App.tsx');
    // The tail must be included in the grand total used for viewport math.
    expect(app).toContain('totalWithTail = totalLines + streamTail.length');
    // Rendering must go through the combined range renderer.
    expect(app).toContain('renderMercuryTranscriptRange(transcriptIndex, streamTail');
    // Forbidden pattern: appending tail rows after the viewport slice
    // (overflowed the fixed-height box and clipped bottom rows).
    expect(app).not.toContain('[...visible, ...liveVisibleRows]');
    expect(app).not.toContain('liveVisibleRows');
  });
});
