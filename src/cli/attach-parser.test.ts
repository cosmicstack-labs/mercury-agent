import { describe, expect, it } from 'vitest';
import { createSseParser } from './attach.js';

/**
 * The attach client consumes the runtime's SSE feed over fetch. Frames must
 * survive arbitrary chunk boundaries (TCP splits), \r\n line endings, and
 * keepalive comment lines without corrupting the decoded events.
 */
describe('SSE frame parser', () => {
  it('decodes complete frames', () => {
    const parser = createSseParser();
    const frames = parser.push('event: text_delta\ndata: {"text":"hi"}\n\nevent: thinking\ndata: {}\n\n');
    expect(frames).toEqual([
      { event: 'text_delta', data: '{"text":"hi"}' },
      { event: 'thinking', data: '{}' },
    ]);
  });

  it('reassembles frames split across chunk boundaries', () => {
    const parser = createSseParser();
    expect(parser.push('event: text_do')).toEqual([]);
    expect(parser.push('ne\ndata: {"full')).toEqual([]);
    const frames = parser.push('Text":"done"}\n\n');
    expect(frames).toEqual([{ event: 'text_done', data: '{"fullText":"done"}' }]);
  });

  it('ignores keepalive comments and defaults untyped frames to message', () => {
    const parser = createSseParser();
    const frames = parser.push(': keepalive\n\ndata: {"x":1}\n\n');
    expect(frames).toEqual([{ event: 'message', data: '{"x":1}' }]);
  });

  it('normalizes \\r\\n line endings', () => {
    const parser = createSseParser();
    const frames = parser.push('event: provider\r\ndata: {"name":"p"}\r\n\r\n');
    expect(frames).toEqual([{ event: 'provider', data: '{"name":"p"}' }]);
  });

  it('joins multi-line data payloads with newlines', () => {
    const parser = createSseParser();
    const frames = parser.push('data: line1\ndata: line2\n\n');
    expect(frames).toEqual([{ event: 'message', data: 'line1\nline2' }]);
  });
});