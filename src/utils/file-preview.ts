/**
 * File-change previews for the Mercury Code transcript.
 *
 * When the agent creates, writes, or edits a file, the transcript shows a
 * bounded, syntax-highlighted excerpt of the change (fenced as `diff` for
 * edits, or the file's own language for creations) instead of a bare tool
 * step. Large files are NOT dumped — only a head excerpt and a pointer to
 * the full content on disk. This is deliberately selective feedback: small
 * changes show fully, big ones show shape.
 */

/** Fence language for a file path, for the TUI highlighter. */
export function fenceLangForPath(path: string): string {
  const ext = path.includes('.') ? path.split('.').pop()!.toLowerCase() : '';
  const MAP: Record<string, string> = {
    ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js',
    py: 'python', rs: 'rust', go: 'go',
    json: 'json', jsonc: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
    html: 'html', css: 'css', scss: 'scss', less: 'less',
    sh: 'sh', bash: 'bash', zsh: 'zsh',
    md: 'md', sql: 'sql', java: 'java', kt: 'kotlin', rb: 'ruby', php: 'php',
    c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', swift: 'swift',
  };
  return MAP[ext] ?? '';
}

function relativeish(path: string): string {
  // Full path is noisy in a transcript; show the last 2 segments.
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.slice(-2).join('/');
}

function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split('\n').length;
}

function head(text: string, maxLines: number): { lines: string[]; omitted: number } {
  const all = text.split('\n');
  if (all.length <= maxLines) return { lines: all, omitted: 0 };
  return { lines: all.slice(0, maxLines), omitted: all.length - maxLines };
}

/** Tools that change files and are preview-eligible. */
export const FILE_CHANGE_TOOLS: ReadonlySet<string> = new Set([
  'write_file', 'create_file', 'edit_file', 'delete_file',
]);

export interface FileChangePreviewInput {
  toolName: string;
  args: Record<string, any>;
  /** Raw tool result text (used to detect failures). */
  resultText: string;
  /** Whether the tool invocation succeeded. */
  ok: boolean;
}

/**
 * Build a transcript-ready preview string, or null when the change should
 * not be shown (failures, huge trivial content, non-preview tools).
 * Output is a system-chat-message body: header line + fenced block.
 */
export function buildFileChangePreview(input: FileChangePreviewInput): string | null {
  const { toolName, args, resultText, ok } = input;
  if (!ok || !FILE_CHANGE_TOOLS.has(toolName)) return null;
  const path = typeof args?.path === 'string' ? args.path : '';
  if (!path) return null;
  // Failed results (permission denied, etc.) surface through the step list.
  if (/^(error|⚠)/i.test(resultText.trim())) return null;

  if (toolName === 'delete_file') {
    return `🗑 Deleted \`${relativeish(path)}\``;
  }

  if (toolName === 'edit_file') {
    const oldStr = typeof args?.old_string === 'string' ? args.old_string : '';
    const newStr = typeof args?.new_string === 'string' ? args.new_string : '';
    if (!oldStr && !newStr) return null;
    const MAX_SIDE = 16;
    const removed = oldStr.length > 0 ? head(oldStr, MAX_SIDE) : { lines: [], omitted: 0 };
    const added = newStr.length > 0 ? head(newStr, MAX_SIDE) : { lines: [], omitted: 0 };
    const body: string[] = [];
    for (const line of removed.lines) body.push(`-${line}`);
    if (removed.omitted > 0) body.push(`… −${removed.omitted} removed lines not shown`);
    for (const line of added.lines) body.push(`+${line}`);
    if (added.omitted > 0) body.push(`… +${added.omitted} added lines not shown`);
    const stats = `+${countLines(newStr)} −${countLines(oldStr)}`;
    return [`✎ Edited \`${relativeish(path)}\` · ${stats}`, '', '```diff', ...body, '```'].join('\n');
  }

  // write_file / create_file
  const content = typeof args?.content === 'string' ? args.content : '';
  if (content.length === 0) return null;
  const lang = fenceLangForPath(path);
  const action = toolName === 'create_file' ? 'Created' : 'Wrote';
  const total = countLines(content);
  const MAX_PREVIEW = 48;
  const excerpt = head(content, MAX_PREVIEW);
  const body: string[] = [];
  body.push(...excerpt.lines);
  if (excerpt.omitted > 0) {
    body.push(`… +${excerpt.omitted} more lines (full content on disk)`);
  }
  return [
    `✨ ${action} \`${relativeish(path)}\` · ${total} line${total === 1 ? '' : 's'}`,
    '',
    `\`\`\`${lang}`,
    ...body,
    '```',
  ].join('\n');
}