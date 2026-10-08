/**
 * Tool blocks for the Mercury Code transcript.
 *
 * Every finished tool call leaves one persistent block in scrollback, so the
 * transcript reads as what the agent actually did, in order:
 *
 *   ● Update(src/auth/session.ts)
 *     ⎿  1 addition, 1 removal
 *          -  const ttl = 3600;
 *          +  const ttl = config.sessionTtl ?? 3600;
 *
 * This module only builds the data (pure, testable); mercury-transcript.ts
 * turns it into rows and App.tsx styles them.
 */
import { fenceLangForPath } from '../utils/file-preview.js';
import { formatToolResult } from '../utils/tool-label.js';

export interface ToolBlock {
  /** Raw tool name (read_file, run_command, …). */
  name: string;
  /** Verb shown in bold: Read, Update, Bash, … */
  title: string;
  /** Argument shown in parentheses: a path, a command, a URL. */
  target: string;
  status: 'done' | 'error';
  /** One-line outcome shown after the ⎿ elbow. */
  summary: string;
  /** Optional excerpt under the summary: a diff, file head, or command output. */
  body?: { lang: string; lines: string[] };
}

/** Tools whose work is already shown elsewhere in the TUI (choice prompt,
 * permission prompt) — no transcript block. */
const HIDDEN_TOOLS: ReadonlySet<string> = new Set([
  'ask_user', 'approve_scope', 'approve_command',
]);

export function isTranscriptTool(toolName: string): boolean {
  return !HIDDEN_TOOLS.has(toolName);
}

/** Diff rows shown for an edit before collapsing to "… +N lines". */
export const TOOL_DIFF_MAX_LINES = 20;
/** Head rows of a written/created file. */
export const TOOL_WRITE_MAX_LINES = 8;
/** Tail rows of command output (errors and test summaries live at the end). */
export const TOOL_OUTPUT_MAX_LINES = 6;
/** Rows kept for an expanded (ctrl+o) block. */
export const TOOL_EXPAND_MAX_LINES = 2000;
/** Hint on collapsed excerpts: the expand key. */
export const EXPAND_HINT = 'ctrl+o to expand';

const TITLES: Record<string, string> = {
  read_file: 'Read',
  write_file: 'Write',
  create_file: 'Create',
  edit_file: 'Update',
  delete_file: 'Delete',
  list_dir: 'List',
  run_command: 'Bash',
  cd: 'Cd',
  fetch_url: 'Fetch',
  delegate_task: 'Agent',
  use_skill: 'Skill',
  search_memory: 'Recall',
  save_memory: 'Remember',
  update_plan: 'Plan',
};

