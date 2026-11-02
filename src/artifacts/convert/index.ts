import { readFileSync } from 'node:fs';
import { markdownBlocks, titleOf } from './blocks.js';
import { toDocx } from './docx.js';
import { toPdf } from './pdf.js';

/**
 * A Markdown or text artifact (a research report, notes) as a PDF or a Word
 * document, made on request. Nothing is stored: the .md stays the source.
 */

export type ConvertFormat = 'pdf' | 'docx';

export const CONVERT_MIME: Record<ConvertFormat, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/** Only text can be turned into a document. */
export function canConvert(a: { name: string; mime: string }): boolean {
  return /^text\/(markdown|plain)$/.test(a.mime) || /\.(md|markdown|txt)$/i.test(a.name);
}

export function convertedName(name: string, format: ConvertFormat): string {
  return `${name.replace(/\.(md|markdown|txt)$/i, '')}.${format}`;
}

export function convertMarkdown(markdown: string, format: ConvertFormat, fallbackTitle: string): Buffer {
  const blocks = markdownBlocks(markdown);
  const title = titleOf(blocks, fallbackTitle);
  return format === 'pdf' ? toPdf(blocks, title) : toDocx(blocks, title);
}

export function convertFile(path: string, name: string, format: ConvertFormat): Buffer {
  const text = readFileSync(path, 'utf-8');
  // Plain text: each line its own paragraph, not one Markdown blob.
  const markdown = /\.txt$/i.test(name) ? text.split('\n').map((l) => l.replace(/^([#>*\-+]|\d+\.)/, '\\$1')).join('\n\n') : text;
  return convertMarkdown(markdown, format, name.replace(/\.[^.]+$/, ''));
}
