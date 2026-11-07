import type { Block, Run } from './blocks.js';
import { zip } from './zip.js';

/**
 * Blocks → a Word document (.docx): real heading styles (so Word's
 * navigation pane and table of contents work), lists, quotes, code, tables,
 * and links that open. Opens in Word, Pages, Google Docs and LibreOffice.
 */

/** XML 1.0 can't hold control characters other than tab, newline and return. */
const printable = (s: string): string => [...s].filter((ch) => { const c = ch.charCodeAt(0); return c >= 32 || c === 9 || c === 10 || c === 13; }).join('');

const esc = (s: string): string => printable(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

class Links {
  readonly list: string[] = [];
  id(href: string): string {
    let i = this.list.indexOf(href);
    if (i < 0) { this.list.push(href); i = this.list.length - 1; }
    return `rLink${i + 1}`;
  }
}

function run(r: Run, extra = ''): string {
  const props = [
    r.bold ? '<w:b/>' : '',
    r.italic ? '<w:i/>' : '',
    r.code ? '<w:rFonts w:ascii="Menlo" w:hAnsi="Menlo" w:cs="Menlo"/><w:sz w:val="19"/>' : '',
    r.href ? '<w:rStyle w:val="Hyperlink"/>' : '',
    extra,
  ].join('');
  const parts = r.text.split('\n').map((t) => `<w:t xml:space="preserve">${esc(t)}</w:t>`);
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}${parts.join('<w:br/>')}</w:r>`;
}

function runs(list: Run[], links: Links, extra = ''): string {
  let out = '';
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    if (!r.href) { out += run(r, extra); continue; }
    // Consecutive runs with the same target are one hyperlink.
    let j = i;
    let inner = '';
    while (j < list.length && list[j].href === r.href) inner += run(list[j++], extra);
    out += `<w:hyperlink r:id="${links.id(r.href)}" w:history="1">${inner}</w:hyperlink>`;
    i = j - 1;
  }
  return out;
}

// On the table itself too: not every viewer applies a table style's borders.
const BORDERS = '<w:tblBorders>' + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`).join('') + '</w:tblBorders>';

const para = (style: string | null, body: string, pPr = ''): string =>
  `<w:p>${style || pPr ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${pPr}</w:pPr>` : ''}${body}</w:p>`;

function body(blocks: Block[], links: Links): string {
  const out: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'heading': out.push(para(`Heading${b.level}`, runs(b.runs, links))); break;
      case 'para': out.push(para(null, runs(b.runs, links))); break;
      case 'quote': out.push(para('Quote', runs(b.runs, links))); break;
      case 'item': {
        const left = 360 + b.depth * 360;
        out.push(para('ListParagraph', `${run({ text: `${b.marker}\t` })}${runs(b.runs, links)}`, `<w:tabs><w:tab w:val="left" w:pos="${left}"/></w:tabs><w:ind w:left="${left}" w:hanging="300"/>`));
        break;
      }
      case 'code':
        for (const line of b.text.split('\n')) out.push(para('Code', run({ text: line || ' ', code: true })));
        break;
      case 'rule': out.push(para(null, '', '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="BBBBBB"/></w:pBdr>')); break;
      case 'table': {
        const cols = Math.max(b.header.length, ...b.rows.map((r) => r.length), 1);
        const cell = (rs: Run[], head: boolean): string =>
          `<w:tc><w:tcPr><w:tcW w:w="${Math.floor(9000 / cols)}" w:type="dxa"/>${head ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>' : ''}</w:tcPr>${para(null, runs(rs, links, head ? '<w:b/>' : ''))}</w:tc>`;
        const row = (cells: Run[][], head: boolean): string => `<w:tr>${Array.from({ length: cols }, (_, i) => cell(cells[i] ?? [], head)).join('')}</w:tr>`;
        out.push(`<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/>${BORDERS}</w:tblPr>${row(b.header, true)}${b.rows.map((r) => row(r, false)).join('')}</w:tbl>`);
        out.push(para(null, ''));
        break;
      }
    }
  }
  return out.join('');
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="140" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
${[1, 2, 3, 4, 5, 6].map((n) => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="${n === 1 ? 240 : 200}" w:after="100"/><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${[40, 32, 27, 24, 22, 22][n - 1]}"/></w:rPr></w:style>`).join('\n')}
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="400"/><w:pBdr><w:left w:val="single" w:sz="12" w:space="8" w:color="CCCCCC"/></w:pBdr></w:pPr><w:rPr><w:i/><w:color w:val="555555"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="60"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:shd w:val="clear" w:color="auto" w:fill="F5F5F5"/></w:pPr><w:rPr><w:rFonts w:ascii="Menlo" w:hAnsi="Menlo" w:cs="Menlo"/><w:sz w:val="19"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="1F5FBF"/><w:u w:val="single"/></w:rPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:color="BFBFBF"/><w:left w:val="single" w:sz="4" w:color="BFBFBF"/><w:bottom w:val="single" w:sz="4" w:color="BFBFBF"/><w:right w:val="single" w:sz="4" w:color="BFBFBF"/><w:insideH w:val="single" w:sz="4" w:color="BFBFBF"/><w:insideV w:val="single" w:sz="4" w:color="BFBFBF"/></w:tblBorders><w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
</w:styles>`;

export function toDocx(blocks: Block[], title: string, now = new Date()): Buffer {
  const links = new Links();
  const content = body(blocks, links);
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${content}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1300" w:right="1300" w:bottom="1300" w:left="1300" w:header="700" w:footer="700" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${links.list.map((href, i) => `<Relationship Id="rLink${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${esc(href)}" TargetMode="External"/>`).join('')}</Relationships>`;
  const iso = now.toISOString().replace(/\.\d+Z$/, 'Z');
  return zip([
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>` },
    { name: 'docProps/core.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(title)}</dc:title><dc:creator>Mercury</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created></cp:coreProperties>` },
    { name: 'word/document.xml', data: document },
    { name: 'word/styles.xml', data: STYLES },
    { name: 'word/_rels/document.xml.rels', data: rels },
  ], now);
}