function titleFor(toolName: string): string {
  if (TITLES[toolName]) return TITLES[toolName];
  if (toolName.startsWith('git_')) return 'Git';
  // github_api → Github api, create_pr → Create pr
  const words = toolName.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Show paths relative to the project root; anything else as given. */
export function displayPath(path: string, cwd?: string): string {
  const p = path.replace(/\\/g, '/');
  if (cwd) {
    const root = cwd.replace(/\\/g, '/').replace(/\/$/, '');
    if (p === root) return '.';
    if (p.startsWith(`${root}/`)) return p.slice(root.length + 1);
  }
  return p;
}

function oneLine(text: string, max = 80): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function targetFor(toolName: string, args: Record<string, any>, cwd?: string): string {
  if (typeof args.path === 'string' && args.path) return displayPath(args.path, cwd);
  if (toolName === 'run_command' && typeof args.command === 'string') return oneLine(args.command);
  if (typeof args.url === 'string') return oneLine(args.url);
  if (typeof args.task === 'string') return oneLine(args.task, 60);
  if (typeof args.name === 'string') return oneLine(args.name);
  if (typeof args.query === 'string') return oneLine(args.query, 60);
  if (toolName.startsWith('git_')) return toolName.slice(4);
  return '';
}

function resultText(result: unknown): string {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (result instanceof Error) return `Error: ${result.message}`;
  const r = result as any;
  if (typeof r.result === 'string') return r.result;
  if (typeof r.message === 'string' && r.name) return `Error: ${r.message}`;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function lineCount(text: string): number {
  if (text.length === 0) return 0;
  return text.replace(/\n$/, '').split('\n').length;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * Line diff of an edit: common leading/trailing lines are trimmed down to
 * one line of context each side, so an edit touching one line inside a
 * 20-line `old_string` shows as one -/+ pair instead of 20 of each.
 */
export function editDiffLines(oldStr: string, newStr: string): { lines: string[]; added: number; removed: number } {
  const a = oldStr.length > 0 ? oldStr.split('\n') : [];
  const b = newStr.length > 0 ? newStr.split('\n') : [];
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const removed = a.slice(pre, a.length - suf);
  const added = b.slice(pre, b.length - suf);
  const lines: string[] = [];
  if (pre > 0) lines.push(` ${a[pre - 1]}`);
  for (const l of removed) lines.push(`-${l}`);
  for (const l of added) lines.push(`+${l}`);
  if (suf > 0) lines.push(` ${a[a.length - suf]}`);
  return { lines, added: added.length, removed: removed.length };
}

function capHead(lines: string[], max: number): string[] {
  if (lines.length <= max) return lines;
  return [...lines.slice(0, max), `… +${lines.length - max} lines (${EXPAND_HINT})`];
}

function capTail(lines: string[], max: number): string[] {
  if (lines.length <= max) return lines;
  return [`… ${lines.length - max} earlier lines (${EXPAND_HINT})`, ...lines.slice(-max)];
}

/** Plan checklist rows: ☒ done, ▶ active, ☐ pending. */
function planRows(steps: unknown): string[] {
  if (!Array.isArray(steps)) return [];
  const mark: Record<string, string> = { done: '☒', active: '▶', pending: '☐' };
  return steps
    .filter((st: any) => typeof st?.label === 'string' && mark[st?.status])
    .slice(0, 20)
    .map((st: any) => `${mark[st.status]} ${oneLine(st.label, 100)}`);
}

/** Split run_command's result text into exit code + output lines. */
function parseCommandResult(text: string): { exitCode: number | null; output: string[] } {
  const exit = /^Command exited with code (\d+)/.exec(text);
  let body = text;
  let exitCode: number | null = null;
  if (exit) {
    exitCode = Number(exit[1]);
    body = text.slice(exit[0].length).replace(/^\nOutput: /, '').replace(/\nError: /, '\n');
  }
  const output = body.trim() === '(no output)' ? [] : body.replace(/\s+$/, '').split('\n').filter((l, i, all) => l.trim() !== '' || (i > 0 && i < all.length - 1));
  return { exitCode, output };
}

/**
 * Tool failures follow one convention: the result STARTS with the marker.
 * (execute-guard's isFailedToolResult matches anywhere in the head, which is
 * right for its job but would paint a read of any file mentioning "error:"
 * as failed.)
 */
const FAILED_PREFIX_RE = /^(error\b|⚠|command failed|command exited with code)/i;

export interface ToolBlockInput {
  toolName: string;
  args: Record<string, any>;
  result: unknown;
  /** The SDK reported the call as failed (threw). */
  isError: boolean;
  /** Project root, to show paths relative to it. */
  cwd?: string;
}

export interface ToolBlockDetail {
  block: ToolBlock;
  /** The uncollapsed excerpt, when `block.body` had to collapse it. */
  full?: { lang: string; lines: string[] };
}

export function buildToolBlock(input: ToolBlockInput): ToolBlock {
  return buildToolBlockDetail(input).block;
}

export function buildToolBlockDetail(input: ToolBlockInput): ToolBlockDetail {
  let full: ToolBlockDetail['full'];
  // Collapse `lines` into the block body; keep the whole thing for ctrl+o.
  const body = (lang: string, lines: string[], cap: (l: string[], max: number) => string[], max: number) => {
    if (lines.length > max) {
      // Heads keep the start, tails keep the end — same side the excerpt shows.
      const kept = cap === capTail ? lines.slice(-TOOL_EXPAND_MAX_LINES) : lines.slice(0, TOOL_EXPAND_MAX_LINES);
      full = { lang, lines: kept };
    }
    return { lang, lines: cap(lines, max) };
  };
  const block = buildBlock(input, body);
  return full ? { block, full } : { block };
}

type BodyFn = (lang: string, lines: string[], cap: (l: string[], max: number) => string[], max: number) => { lang: string; lines: string[] };

function buildBlock(input: ToolBlockInput, body: BodyFn): ToolBlock {
  const { toolName, cwd } = input;
  const args = input.args ?? {};
  const text = resultText(input.result);
  const failed = input.isError || FAILED_PREFIX_RE.test(text.trimStart());
  const block: ToolBlock = {
    name: toolName,
    title: titleFor(toolName),
    target: targetFor(toolName, args, cwd),
    status: failed ? 'error' : 'done',
    summary: '',
  };

  if (toolName === 'run_command') {
    const { exitCode, output } = parseCommandResult(text);
    if (exitCode != null) block.status = 'error';
    const timedOut = text.startsWith('⏱');
    if (failed && exitCode == null && !timedOut) {
      block.summary = oneLine(text.split('\n')[0], 120);
      return block;
    }
    block.summary = timedOut
      ? oneLine(text.split('\n')[0], 120)
      : exitCode != null
        ? `Exit code ${exitCode}`
        : output.length === 0 ? '(no output)' : plural(output.length, 'line');
    if (output.length > 0 && !timedOut) block.body = body('', output, capTail, TOOL_OUTPUT_MAX_LINES);
    return block;
  }

  // Failures: the first line of the error is the whole story.
  if (failed) {
    block.summary = oneLine(text.split('\n')[0] || 'failed', 120);
    return block;
  }

  switch (toolName) {
    case 'read_file':
      block.summary = `Read ${plural(lineCount(text), 'line')}`;
      break;
    case 'edit_file': {
      const diff = editDiffLines(String(args.old_string ?? ''), String(args.new_string ?? ''));
      block.summary = `${plural(diff.added, 'addition')}, ${plural(diff.removed, 'removal')}`;
      if (diff.lines.length > 0) block.body = body('diff', diff.lines, capHead, TOOL_DIFF_MAX_LINES);
      break;
    }
    case 'write_file':
    case 'create_file': {
      const content = typeof args.content === 'string' ? args.content : '';
      const n = lineCount(content);
      block.summary = `${toolName === 'create_file' ? 'Created' : 'Wrote'} ${plural(n, 'line')}`;
      if (n > 0) {
        const lang = typeof args.path === 'string' ? fenceLangForPath(args.path) : '';
        block.body = body(lang || 'text', content.replace(/\n$/, '').split('\n'), capHead, TOOL_WRITE_MAX_LINES);
      }
      break;
    }
    case 'delete_file':
      block.summary = 'Deleted';
      break;
    case 'update_plan': {
      const rows = planRows(args.steps);
      const done = rows.filter((r) => r.startsWith('☒')).length;
      block.summary = `${done}/${rows.length} done`;
      if (rows.length > 0) block.body = { lang: 'plan', lines: rows };
      break;
    }
    default:
      block.summary = formatToolResult(toolName, text) || 'Done';
  }
  return block;
}
