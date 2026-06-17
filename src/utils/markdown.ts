import { Marked } from 'marked';
import chalk from 'chalk';

const lexer = new Marked();

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

function decodeHtmlEntities(text: string): string {
  return text.replace(/&(?:#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match) => {
    if (HTML_ENTITIES[match]) return HTML_ENTITIES[match];
    if (match.startsWith('&#x') || match.startsWith('&#X')) {
      const code = parseInt(match.slice(3, -1), 16);
      return isNaN(code) ? match : String.fromCodePoint(code);
    }
    if (match.startsWith('&#')) {
      const code = parseInt(match.slice(2, -1), 10);
      return isNaN(code) ? match : String.fromCodePoint(code);
    }
    return match;
  });
}

export function renderMarkdown(text: string): string {
  try {
    const tokens = lexer.lexer(text);
    const result = renderTokens(tokens);
    return decodeHtmlEntities(result.replace(/\n{3,}/g, '\n\n').trimEnd());
  } catch {
    return decodeHtmlEntities(text);
  }
}

function renderTokens(tokens: any[]): string {
  return tokens.map((t) => renderToken(t)).join('');
}

function renderToken(t: any): string {
  if (!t || typeof t !== 'object') return String(t ?? '');

  switch (t.type) {
    case 'heading':
      return renderHeading(t);
    case 'paragraph':
      return renderInline(t.tokens) + '\n\n';
    case 'strong':
      return chalk.bold(renderInline(t.tokens));
    case 'em':
      return chalk.italic(renderInline(t.tokens));
    case 'del':
      return chalk.dim.strikethrough(renderInline(t.tokens));
    case 'codespan':
      return chalk.yellow(t.text);
    case 'code':
      return renderCodeBlock(t);
    case 'list':
      return renderList(t);
    case 'blockquote':
      return renderBlockquote(t);
    case 'hr':
      return chalk.dim('─'.repeat(50)) + '\n\n';
    case 'link':
      return `${chalk.blue.underline(renderInline(t.tokens))} ${chalk.dim(`(${t.href})`)}`;
    case 'image':
      return chalk.blue(`🖼 ${t.title || t.href}`);
    case 'table':
      return renderTable(t);
    case 'text':
      if (t.tokens) return renderInline(t.tokens);
      return t.text || '';
    case 'html':
      return t.text || '';
    case 'space':
      return '';
    default:
      return t.text || '';
  }
}

function renderHeading(t: any): string {
  const text = renderInline(t.tokens);
  if (t.depth === 1) return `\n${chalk.bold.cyan(text)}\n\n`;
  if (t.depth === 2) return `\n${chalk.bold.cyan(`  ■ ${text}`)}\n\n`;
  return `\n${chalk.bold(`    ■ ${text}`)}\n\n`;
}

function renderInline(tokens: any[] | undefined): string {
  if (!tokens) return '';
  return tokens.map((t) => {
    if (typeof t === 'string') return t;
    if (t.type === 'strong') return chalk.bold(renderInline(t.tokens));
    if (t.type === 'em') return chalk.italic(renderInline(t.tokens));
    if (t.type === 'del') return chalk.dim.strikethrough(renderInline(t.tokens));
    if (t.type === 'codespan') return chalk.yellow(t.text);
    if (t.type === 'link') return `${chalk.blue.underline(renderInline(t.tokens))} ${chalk.dim(`(${t.href})`)}`;
    if (t.type === 'image') return chalk.blue(`🖼 ${t.title || t.href}`);
    if (t.type === 'text') {
      return t.tokens ? renderInline(t.tokens) : (t.text || '');
    }
    if (t.type === 'html') return t.text || '';
    return t.text || '';
  }).join('');
}

function renderCodeBlock(t: any): string {
  const lines = t.text
    .split('\n')
    .map((l: string) => `${chalk.dim('  ')}${chalk.yellow(l)}`)
    .join('\n');
  const langStr = t.lang ? chalk.dim(` [${t.lang}]`) : '';
  return `\n${langStr}\n${lines}\n\n`;
}

