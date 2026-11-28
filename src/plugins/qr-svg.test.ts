import { describe, expect, it } from 'vitest';
import { qrBlocks, qrSvg } from './qr-svg.js';

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

describe('qrBlocks', () => {
  const link = `mercury://pair?u=https://desktop-abc123.tail1a2b3c.ts.net&c=${'7K3MQ'.repeat(5)}`;
  const width = (line: string) => [...line].length;

  it('fits an 80-column terminal with room to spare', () => {
    const lines = qrBlocks(link).split('\n');
    expect(new Set(lines.map(width)).size).toBe(1);
    expect(width(lines[0])).toBeLessThanOrEqual(45);
    expect(lines.length).toBeLessThanOrEqual(23);
  });

  it('draws only block characters, the same each time', () => {
    expect(qrBlocks(link)).toMatch(/^[█▀▄ \n]+$/);
    expect(qrBlocks(link)).toBe(qrBlocks(link));
  });

  it('keeps a light border two modules wide', () => {
    const lines = qrBlocks(link).split('\n');
    expect(lines[0]).toMatch(/^█+$/);
    expect(lines.slice(0, -1).every((l) => l.startsWith('██') && l.endsWith('██'))).toBe(true);
  });

  it('colours each line white on black for terminals', () => {
    const lines = qrBlocks(link, { ansi: true }).split('\n');
    expect(lines.every((l) => l.startsWith('\x1b[97;40m') && l.endsWith('\x1b[39;49m'))).toBe(true);
  });
});
