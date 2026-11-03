import { deflateSync } from 'node:zlib';
import type { Block, Run } from './blocks.js';

/**
 * Blocks → a PDF: real, selectable text in the PDF's built-in Helvetica and
 * Courier (no font files, no browser), A4, wrapped by the fonts' own
 * widths, page numbers, and links you can click (sources stay sources).
 * The built-in fonts cover Western European text; anything outside it is
 * spelled out where there's a common equivalent (→ "->") or shown as "?".
 */

type Font = 'R' | 'B' | 'I' | 'BI' | 'M';
type Rgb = [number, number, number];

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN_X = 62;
const MARGIN_TOP = 64;
const MARGIN_BOTTOM = 70;
const TEXT_W = PAGE_W - MARGIN_X * 2;

const INK: Rgb = [0.11, 0.11, 0.12];
const MUTED: Rgb = [0.4, 0.4, 0.43];
const LINK: Rgb = [0.12, 0.37, 0.75];
const RULE: Rgb = [0.78, 0.78, 0.8];
const SOFT: Rgb = [0.955, 0.955, 0.96];

// Glyph widths (1/1000 em) for ASCII 32–126: Helvetica, then Helvetica-Bold (the Adobe core-font metrics).
const HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const HELV_B = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];

/** WinAnsi codes 0x80–0x9F, by character. */
const WIN_HIGH: Record<string, number> = {
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e,
  '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f,
};
/** Widths (regular, bold) for the non-ASCII WinAnsi glyphs that aren't a plain letter. */
const HIGH_W: Record<number, [number, number]> = {
  0x80: [556, 556], 0x82: [222, 278], 0x84: [333, 500], 0x85: [1000, 1000], 0x86: [556, 556], 0x87: [556, 556], 0x89: [1000, 1000], 0x8b: [333, 333], 0x9b: [333, 333],
  0x91: [222, 278], 0x92: [222, 278], 0x93: [333, 500], 0x94: [333, 500], 0x95: [350, 350], 0x96: [556, 556], 0x97: [1000, 1000], 0x99: [1000, 1000],
  0xa0: [278, 278], 0xa9: [737, 737], 0xae: [737, 737], 0xb0: [400, 400], 0xb1: [584, 584], 0xb7: [278, 278], 0xd7: [584, 584], 0xf7: [584, 584], 0xa7: [556, 556], 0xb6: [537, 556],
};
/** Common characters the core fonts don't have, spelled with ones they do. */
const SPELL: Record<string, string> = {
  '→': '->', '←': '<-', '↔': '<->', '⇒': '=>', '≥': '>=', '≤': '<=', '≠': '!=', '≈': '~', '∼': '~', '−': '-', '‑': '-', '‐': '-', '′': "'", '″': '"',
  'Ł': 'L', 'ł': 'l', 'Đ': 'D', 'đ': 'd', 'ı': 'i', 'Ħ': 'H', 'ħ': 'h', 'Ŧ': 'T', 'ŧ': 't', 'ﬁ': 'fi', 'ﬂ': 'fl',
  '✓': 'v', '✔': 'v', '✗': 'x', '✘': 'x', '☑': '[x]', '☐': '[ ]', '★': '*', '☆': '*', '▪': '•', '◦': '•', '‣': '•', '·': '·', '​': '', '﻿': '', '\t': '    ',
};

/** A string as WinAnsi bytes (in a latin1 string), and what couldn't be shown became "?". */
export function winAnsi(text: string): string {
  let out = '';
  for (const ch of text.normalize('NFC')) {
    const spelled = SPELL[ch];
    if (spelled !== undefined) { out += spelled === '·' ? '·' : spelled === '•' ? '\u0095' : spelled; continue; }
    const code = ch.codePointAt(0)!;
    if (code >= 32 && code <= 126) out += ch;
    else if (code >= 0xa0 && code <= 0xff) out += ch;
    else if (WIN_HIGH[ch] !== undefined) out += String.fromCharCode(WIN_HIGH[ch]);
    else if (code === 10) out += ' ';
    else {
      // An accented letter outside Latin-1: its plain letter. Anything else: "?".
      const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
      out += base && base.charCodeAt(0) < 127 ? base : '?';
    }
  }
  return out;
}

function glyphWidth(code: number, bold: boolean): number {
  if (code >= 32 && code <= 126) return (bold ? HELV_B : HELV)[code - 32];
  const w = HIGH_W[code];
  if (w) return bold ? w[1] : w[0];
  if (code >= 0xc0) {
    // Latin-1 letters: their plain letter's width.
    const base = String.fromCharCode(code).normalize('NFD').charCodeAt(0);
    if (base >= 32 && base <= 126) return (bold ? HELV_B : HELV)[base - 32];
  }
  return 556;
}

