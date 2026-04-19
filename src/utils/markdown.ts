import { Marked } from 'marked';
import type { Tokens, MarkedExtension } from 'marked';
import chalk from 'chalk';

const cliExtension: MarkedExtension = {
  renderer: {
    heading({ text, depth }: Tokens.Heading) {
      if (depth === 1) return `\n${chalk.bold.cyan(text)}\n`;
      if (depth === 2) return `\n${chalk.bold.cyan(`  ■ ${text}`)}\n`;
      return `\n${chalk.bold(`    ■ ${text}`)}\n`;
    },

    paragraph({ tokens }: Tokens.Paragraph) {
      const p = (this as any).parser;
      if (p && tokens) return p.parseInline(tokens) + '\n';
      return '' + '\n';
    },

    strong({ text }: Tokens.Strong) {
      return chalk.bold(text);
    },

    em({ text }: Tokens.Em) {
      return chalk.italic(text);
    },

    del({ text }: Tokens.Del) {
      return chalk.dim.strikethrough(text);
    },

    codespan({ text }: Tokens.Codespan) {
      return chalk.yellow(text);
    },

    code({ text, lang }: Tokens.Code) {
      const lines = text
        .split('\n')
        .map((l) => `${chalk.dim('  ')}${chalk.yellow(l)}`)
        .join('\n');
      const langStr = lang ? chalk.dim(` [${lang}]`) : '';
      return `\n${langStr}\n${lines}\n`;
    },

    list({ ordered, items }: Tokens.List) {
      const p = (this as any).parser;
      const lines: string[] = [];
      items?.forEach((item, i) => {
        const bullet = ordered ? `${i + 1}.` : '•';
        let content = item.text;
        if (p && item.tokens) content = p.parseInline(item.tokens);
        lines.push(`  ${chalk.dim(bullet)} ${content}`);
      });
      return `\n${lines.join('\n')}\n`;
    },

    listitem({ text }: Tokens.ListItem) {
      return text;
    },

    blockquote({ text, tokens }: Tokens.Blockquote) {
      const p = (this as any).parser;
      let content = text;
      if (p && tokens) content = p.parseInline(tokens);
      const lines = content
        .split('\n')
        .map((l) => `${chalk.dim('│ ')}${chalk.gray(l)}`)
        .join('\n');
      return `\n${lines}\n`;
    },

    hr() {
      return chalk.dim('─'.repeat(50)) + '\n';
    },

    link({ text, href }: Tokens.Link) {
      return `${chalk.blue.underline(text)} ${chalk.dim(`(${href})`)}`;
    },

    image({ href, title }: Tokens.Image) {
      const label = title || href;
      return chalk.blue(`🖼 ${label}`);
    },

    table({ header, rows }: Tokens.Table) {
      const p = (this as any).parser;
      const headers = header.map((h) => {
        const text = h.tokens ? p?.parseInline(h.tokens) ?? h.text : h.text;
        return chalk.bold(text);
      });
      const colWidths = header.map((h, i) => {
        const contentWidths = rows.map((row) => {
          const cell = row[i];
          const t = typeof cell === 'object' && 'tokens' in cell
            ? p?.parseInline(cell.tokens) ?? cell.text
            : String(cell);
          return t.length;
        });
        return Math.max(h.text.length, ...contentWidths) + 2;
      });

      const headerLine = headers
        .map((h, i) => h.padEnd(colWidths[i]))
        .join(chalk.dim(' │ '));
      const separator = colWidths.map((w) => '─'.repeat(w)).join(chalk.dim('─┼─'));

      const dataLines = rows.map((row) =>
        row
          .map((cell, i) => {
            const t = typeof cell === 'object' && 'tokens' in cell
              ? p?.parseInline(cell.tokens) ?? cell.text
              : String(cell);
            return t.padEnd(colWidths[i]);
          })
          .join(chalk.dim(' │ '))
      );

      return `\n${headerLine}\n${chalk.dim(separator)}\n${dataLines.join('\n')}\n`;
    },
  },
};

const cliMarked = new Marked(cliExtension);

export function renderMarkdown(text: string): string {
  try {
    const result = cliMarked.parse(text, { async: false });
    if (typeof result === 'string') {
      return result.replace(/\n{3,}/g, '\n\n').trim();
    }
    return text;
  } catch {
    return text;
  }
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