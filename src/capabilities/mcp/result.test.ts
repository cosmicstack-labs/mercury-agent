import { describe, expect, it } from 'vitest';
import { registerSecretValue } from '../../utils/redact.js';
import { callResultToContent, callResultToText, MAX_RESULT_CHARS } from './result.js';

describe('callResultToText', () => {
  it('joins text blocks', () => {
    const text = callResultToText({
      content: [
        { type: 'text', text: 'one' },
        { type: 'text', text: 'two' },
      ],
    });
    expect(text).toBe('one\ntwo');
  });

  it('replaces media with a placeholder', () => {
    const text = callResultToText({
      content: [
        { type: 'text', text: 'a pixel' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        { type: 'audio', data: 'AAAAAAAA', mimeType: 'audio/wav' },
      ],
    });
    expect(text).toBe('a pixel\n[image/png, 3 B — not shown]\n[audio/wav, 6 B — not shown]');
  });

  it('renders resources and links', () => {
    const text = callResultToText({
      content: [
        { type: 'resource', resource: { uri: 'file:///a.txt', text: 'inline body' } },
        { type: 'resource', resource: { uri: 'file:///b.bin', blob: 'AAAA', mimeType: 'application/octet-stream' } },
        { type: 'resource_link', uri: 'file:///c.txt', name: 'c' },
      ],
    });
    expect(text).toBe(
      'inline body\n[resource file:///b.bin (application/octet-stream) — not shown]\n[resource link: file:///c.txt]',
    );
  });

  it('falls back to structured content, then to a placeholder', () => {
    expect(callResultToText({ content: [], structuredContent: { ok: true } })).toBe('{\n  "ok": true\n}');
    expect(callResultToText({ content: [] })).toBe('(no content)');
  });

  it('prefixes errors so the agent treats them as failures', () => {
    expect(callResultToText({ content: [{ type: 'text', text: 'boom' }], isError: true })).toBe('Error: boom');
    expect(callResultToText({ isError: true })).toBe('Error: the server reported an error without details');
  });

  it('truncates long results', () => {
    const text = callResultToText({ content: [{ type: 'text', text: 'x'.repeat(MAX_RESULT_CHARS + 10) }] });
    expect(text.startsWith('x'.repeat(MAX_RESULT_CHARS))).toBe(true);
    expect(text.endsWith('… (truncated, 10 chars omitted)')).toBe(true);
  });

  it('redacts registered secrets', () => {
    const secret = ['result-secret-', 'value-77'].join('');
    registerSecretValue(secret);
    expect(callResultToText({ content: [{ type: 'text', text: `value=${secret}` }] })).toBe('value=****');
  });
});

describe('callResultToContent', () => {
  const png = { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' };

  it('returns supported images separately and notes them in the text', () => {
    const content = callResultToContent({ content: [{ type: 'text', text: 'a pixel' }, png] });
    expect(content.images).toEqual([{ data: png.data, mimeType: 'image/png' }]);
    expect(content.text).toBe('a pixel\n[1 image attached]');
  });

  it('keeps a placeholder for media it cannot pass on', () => {
    const content = callResultToContent({
      content: [
        { type: 'image', data: 'AAAA', mimeType: 'image/tiff' },
        { type: 'audio', data: 'AAAA', mimeType: 'audio/wav' },
      ],
    });
    expect(content.images).toEqual([]);
    expect(content.text).toBe('[image/tiff, 3 B — not shown]\n[audio/wav, 3 B — not shown]');
  });

  it('passes at most four images and keeps a placeholder for the rest', () => {
    const content = callResultToContent({ content: Array.from({ length: 6 }, () => ({ ...png })) });
    expect(content.images).toHaveLength(4);
    expect(content.text.split('\n').filter((line) => line.endsWith('— not shown]'))).toHaveLength(2);
    expect(content.text.endsWith('[4 images attached]')).toBe(true);
  });

  it('notes an image-only result without an empty line', () => {
    expect(callResultToContent({ content: [png] }).text).toBe('[1 image attached]');
  });

  it('passes no images with an error result', () => {
    const content = callResultToContent({ content: [{ type: 'text', text: 'boom' }, png], isError: true });
    expect(content.images).toEqual([]);
    expect(content.text).toBe('Error: boom\n[image/png, 8 B — not shown]');
  });

  it('never puts base64 in the text', () => {
    const content = callResultToContent({ content: [{ type: 'text', text: 'shot' }, png] });
    expect(content.text).not.toContain(png.data);
  });
});