export function measure(win: string, font: Font, size: number): number {
  if (font === 'M') return win.length * 600 * size / 1000;
  const bold = font === 'B' || font === 'BI';
  let w = 0;
  for (let i = 0; i < win.length; i++) w += glyphWidth(win.charCodeAt(i), bold);
  return w * size / 1000;
}

const pdfString = (win: string): string => {
  let s = '(';
  for (let i = 0; i < win.length; i++) {
    const c = win.charCodeAt(i);
    if (c === 0x28 || c === 0x29 || c === 0x5c) s += `\\${win[i]}`;
    else if (c < 32 || c > 126) s += `\\${c.toString(8).padStart(3, '0')}`;
    else s += win[i];
  }
  return `${s})`;
};

const num = (n: number): string => (Math.round(n * 100) / 100).toString();
const rgb = (c: Rgb, stroke = false): string => `${c.map(num).join(' ')} ${stroke ? 'RG' : 'rg'}`;

interface Piece { text: string; font: Font; size: number; color: Rgb; href?: string; w: number }
interface Line { pieces: Piece[]; w: number }

function fontOf(r: Run, base: Font): Font {
  if (r.code) return 'M';
  const bold = r.bold || base === 'B' || base === 'BI';
  const italic = r.italic || base === 'I' || base === 'BI';
  return bold && italic ? 'BI' : bold ? 'B' : italic ? 'I' : 'R';
}

/** Runs → lines no wider than `width`, wrapped at spaces (a word longer than a line is cut). */
export function wrap(runs: Run[], width: number, size: number, base: Font = 'R', color: Rgb = INK): Line[] {
  const lines: Line[] = [];
  let line: Line = { pieces: [], w: 0 };
  const push = () => { lines.push(line); line = { pieces: [], w: 0 }; };
  for (const r of runs) {
    const font = fontOf(r, base);
    const fsize = r.code ? size * 0.9 : size;
    const col = r.href ? LINK : color;
    for (const part of r.text.split(/(\n|\s+)/)) {
      if (!part) continue;
      if (part === '\n') { push(); continue; }
      const isSpace = /^\s+$/.test(part);
      if (isSpace && line.pieces.length === 0) continue;
      let win = winAnsi(isSpace ? ' ' : part);
      let w = measure(win, font, fsize);
      if (!isSpace && line.w + w > width && line.pieces.length) {
        // Drop the trailing space before breaking.
        const last = line.pieces[line.pieces.length - 1];
        if (last && last.text === ' ') { line.pieces.pop(); line.w -= last.w; }
        push();
      }
      // A word wider than the whole line: cut it.
      while (!isSpace && w > width) {
        let cut = win.length;
        while (cut > 1 && measure(win.slice(0, cut), font, fsize) > width - line.w) cut--;
        const head = win.slice(0, cut);
        line.pieces.push({ text: head, font, size: fsize, color: col, href: r.href, w: measure(head, font, fsize) });
        push();
        win = win.slice(cut);
        w = measure(win, font, fsize);
      }
      if (!win) continue;
      line.pieces.push({ text: win, font, size: fsize, color: col, href: r.href, w });
      line.w += w;
    }
  }
  if (line.pieces.length) push();
  return lines.length ? lines : [{ pieces: [], w: 0 }];
}

