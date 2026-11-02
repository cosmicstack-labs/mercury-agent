import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { inflateRawSync, inflateSync } from 'node:zlib';
import { markdownBlocks, titleOf } from './blocks.js';
import { canConvert, convertedName, convertMarkdown } from './index.js';
import { measure, winAnsi, wrap } from './pdf.js';
import { crc32 } from './zip.js';

const REPORT = `# Solid-state batteries in 2026

**TL;DR:** pilot lines now, *cars* in 2027–28. See [Toyota](https://global.toyota/en/newsroom/).

## Who

- **Toyota**: sulfide → cars 2027
  - nested detail
1. Cost: $370/kWh
- [x] checked task

| Company | First cars |
|---|---|
| Toyota | 2027 |

> A quote.

\`\`\`
code line
\`\`\`

---

![a chart](https://img.example/c.png)
`;

/** The files inside a zip, by name (a tiny reader for the test). */
function unzip(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let p = 0;
  while (buf.readUInt32LE(p) === 0x04034b50) {
    const size = buf.readUInt32LE(p + 18);
    const nameLen = buf.readUInt16LE(p + 26);
    const extra = buf.readUInt16LE(p + 28);
    const name = buf.subarray(p + 30, p + 30 + nameLen).toString('utf-8');
    const data = buf.subarray(p + 30 + nameLen + extra, p + 30 + nameLen + extra + size);
    out[name] = inflateRawSync(data).toString('utf-8');
    p += 30 + nameLen + extra + size;
  }
  return out;
}

describe('markdown blocks', () => {
  it('reads a report into headings, items, tables, quotes, code and links', () => {
    const b = markdownBlocks(REPORT);
    expect(titleOf(b, 'x')).toBe('Solid-state batteries in 2026');
    expect(b.map((x) => x.type)).toEqual(['heading', 'para', 'heading', 'item', 'item', 'item', 'item', 'table', 'quote', 'code', 'rule', 'para']);
    const items = b.filter((x) => x.type === 'item') as Array<{ depth: number; marker: string }>;
    expect(items.map((i) => [i.depth, i.marker])).toEqual([[0, '•'], [1, '•'], [0, '1.'], [0, '☑']]);
    const para = b[1] as { runs: Array<{ text: string; bold?: boolean; italic?: boolean; href?: string }> };
    expect(para.runs.find((r) => r.bold)?.text).toBe('TL;DR:');
    expect(para.runs.find((r) => r.href)?.href).toBe('https://global.toyota/en/newsroom/');
    expect((b[11] as { runs: Array<{ text: string }> }).runs[0].text).toBe('[Image: a chart]');
  });
});

describe('Word', () => {
  it('is a valid zip with headings, a table and working links', () => {
    const buf = convertMarkdown(REPORT, 'docx', 'x');
    const files = unzip(buf);
    expect(Object.keys(files).sort()).toEqual(['[Content_Types].xml', '_rels/.rels', 'docProps/core.xml', 'word/_rels/document.xml.rels', 'word/document.xml', 'word/styles.xml']);
    const doc = files['word/document.xml'];
    expect(doc).toContain('<w:pStyle w:val="Heading1"/>');
    expect(doc).toContain('<w:tbl>');
    expect(doc).toMatch(/<w:hyperlink r:id="rLink1"/);
    expect(files['word/_rels/document.xml.rels']).toContain('Target="https://global.toyota/en/newsroom/" TargetMode="External"');
    expect(files['docProps/core.xml']).toContain('<dc:title>Solid-state batteries in 2026</dc:title>');
    // Text is escaped, never raw markup.
    expect(convertMarkdown('a < b & "c"', 'docx', 'x').length).toBeGreaterThan(0);
    expect(unzip(convertMarkdown('a < b & "c"', 'docx', 'x'))['word/document.xml']).toContain('a &lt; b &amp; &quot;c&quot;');
    expect(unzip(convertMarkdown('bell\u0007 here', 'docx', 'x'))['word/document.xml']).toContain('bell here');
  });

  it('checksums the way zip readers expect', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });
});

describe('PDF', () => {
  it('is a well-formed PDF with its title, pages, text and link annotations', () => {
    const long = `${REPORT}\n\n${Array.from({ length: 60 }, (_, i) => `Paragraph ${i} with enough words to wrap a line or two in the layout.`).join('\n\n')}`;
    const buf = convertMarkdown(long, 'pdf', 'x');
    const s = buf.toString('latin1');
    expect(s.startsWith('%PDF-1.4')).toBe(true);
    expect(s.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(s).toContain('/Title (Solid-state batteries in 2026)');
    const count = Number(/\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/.exec(s)?.[1]);
    expect(count).toBeGreaterThan(1);
    expect(s).toContain('/URI (https://global.toyota/en/newsroom/)');
    // The xref points at each object.
    const start = Number(/startxref\n(\d+)/.exec(s)?.[1]);
    expect(s.slice(start, start + 4)).toBe('xref');
    const offsets = [...s.slice(start).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    offsets.forEach((o, i) => expect(s.slice(o, o + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
    // Page text is in the streams.
    const streams = [...s.matchAll(/stream\n([\s\S]*?)\nendstream/g)].map((m) => inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'));
    expect(streams.join('\n')).toContain('(Solid-state batteries in 2026) Tj');
    expect(streams.join('\n')).toContain(`(1 / ${count}) Tj`);
    if (process.env.MERCURY_CONVERT_OUT) {
      writeFileSync(`${process.env.MERCURY_CONVERT_OUT}/test.pdf`, buf);
      writeFileSync(`${process.env.MERCURY_CONVERT_OUT}/test.docx`, convertMarkdown(long, 'docx', 'x'));
    }
  });

  it('spells what the core fonts lack and wraps by real widths', () => {
    expect(winAnsi('a → b ≥ c “q” – é')).toBe('a -> b >= c \x93q\x94 \x96 \xe9');
    expect(winAnsi('東京')).toBe('??');
    expect(winAnsi('Łódź')).toBe('Lódz');
    expect(measure('Hello', 'R', 10)).toBeCloseTo((722 + 556 + 222 + 222 + 556) / 100, 5);
    const lines = wrap([{ text: 'word '.repeat(60) }], 200, 10);
    expect(lines.length).toBeGreaterThan(5);
    for (const l of lines) expect(l.w).toBeLessThanOrEqual(200);
    // A word wider than the line is cut, not overflowed.
    for (const l of wrap([{ text: 'x'.repeat(300) }], 100, 10)) expect(l.w).toBeLessThanOrEqual(100.01);
  });

  it('only text converts, and names follow the format', () => {
    expect(canConvert({ name: 'r.md', mime: 'text/markdown' })).toBe(true);
    expect(canConvert({ name: 'a.png', mime: 'image/png' })).toBe(false);
    expect(convertedName('2026-report.md', 'pdf')).toBe('2026-report.pdf');
  });
});
