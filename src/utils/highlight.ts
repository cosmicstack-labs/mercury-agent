/**
 * Lightweight dependency-free syntax highlighter for the Mercury Code TUI.
 * Produces chalk-colored plain text safe to print inside Ink <Text> rows.
 */

import chalk from 'chalk';

const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;

function esc(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(CONTROL, '');
}

type Rule = { re: RegExp; color: (s: string) => string };

const SHARED_RULES: Rule[] = [
  // shebang
  { re: /^#![^\n]*/, color: (s) => chalk.gray(s) },
];

const C_FAMILY: Rule[] = [
  { re: /^\/\/[^\n]*/, color: (s) => chalk.gray(s) },
  { re: /^\/\*[\s\S]*?\*\//, color: (s) => chalk.gray(s) },
  { re: /^`(?:\\.|[^`\\])*`?/, color: (s) => chalk.green(s) },
  { re: /^'(?:\\.|[^'\\\n])*'?/, color: (s) => chalk.green(s) },
  { re: /^"(?:\\.|[^"\\\n])*"?/, color: (s) => chalk.green(s) },
  { re: /^-?\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?/, color: (s) => chalk.magenta(s) },
  { re: /^(?:abstract|as|break|case|catch|class|const|continue|default|delete|do|else|enum|export|extends|finally|for|from|function|get|if|implements|import|in|instanceof|interface|is|keyof|let|namespace|new|of|private|protected|public|readonly|return|satisfies|set|static|super|switch|this|throw|try|type|typeof|var|void|while|yield|async|await)\b/, color: (s) => chalk.yellow(s) },
  { re: /^(?:true|false|null|unique|undefined|NaN|Infinity)\b/, color: (s) => chalk.blue(s) },
  { re: /^[A-Za-z_$][\w$]*(?=\s*\()/, color: (s) => chalk.cyan(s) },
  { re: /^[A-Z][\w$]*/, color: (s) => chalk.blue(s) },
];

const PY_RULES: Rule[] = [
  { re: /^#[^\n]*/, color: (s) => chalk.gray(s) },
  { re: /^"""[\s\S]*?("""|$)/, color: (s) => chalk.gray(s) },
  { re: /^'''[\s\S]*?('''|$)/, color: (s) => chalk.gray(s) },
  { re: /^f?"(?:\\.|[^"\\\n])*"?/, color: (s) => chalk.green(s) },
  { re: /^f?'(?:\\.|[^'\\\n])*'?/, color: (s) => chalk.green(s) },
  { re: /^\d[\d_]*(?:\.\d+)?/, color: (s) => chalk.magenta(s) },
  { re: /^(?:def|class|import|from|return|if|elif|else|for|while|try|except|finally|with|as|lambda|yield|raise|pass|break|continue|global|nonlocal|assert|async|await|not|and|or|in|is|del)\b/, color: (s) => chalk.yellow(s) },
  { re: /^(?:True|False|None|self|cls)\b/, color: (s) => chalk.blue(s) },
  { re: /^[A-Za-z_]\w*(?=\s*\()/, color: (s) => chalk.cyan(s) },
  { re: /^[A-Z][\w]*/, color: (s) => chalk.blue(s) },
  { re: /^@\w[\w.]*/, color: (s) => chalk.green(s) },
];

const SHELL_RULES: Rule[] = [
  { re: /^#[^\n]*/, color: (s) => chalk.gray(s) },
  { re: /^(?:if|then|else|elif|fi|for|while|do|done|case|esac|function|return|export|local|source|set|unset|cd|exit)\b/, color: (s) => chalk.yellow(s) },
  { re: /^\$\{[^}]*\}?\$?/, color: (s) => chalk.magenta(s) },
  { re: /^\$\w*/, color: (s) => chalk.magenta(s) },
  { re: /^"(?:\\.|[^"\\])*"?/, color: (s) => chalk.green(s) },
  { re: /^'(?:[^'\\])*'?/, color: (s) => chalk.green(s) },
  { re: /^\d+/, color: (s) =>chalk.magenta(s) },
  { re: /^(?:npm|pnpm|yarn|node|npx|git|curl|wget|python|python3|pip|cargo|go|make|brew|ls|cat|echo|mkdir|rm|mv|cp|cd|chmod|docker|kubectl)\b/, color: (s) => chalk.cyan(s) },
];

const JSON_RULES: Rule[] = [
  { re: /^"(?:\\.|[^"\\])*"(?=\s*:)/, color: (s) => chalk.blue(s) },
  { re: /^"(?:\\.|[^"\\])*"?/, color: (s) => chalk.green(s) },
  { re: /^-?\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?/, color: (s) => chalk.magenta(s) },
  { re: /^(?:true|false|null)\b/, color: (s) => chalk.blue(s) },
];

const CSS_RULES: Rule[] = [
  { re: /^\/\*[\s\S]*?\*\//, color: (s) => chalk.gray(s) },
  { re: /^@[\w-]+/, color: (s) => chalk.yellow(s) },
  { re: /^[.#]?[\w-]+(?=\s*\{)/, color: (s) => chalk.cyan(s) },
  { re: /^[\w-]+(?=\s*:)/, color: (s) => chalk.blue(s) },
  { re: /^"(?:\\.|[^"\\\n])*"?/, color: (s) => chalk.green(s) },
  { re: /^'(?:[^'\\\n])*'?/, color: (s) => chalk.green(s) },
  { re: /^-?\d[\d.]*(?:px|em|rem|%|vh|vw|s|ms|fr)?/, color: (s) => chalk.magenta(s) },
];

const GO_RULES: Rule[] = [
  { re: /^\/\/[^\n]*/, color: (s) => chalk.gray(s) },
  { re: /^\/\*[\s\S]*?\*\//, color: (s) => chalk.gray(s) },
  { re: /^"(?:\\.|[^"\\\n])*"?/, color: (s) => chalk.green(s) },
  { re: /^`(?:\\.|[^`\\])*`?/, color: (s) => chalk.green(s) },
  { re: /^\d[\d_]*(?:\.\d+)?/, color: (s) => chalk.magenta(s) },
  { re: /^(?:package|import|func|return|if|else|for|range|switch|case|default|type|struct|interface|map|chan|go|defer|var|const|select|break|continue|fallthrough)\b/, color: (s) => chalk.yellow(s) },
  { re: /^[A-Za-z_]\w*(?=\s*\()/, color: (s) => chalk.cyan(s) },
  { re: /^[A-Z][\w]*/, color: (s) => chalk.blue(s) },
];

const RUST_RULES: Rule[] = [
  { re: /^\/\/[^\n]*/, color: (s) => chalk.gray(s) },
  { re: /^\/\*[\s\S]*?\*\//, color: (s) => chalk.gray(s) },
  { re: /^"(?:\\.|[^"\\\n])*"?/, color: (s) => chalk.green(s) },
  { re: /^\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?/, color: (s) => chalk.magenta(s) },
  { re: /^(?:as|break|const|continue|crate|dyn|else|enum|extern|false|fn|for|if|impl|in|let|loop|match|mod|move|mut|pub|ref|return|self|Self|static|struct|super|trait|true|type|unsafe|use|where|while|async|await)\b/, color: (s) => chalk.yellow(s) },
  { re: /^&['\u2019]?\w*\b/, color: (s) => chalk.cyan(s) },
  { re: /^\w+!/, color: (s) => chalk.cyan(s) },
  { re: /^[A-Za-z_]\w*(?=\s*[<(])/ , color: (s) => chalk.cyan(s) },
  { re: /^[A-Z][\w]*/, color: (s) => chalk.blue(s) },
];

const RULESETS: Record<string, Rule[]> = {
  javascript: C_FAMILY,
  json: JSON_RULES,
  python: PY_RULES,
  shell: SHELL_RULES,
  css: CSS_RULES,
  go: GO_RULES,
  rust: RUST_RULES,
};

const ALIAS: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'javascript', tsx: 'javascript', typescript: 'javascript',
  py: 'python', python3: 'python',
  sh: 'shell', bash: 'shell', zsh: 'shell', console: 'shell', shellscript: 'shell',
  golang: 'go',
  rs: 'rust',
  jsonc: 'json', json5: 'json',
  less: 'css', scss: 'css', sass: 'css', html: 'css', xml: 'css', vue: 'css', svelte: 'css',
  yaml: 'json', yml: 'json', toml: 'json', ini: 'json',
};

export interface HighlightOptions {
  /** Paint each whole line with a uniform color instead of tokenizing. */
  uniform?: 'red' | 'green';
}

/**
 * Highlight a single line of code for the given language id.
 * Falls back to uncaptured plain text — never throws.
 */
export function highlightLine(line: string, lang: string, opts?: HighlightOptions): string {
  if (opts?.uniform) {
    return opts.uniform === 'red' ? chalk.red(line) : chalk.green(line);
  }
  try {
    const ruleset = RULESETS[ALIAS[lang?.toLowerCase() ?? ''] ?? lang?.toLowerCase() ?? ''] ?? C_FAMILY;
    let rest = esc(line);
    let out = '';
    let guard = 0;
    while (rest.length > 0 && guard++ < 400) {
      let matched = false;
      for (const rule of ruleset) {
        const m = rule.re.exec(rest);
        if (m && m[0].length > 0) {
          out += rule.color(m[0]);
          rest = rest.slice(m[0].length);
          matched = true;
          break;
        }
      }
      if (!matched) {
        out += rest[0];
        rest = rest.slice(1);
      }
    }
    if (rest.length > 0) out += rest;
    return out;
  } catch {
    return line;
  }
}

/** Whole-line uniform diff renderer: - red, + green, header gray/blue. */
export function highlightDiffLine(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return chalk.blue(line);
  if (line.startsWith('+++') || line.startsWith('---')) return chalk.blue(line);
  if (line.startsWith('diff ')) return chalk.bold.blue(line);
  if (line.startsWith('@@')) return chalk.cyan(line);
  if (line.startsWith('+')) return chalk.green(line);
  if (line.startsWith('-')) return chalk.red(line);
  return line;
}

/**
 * Highlight a fenced code block body. Detects unified diffs independently
 * of the fence language tag.
 */
export function highlightCodeBlock(body: string, lang?: string): string[] {
  const trimmedLang = (lang || '').trim().toLowerCase();
  if (trimmedLang === 'diff' || trimmedLang === 'patch' || /^(diff --git|--- a\/|\+\+\+ b\/)/m.test(body)) {
    return body.split('\n').map(highlightDiffLine);
  }
  return body.split('\n').map((l) => highlightLine(l, trimmedLang));
}