class Doc {
  pages: Array<{ ops: string[]; links: Array<{ rect: [number, number, number, number]; href: string }> }> = [];
  y = 0;
  constructor() { this.newPage(); }
  get page() { return this.pages[this.pages.length - 1]; }
  newPage(): void { this.pages.push({ ops: [], links: [] }); this.y = MARGIN_TOP; }
  /** Room for `h` more points on this page, or a new page. */
  room(h: number): void { if (this.y + h > PAGE_H - MARGIN_BOTTOM && this.y > MARGIN_TOP) this.newPage(); }
  space(h: number): void { if (this.y > MARGIN_TOP) this.y += h; }
  rect(x: number, top: number, w: number, h: number, fill: Rgb): void {
    this.page.ops.push(`${rgb(fill)} ${num(x)} ${num(PAGE_H - top - h)} ${num(w)} ${num(h)} re f`);
  }
  line(x1: number, y1: number, x2: number, y2: number, color: Rgb, width = 0.6): void {
    this.page.ops.push(`${rgb(color, true)} ${num(width)} w ${num(x1)} ${num(PAGE_H - y1)} m ${num(x2)} ${num(PAGE_H - y2)} l S`);
  }
  /** One line of text with its baseline at `baseline` (from the top). */
  text(line: Line, x: number, baseline: number): void {
    let cx = x;
    // Words of one style are one string: smaller files, and copied text reads as text.
    const merged: Piece[] = [];
    for (const p of line.pieces) {
      const last = merged[merged.length - 1];
      if (last && last.font === p.font && last.size === p.size && last.href === p.href && last.color === p.color) merged[merged.length - 1] = { ...last, text: last.text + p.text, w: last.w + p.w };
      else merged.push({ ...p });
    }
    for (const p of merged) {
      if (p.text !== ' ') {
        this.page.ops.push(`BT /F${p.font} ${num(p.size)} Tf ${rgb(p.color)} ${num(cx)} ${num(PAGE_H - baseline)} Td ${pdfString(p.text)} Tj ET`);
        if (p.href) this.page.links.push({ rect: [cx, PAGE_H - baseline - p.size * 0.25, cx + p.w, PAGE_H - baseline + p.size * 0.85], href: p.href });
      }
      cx += p.w;
    }
  }
  /** Wrapped lines, flowing onto new pages; `decorate` draws behind each line (code shading, a quote bar). */
  flow(lines: Line[], x: number, size: number, leading: number, decorate?: (top: number, h: number) => void): void {
    const h = size * leading;
    for (const l of lines) {
      this.room(h);
      decorate?.(this.y, h);
      this.text(l, x, this.y + size * 0.95);
      this.y += h;
    }
  }
}

const HEADING_SIZE = [20, 15.5, 13, 11.5, 10.5, 10.5];
const BODY = 10.5;

function table(doc: Doc, header: Run[][], rows: Run[][][]): void {
  const cols = Math.max(header.length, ...rows.map((r) => r.length), 1);
  const colW = TEXT_W / cols;
  const size = 9;
  const pad = 4;
  const lh = size * 1.35;
  const drawRow = (cells: Run[][], head: boolean) => {
    const wrapped = Array.from({ length: cols }, (_, i) => wrap(cells[i] ?? [], colW - pad * 2, size, head ? 'B' : 'R'));
    const h = Math.max(...wrapped.map((w) => w.length)) * lh + pad * 2;
    doc.room(Math.min(h, PAGE_H - MARGIN_TOP - MARGIN_BOTTOM));
    const top = doc.y;
    if (head) doc.rect(MARGIN_X, top, TEXT_W, h, SOFT);
    wrapped.forEach((lines, i) => lines.forEach((l, j) => doc.text(l, MARGIN_X + i * colW + pad, top + pad + j * lh + size * 0.95)));
    for (let i = 0; i <= cols; i++) doc.line(MARGIN_X + i * colW, top, MARGIN_X + i * colW, top + h, RULE, 0.5);
    doc.line(MARGIN_X, top, MARGIN_X + TEXT_W, top, RULE, 0.5);
    doc.line(MARGIN_X, top + h, MARGIN_X + TEXT_W, top + h, RULE, 0.5);
    doc.y = top + h;
  };
  if (header.length) drawRow(header, true);
  for (const r of rows) drawRow(r, false);
}

