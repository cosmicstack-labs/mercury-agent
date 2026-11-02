import { Marked, type Token, type Tokens } from 'marked';

/**
 * Markdown as a few plain blocks, the shape both document writers (Word and
 * PDF) lay out: headings, paragraphs, list items (with depth and number),
 * quotes, code, rules, tables. Inline text is runs with bold / italic / code
 * and a link target. Images become a linked "[Image: alt]" line: the
 * writers don't fetch from the web.
 */

export interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  href?: string;
}

export type Block =
  | { type: 'heading'; level: number; runs: Run[] }
  | { type: 'para'; runs: Run[] }
  | { type: 'item'; depth: number; marker: string; runs: Run[] }
  | { type: 'quote'; runs: Run[] }
  | { type: 'code'; text: string }
  | { type: 'rule' }
  | { type: 'table'; header: Run[][]; rows: Run[][][] };

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };
const decode = (s: string): string => s.replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, e: string) => ENTITIES[e] ?? _);

type Style = Omit<Run, 'text'>;

function inline(tokens: Token[] | undefined, style: Style = {}): Run[] {
  const out: Run[] = [];
  for (const t of tokens ?? []) {
    switch (t.type) {
      case 'strong': out.push(...inline((t as Tokens.Strong).tokens, { ...style, bold: true })); break;
      case 'em': out.push(...inline((t as Tokens.Em).tokens, { ...style, italic: true })); break;
      case 'del': out.push(...inline((t as Tokens.Del).tokens, style)); break;
      case 'codespan': out.push({ ...style, code: true, text: decode((t as Tokens.Codespan).text) }); break;
      case 'link': {
        const l = t as Tokens.Link;
        const runs = inline(l.tokens, { ...style, href: l.href });
        out.push(...(runs.length ? runs : [{ ...style, href: l.href, text: l.href }]));
        break;
      }
      case 'image': {
        const i = t as Tokens.Image;
        out.push({ ...style, italic: true, href: i.href, text: `[Image: ${decode(i.text || 'image')}]` });
        break;
      }
      case 'br': out.push({ ...style, text: '\n' }); break;
      case 'html': break;
      case 'text': {
        const x = t as Tokens.Text;
        if (x.tokens?.length) out.push(...inline(x.tokens, style));
        else out.push({ ...style, text: decode(x.text) });
        break;
      }
      default: {
        const raw = (t as { text?: string }).text;
        if (raw) out.push({ ...style, text: decode(raw) });
      }
    }
  }
  return out;
}

function blocks(tokens: Token[], out: Block[], depth = 0, inQuote = false): void {
  for (const t of tokens) {
    switch (t.type) {
      case 'heading': out.push({ type: 'heading', level: Math.min(6, (t as Tokens.Heading).depth), runs: inline((t as Tokens.Heading).tokens) }); break;
      case 'paragraph': out.push({ type: inQuote ? 'quote' : 'para', runs: inline((t as Tokens.Paragraph).tokens) }); break;
      case 'text': out.push({ type: inQuote ? 'quote' : 'para', runs: inline([t]) }); break;
      case 'blockquote': blocks((t as Tokens.Blockquote).tokens, out, depth, true); break;
      case 'code': out.push({ type: 'code', text: (t as Tokens.Code).text }); break;
      case 'hr': out.push({ type: 'rule' }); break;
      case 'list': {
        const l = t as Tokens.List;
        const start = typeof l.start === 'number' ? l.start : 1;
        l.items.forEach((item, i) => {
          const marker = item.task ? (item.checked ? '☑' : '☐') : l.ordered ? `${start + i}.` : '•';
          // The item's own text first; nested lists and later paragraphs after it.
          const [first, ...rest] = item.tokens;
          const lead = first && (first.type === 'text' || first.type === 'paragraph') ? inline((first as Tokens.Text).tokens ?? [first]) : [];
          out.push({ type: 'item', depth, marker, runs: lead });
          blocks(first && lead.length ? rest : item.tokens, out, depth + 1, inQuote);
        });
        break;
      }
      case 'table': {
        const tb = t as Tokens.Table;
        out.push({ type: 'table', header: tb.header.map((h) => inline(h.tokens)), rows: tb.rows.map((r) => r.map((cell) => inline(cell.tokens))) });
        break;
      }
      default: break;
    }
  }
}

export function markdownBlocks(markdown: string): Block[] {
  const out: Block[] = [];
  blocks(new Marked({ gfm: true }).lexer(markdown), out);
  // Nested paragraphs inside list items read as items' continuation lines.
  return out.filter((b) => b.type !== 'para' || b.runs.some((r) => r.text.trim()));
}

/** The document's title: its first heading, else the fallback. */
export function titleOf(blocks: Block[], fallback: string): string {
  const h = blocks.find((b) => b.type === 'heading');
  return h && h.type === 'heading' ? h.runs.map((r) => r.text).join('').trim() || fallback : fallback;
}