function renderList(t: any): string {
  const lines: string[] = [];
  const items = t.items || [];
  items.forEach((item: any, i: number) => {
    const bullet = t.ordered ? `${i + 1}.` : '•';
    const firstLine = renderInline(item.tokens?.[0]?.tokens || [{ text: item.text }]);
    lines.push(`  ${chalk.dim(bullet)} ${firstLine}`);

    const restTokens = (item.tokens || []).slice(1);
    for (const sub of restTokens) {
      if (sub.type === 'list') {
        const subLines = renderList(sub)
          .split('\n')
          .filter(Boolean)
          .map((l: string) => `    ${l}`)
          .join('\n');
        lines.push(subLines);
      } else if (sub.type === 'text') {
        lines.push(`    ${chalk.dim('•')} ${renderInline(sub.tokens)}`);
      }
    }
  });
  return lines.join('\n') + '\n\n';
}

function renderBlockquote(t: any): string {
  const content = renderTokens(t.tokens || []);
  const lines = content
    .split('\n')
    .filter((l: string) => l.trim())
    .map((l: string) => `${chalk.dim('│ ')}${chalk.gray(l)}`)
    .join('\n');
  return `\n${lines}\n\n`;
}

function renderTable(t: any): string {
  const headers = (t.header || []).map((h: any) => chalk.bold(renderInline(h.tokens)));
  const colWidths = (t.header || []).map((h: any, i: number) => {
    const hLen = (h.text || '').length;
    const rowLens = (t.rows || []).map((row: any) => {
      const cell = row[i];
      return cell?.text?.length ?? 0;
    });
    return Math.max(hLen, ...rowLens) + 2;
  });

  const headerLine = headers.map((h: string, i: number) => h.padEnd(colWidths[i])).join(chalk.dim(' │ '));
  const separator = colWidths.map((w: number) => '─'.repeat(w)).join(chalk.dim('─┼─'));

  const dataLines = (t.rows || []).map((row: any) =>
    row.map((cell: any, i: number) => {
      const text = renderInline(cell.tokens) || cell.text || '';
      return text.padEnd(colWidths[i]);
    }).join(chalk.dim(' │ '))
  );

  return `\n${headerLine}\n${chalk.dim(separator)}\n${dataLines.join('\n')}\n\n`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function mdToTelegram(text: string): string {
  let out = text;

  const codeBlocks: string[] = [];
  out = out.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
    const placeholder = `__CODEBLOCK_${codeBlocks.length}__`;
    codeBlocks.push(`<pre><code class="${lang}">${escapeHtml(code)}</code></pre>`);
    return placeholder;
  });

  const inlineCodes: string[] = [];
  out = out.replace(/`([^`]+)`/g, (_match, code) => {
    const placeholder = `__INLINECODE_${inlineCodes.length}__`;
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return placeholder;
  });

  const links: string[] = [];
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, href) => {
    const placeholder = `__LINK_${links.length}__`;
    links.push(`<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`);
    return placeholder;
  });

  out = escapeHtml(out);

  out = out.replace(/^### (.+)$/gm, '<b><i>$1</i></b>');
  out = out.replace(/^## (.+)$/gm, '<b>$1</b>');
  out = out.replace(/^# (.+)$/gm, '<b>$1</b>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  out = out.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<i>$1</i>');
  out = out.replace(/~~([^~]+)~~/g, '<s>$1</s>');

  for (let i = 0; i < inlineCodes.length; i++) {
    out = out.replace(`__INLINECODE_${i}__`, inlineCodes[i]);
  }
  for (let i = 0; i < codeBlocks.length; i++) {
    out = out.replace(`__CODEBLOCK_${i}__`, codeBlocks[i]);
  }
  for (let i = 0; i < links.length; i++) {
    out = out.replace(`__LINK_${i}__`, links[i]);
  }

  if (out.length > 4096) {
    out = out.slice(0, 4090) + '...';
  }

  return out;
}

export function mdToSignal(text: string): string {
  let out = text;

  const codeBlocks: string[] = [];
  out = out.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, _lang, code) => {
    const placeholder = `__CB_${codeBlocks.length}__`;
    codeBlocks.push(code.trim());
    return placeholder;
  });

  const inlineCodes: string[] = [];
  out = out.replace(/`([^`]+)`/g, (_match, code) => {
    const placeholder = `__IC_${inlineCodes.length}__`;
    inlineCodes.push(code);
    return placeholder;
  });

  const links: string[] = [];
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, href) => {
    const placeholder = `__LK_${links.length}__`;
    links.push(`${label} (${href})`);
    return placeholder;
  });

  out = out.replace(/^### (.+)$/gm, '*$1*');
  out = out.replace(/^## (.+)$/gm, '*$1*');
  out = out.replace(/^# (.+)$/gm, '*$1*');
  out = out.replace(/\*\*([^*]+)\*\*/g, '*$1*');
  out = out.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '_$1_');
  out = out.replace(/~~([^~]+)~~/g, '~$1~');

  for (let i = 0; i < inlineCodes.length; i++) {
    out = out.replace(`__IC_${i}__`, inlineCodes[i]);
  }
  for (let i = 0; i < codeBlocks.length; i++) {
    out = out.replace(`__CB_${i}__`, codeBlocks[i]);
  }
  for (let i = 0; i < links.length; i++) {
    out = out.replace(`__LK_${i}__`, links[i]);
  }

  if (out.length > 4000) {
    out = out.slice(0, 3990) + '...';
  }

  return out;
}

export function mdToDiscord(text: string): string {
  let out = text;

  const codeBlocks: string[] = [];
  out = out.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
    const placeholder = `__DCB_${codeBlocks.length}__`;
    codeBlocks.push(`\`\`\`${lang}\n${code.trim()}\n\`\`\``);
    return placeholder;
  });

  const inlineCodes: string[] = [];
  out = out.replace(/`([^`]+)`/g, (_match, code) => {
    const placeholder = `__DIC_${inlineCodes.length}__`;
    inlineCodes.push(`\`${code}\``);
    return placeholder;
  });

  const links: string[] = [];
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, href) => {
    const placeholder = `__DLK_${links.length}__`;
    links.push(`[${label}](${href})`);
    return placeholder;
  });

  out = out.replace(/^### (.+)$/gm, '__$1__');
  out = out.replace(/^## (.+)$/gm, '**$1**');
  out = out.replace(/^# (.+)$/gm, '**$1**');
  out = out.replace(/~~([^~]+)~~/g, '~~$1~~');

  for (let i = 0; i < inlineCodes.length; i++) {
    out = out.replace(`__DIC_${i}__`, inlineCodes[i]);
  }
  for (let i = 0; i < codeBlocks.length; i++) {
    out = out.replace(`__DCB_${i}__`, codeBlocks[i]);
  }
  for (let i = 0; i < links.length; i++) {
    out = out.replace(`__DLK_${i}__`, links[i]);
  }

  if (out.length > 2000) {
    out = out.slice(0, 1990) + '...';
  }

  return out;
}

export function mdToSlack(text: string): string {
  let out = text;

  const codeBlocks: string[] = [];
  out = out.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
    const placeholder = `__SCB_${codeBlocks.length}__`;
    codeBlocks.push(`\`\`\`${lang}\n${code.trim()}\n\`\`\``);
    return placeholder;
  });

  const inlineCodes: string[] = [];
  out = out.replace(/`([^`]+)`/g, (_match, code) => {
    const placeholder = `__SIC_${inlineCodes.length}__`;
    inlineCodes.push(`\`${code}\``);
    return placeholder;
  });

  const links: string[] = [];
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, href) => {
    const placeholder = `__SLK_${links.length}__`;
    links.push(`<${href}|${label}>`);
    return placeholder;
  });

  out = out.replace(/^### (.+)$/gm, '*$1*');
  out = out.replace(/^## (.+)$/gm, '*$1*');
  out = out.replace(/^# (.+)$/gm, '*$1*');
  out = out.replace(/\*\*([^*]+)\*\*/g, '*$1*');
  out = out.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '_$1_');
  out = out.replace(/~~([^~]+)~~/g, '~$1~');
  out = out.replace(/^- /gm, '• ');

  for (let i = 0; i < inlineCodes.length; i++) {
    out = out.replace(`__SIC_${i}__`, inlineCodes[i]);
  }
  for (let i = 0; i < codeBlocks.length; i++) {
    out = out.replace(`__SCB_${i}__`, codeBlocks[i]);
  }
  for (let i = 0; i < links.length; i++) {
    out = out.replace(`__SLK_${i}__`, links[i]);
  }

  if (out.length > 40000) {
    out = out.slice(0, 39990) + '...';
  }

  return out;
}