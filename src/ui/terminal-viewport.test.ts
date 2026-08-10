import { describe, expect, it } from 'vitest';
import { getViewportWindow, moveViewport, normalizeTerminalText } from './terminal-viewport.js';

describe('terminal viewport', () => {
  it('follows the bottom at zero distance and reaches both boundaries', () => {
    expect(getViewportWindow(100, 20, 0)).toMatchObject({ start: 80, end: 100, distanceFromBottom: 0 });
    expect(getViewportWindow(100, 20, Number.MAX_SAFE_INTEGER)).toMatchObject({
      start: 0,
      end: 20,
      distanceFromBottom: 80,
    });
    expect(moveViewport(80, -100, 100, 20)).toBe(0);
    expect(moveViewport(0, 100, 100, 20)).toBe(80);
  });

  it('does not create blank space when content is shorter than the viewport', () => {
    expect(getViewportWindow(3, 20, 10)).toEqual({
      start: 0,
      end: 3,
      distanceFromBottom: 0,
      maxDistanceFromBottom: 0,
    });
  });

  it('normalizes Windows and legacy Mac line endings', () => {
    expect(normalizeTerminalText('one\r\ntwo\rthree')).toBe('one\ntwo\nthree');
  });
});