function layout(blocks: Block[]): Doc {
  const doc = new Doc();
  let prev: Block['type'] | null = null;
  for (const b of blocks) {
    // A list ends with a little room before what follows it.
    if (prev === 'item' && b.type !== 'item') doc.y += BODY * 0.5;
    switch (b.type) {
      case 'heading': {
        const size = HEADING_SIZE[b.level - 1];
        doc.space(b.level <= 2 ? size * 0.9 : size * 0.7);
        const lines = wrap(b.runs, TEXT_W, size, 'B');
        // Keep a heading with the line after it.
        doc.room(lines.length * size * 1.25 + BODY * 2.5);
        doc.flow(lines, MARGIN_X, size, 1.25);
        if (b.level === 1) { doc.line(MARGIN_X, doc.y + 3, MARGIN_X + TEXT_W, doc.y + 3, RULE); doc.y += 6; }
        doc.y += size * 0.35;
        break;
      }
      case 'para':
        doc.flow(wrap(b.runs, TEXT_W, BODY), MARGIN_X, BODY, 1.5);
        doc.y += BODY * 0.6;
        break;
      case 'item': {
        const indent = 14 + b.depth * 16;
        const marker = winAnsi(b.marker);
        const lines = wrap(b.runs, TEXT_W - indent - 4, BODY);
        doc.room(BODY * 1.45);
        doc.text({ pieces: [{ text: marker, font: 'R', size: BODY, color: MUTED, w: measure(marker, 'R', BODY) }], w: 0 }, MARGIN_X + indent - measure(marker, 'R', BODY) - 6, doc.y + BODY * 0.95);
        doc.flow(lines, MARGIN_X + indent, BODY, 1.45);
        doc.y += BODY * 0.2;
        break;
      }
      case 'quote':
        doc.flow(wrap(b.runs, TEXT_W - 16, BODY, 'I', MUTED), MARGIN_X + 14, BODY, 1.5, (top, h) => doc.rect(MARGIN_X, top, 2.2, h, RULE));
        doc.y += BODY * 0.6;
        break;
      case 'code': {
        const size = 8.6;
        const lines = b.text.split('\n').flatMap((l) => wrap([{ text: l || ' ', code: true }], TEXT_W - 16, size / 0.9));
        doc.y += 2;
        doc.flow(lines, MARGIN_X + 8, size, 1.45, (top, h) => doc.rect(MARGIN_X, top, TEXT_W, h, SOFT));
        doc.y += BODY * 0.8;
        break;
      }
      case 'rule':
        doc.space(6);
        doc.room(12);
        doc.line(MARGIN_X, doc.y, MARGIN_X + TEXT_W, doc.y, RULE);
        doc.y += 12;
        break;
      case 'table':
        doc.space(4);
        table(doc, b.header, b.rows);
        doc.y += BODY;
        break;
    }
    prev = b.type;
  }
  return doc;
}

const FONTS: Record<Font, string> = { R: 'Helvetica', B: 'Helvetica-Bold', I: 'Helvetica-Oblique', BI: 'Helvetica-BoldOblique', M: 'Courier' };

const asciiUri = (href: string): string => href.replace(/[^\x21-\x7e]/g, (c) => encodeURIComponent(c)).replace(/([()\\])/g, '\\$1');

export function toPdf(blocks: Block[], title: string, now = new Date()): Buffer {
  const doc = layout(blocks);
  const total = doc.pages.length;
  doc.pages.forEach((p, i) => {
    const label = winAnsi(`${i + 1} / ${total}`);
    const w = measure(label, 'R', 8);
    p.ops.push(`BT /FR 8 Tf ${rgb(MUTED)} ${num((PAGE_W - w) / 2)} ${num(MARGIN_BOTTOM / 2)} Td ${pdfString(label)} Tj ET`);
  });

  const objects: Array<string | Buffer> = [];
  const add = (o: string | Buffer): number => { objects.push(o); return objects.length; };
  const catalog = add('');
  const pagesObj = add('');
  const fontIds = Object.fromEntries((Object.keys(FONTS) as Font[]).map((f) => [f, add(`<< /Type /Font /Subtype /Type1 /BaseFont /${FONTS[f]} /Encoding /WinAnsiEncoding >>`)])) as Record<Font, number>;
  const fontRes = (Object.keys(FONTS) as Font[]).map((f) => `/F${f} ${fontIds[f]} 0 R`).join(' ');
  const pageIds: number[] = [];
  for (const p of doc.pages) {
    const stream = deflateSync(Buffer.from(p.ops.join('\n'), 'latin1'));
    const content = add(Buffer.concat([Buffer.from(`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'), stream, Buffer.from('\nendstream', 'latin1')]));
    const annots = p.links.map((l) => add(`<< /Type /Annot /Subtype /Link /Rect [${l.rect.map(num).join(' ')}] /Border [0 0 0] /A << /S /URI /URI (${asciiUri(l.href)}) >> >>`));
    pageIds.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${num(PAGE_W)} ${num(PAGE_H)}] /Resources << /Font << ${fontRes} >> >> /Contents ${content} 0 R${annots.length ? ` /Annots [${annots.map((a) => `${a} 0 R`).join(' ')}]` : ''} >>`));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  const d = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const info = add(`<< /Title ${pdfString(winAnsi(title))} /Producer (Mercury) /CreationDate (D:${d}Z) >>`);

  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets: number[] = [];
  let pos = parts[0].length;
  objects.forEach((o, i) => {
    const body = typeof o === 'string' ? Buffer.from(o, 'latin1') : o;
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')]);
    offsets.push(pos);
    parts.push(chunk);
    pos += chunk.length;
  });
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${pos}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}
