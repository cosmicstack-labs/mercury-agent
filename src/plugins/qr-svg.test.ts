import { describe, expect, it } from 'vitest';
import { qrSvg } from './qr-svg.js';

describe('qrSvg', () => {
  it('renders a square SVG with dark modules on white', () => {
    const svg = qrSvg('2@AbCdEf,GhIjKl,MnOpQr==', 4);
    expect(svg.startsWith('<svg')).toBe(true);
    const size = Number(/viewBox="0 0 (\d+) \1"/.exec(svg)?.[1]);
    expect(size).toBeGreaterThan(100);
    expect(svg).toMatch(/<path d="M\d+ \d+h4v4h-4z/);
  });
  it('is deterministic', () => {
    expect(qrSvg('hello')).toBe(qrSvg('hello'));
  });
});
