import { describe, it, expect } from 'vitest';
import { mdToSignal } from './markdown.js';

describe('mdToSignal', () => {
  it('keeps bold/italic/strike markers for the native parser', () => {
    expect(mdToSignal('**bold** and *italic* and ~~gone~~')).toBe(
      '**bold** and *italic* and ~~gone~~',
    );
  });

  it('converts headings to bold', () => {
    expect(mdToSignal('# Title')).toBe('**Title**');
    expect(mdToSignal('### Sub')).toBe('**Sub**');
  });

  it('flattens links to "label (url)"', () => {
    expect(mdToSignal('see [docs](https://x.io)')).toBe('see docs (https://x.io)');
  });

  it('collapses a link whose label equals its url', () => {
    expect(mdToSignal('[https://x.io](https://x.io)')).toBe('https://x.io');
  });

  it('preserves inline code and does not transform its contents', () => {
    expect(mdToSignal('run `# not a heading`')).toBe('run `# not a heading`');
  });

  it('converts fenced code blocks to a monospace span', () => {
    expect(mdToSignal('```js\nconst x = 1;\n```')).toBe('`const x = 1;`');
  });

  it('leaves plain text and bullet lists untouched', () => {
    expect(mdToSignal('- one\n- two')).toBe('- one\n- two');
  });
});
