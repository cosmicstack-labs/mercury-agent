import { describe, expect, it } from 'vitest';
import type { ChatMessage } from './types.js';
import { buildMercuryMessageLines, buildMercuryBrandLines, type MercuryTranscriptLine } from './mercury-transcript.js';
import { buildMercuryTranscriptIndex, renderMercuryTranscriptWindow, renderMercuryTranscriptRange } from './App.js';

const WIDTH = 60;
const BRAND = buildMercuryBrandLines('test', WIDTH);

function agentMessage(id: string, lines: number): ChatMessage {
  return {
    id,
    role: 'agent',
    content: Array.from({ length: lines }, (_, i) => `row ${id} ${i}`).join('\n'),
    timestamp: 1,
  };
}

function tailBlock(rows: number): MercuryTranscriptLine[] {
  const lines: MercuryTranscriptLine[] = [{ key: 'stream:hdr', kind: 'header', role: 'agent', text: 'MERCURY' }];
  for (let i = 0; i < rows; i++) {
    lines.push({ key: `stream:${i}`, kind: 'text', role: 'agent', text: `stream row ${i}` });
  }
  return lines;
}

describe('Mercury Code bounded transcript projection', () => {
  it('produces a window identical to a full flatten', () => {
    const messages = Array.from({ length: 12 }, (_, i) => agentMessage(`m${i}`, 5));
    const index = buildMercuryTranscriptIndex(messages, WIDTH);
    const flat = messages.flatMap((m) => buildMercuryMessageLines(m, WIDTH));
    expect(index.total).toBe(flat.length);

    const window = renderMercuryTranscriptWindow(index, 10, 20, WIDTH);
    expect(window).toEqual(flat.slice(10, 20));
  });

  it('renders the live tail exactly when scrolled to the bottom', () => {
    const messages = Array.from({ length: 7 }, (_, i) => agentMessage(`m${i}`, 9));
    const index = buildMercuryTranscriptIndex(messages, WIDTH);
    const flat = messages.flatMap((m) => buildMercuryMessageLines(m, WIDTH));
    const window = renderMercuryTranscriptWindow(index, Math.max(0, flat.length - 8), flat.length, WIDTH);
    expect(window).toEqual(flat.slice(-8));
  });

  it('keeps the index tiny for long sessions', () => {
    const messages = Array.from({ length: 500 }, (_, i) => agentMessage(`m${i}`, 40));
    const index = buildMercuryTranscriptIndex(messages, WIDTH);
    expect(index.msgs.length).toBe(500);
    expect(index.total).toBeGreaterThan(0);
    const rendered = renderMercuryTranscriptWindow(index, index.total - 5, index.total, WIDTH);
    expect(rendered.length).toBe(5);
  });

  it('treats brand rows as leading transcript rows that scroll away', () => {
    const messages = [agentMessage('m0', 8), agentMessage('m1', 8)];
    const index = buildMercuryTranscriptIndex(messages, WIDTH, BRAND);
    const flat = [...BRAND, ...messages.flatMap((m) => buildMercuryMessageLines(m, WIDTH))];
    expect(index.total).toBe(flat.length);

    // Top of transcript: brand rows visible first.
    expect(renderMercuryTranscriptWindow(index, 0, 6, WIDTH)).toEqual(flat.slice(0, 6));
    // Scrolled past the brand: message rows only.
    const scrolled = renderMercuryTranscriptWindow(index, BRAND.length + 2, BRAND.length + 8, WIDTH);
    expect(scrolled).toEqual(flat.slice(BRAND.length + 2, BRAND.length + 8));
    // Live tail: brand rows fully out of the window.
    const tail = renderMercuryTranscriptWindow(index, flat.length - 4, flat.length, WIDTH);
    expect(tail).toEqual(flat.slice(-4));
    expect(tail.some((l) => l.kind === 'brand')).toBe(false);
  });
});

describe('Mercury Code streaming-tail viewport integration', () => {
  it('slices across finalized transcript and streaming tail as one document', () => {
    const messages = Array.from({ length: 5 }, (_, i) => agentMessage(`m${i}`, 6));
    const index = buildMercuryTranscriptIndex(messages, WIDTH);
    const tail = tailBlock(8);
    const grandTotal = index.total + tail.length;

    // Equivalent flatten: finalized rows followed by the tail block.
    const flat = [
      ...messages.flatMap((m) => buildMercuryMessageLines(m, WIDTH)),
      ...tail,
    ];
    expect(grandTotal).toBe(flat.length);

    // A bottom window covers tail rows; a middle window straddles the seam.
    const bottom = renderMercuryTranscriptRange(index, tail, grandTotal - 10, grandTotal, WIDTH);
    expect(bottom).toEqual(flat.slice(-10));

    const seamStart = index.total - 4;
    const seam = renderMercuryTranscriptRange(index, tail, seamStart, seamStart + 10, WIDTH);
    expect(seam).toEqual(flat.slice(seamStart, seamStart + 10));
  });

  it('never returns more rows than the requested window (no overflow)', () => {
    const messages = Array.from({ length: 30 }, (_, i) => agentMessage(`m${i}`, 12));
    const index = buildMercuryTranscriptIndex(messages, WIDTH);
    const tail = tailBlock(25);
    const grandTotal = index.total + tail.length;

    const windowRows = renderMercuryTranscriptRange(index, tail, grandTotal - 20, grandTotal, WIDTH);
    expect(windowRows.length).toBe(20);

    // Scrolled up: rows come only from the finalized transcript.
    const scrolled = renderMercuryTranscriptRange(index, tail, 0, 20, WIDTH);
    expect(scrolled.length).toBe(20);
    expect(scrolled.some((l) => l.key.startsWith('stream:'))).toBe(false);
  });

  it('empty tail behaves exactly like the finalized-only window', () => {
    const messages = Array.from({ length: 8 }, (_, i) => agentMessage(`m${i}`, 7));
    const index = buildMercuryTranscriptIndex(messages, WIDTH);
    const noTail = renderMercuryTranscriptRange(index, [], index.total - 12, index.total, WIDTH);
    expect(noTail).toEqual(renderMercuryTranscriptWindow(index, index.total - 12, index.total, WIDTH));
  });
});