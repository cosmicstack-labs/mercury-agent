import { z } from 'zod';

const TOOL_LABELS: Record<string, { icon: string; label: string; argKey?: string; argTransform?: (v: string) => string }> = {
  fetch_url: { icon: '↗', label: 'Fetching', argKey: 'url', argTransform: extractDomain },
  read_file: { icon: '📄', label: 'Reading', argKey: 'path', argTransform: basename },
  write_file: { icon: '✏️', label: 'Writing', argKey: 'path', argTransform: basename },
  create_file: { icon: '✨', label: 'Creating', argKey: 'path', argTransform: basename },
  edit_file: { icon: '✂️', label: 'Editing', argKey: 'path', argTransform: basename },
  delete_file: { icon: '🗑', label: 'Deleting', argKey: 'path', argTransform: basename },
  list_dir: { icon: '📂', label: 'Listing', argKey: 'path', argTransform: basename },
  approve_scope: { icon: '🔓', label: 'Approving scope' },
  run_command: { icon: '⌨', label: 'Running command', argKey: 'command', argTransform: truncate(40) },
  cd: { icon: '📂', label: 'Changing dir to', argKey: 'path' },
  approve_command: { icon: '✅', label: 'Approving command' },
  send_message: { icon: '💬', label: 'Sending message' },
  send_file: { icon: '📎', label: 'Sending file', argKey: 'path', argTransform: basename },
  git_status: { icon: '📊', label: 'Git status' },
  git_diff: { icon: '📝', label: 'Git diff' },
  git_log: { icon: '📋', label: 'Git log' },
  git_add: { icon: '➕', label: 'Staging files' },
  git_commit: { icon: '💾', label: 'Committing' },
  git_push: { icon: '⬆', label: 'Pushing' },
  create_pr: { icon: '🔀', label: 'Creating PR' },
  review_pr: { icon: '👀', label: 'Reviewing PR' },
  list_issues: { icon: '📋', label: 'Listing issues' },
  create_issue: { icon: '🐛', label: 'Creating issue' },
  github_api: { icon: '🔀', label: 'GitHub API', argKey: 'path', argTransform: truncate(30) },
  schedule_task: { icon: '⏰', label: 'Scheduling task' },
  cancel_task: { icon: '❌', label: 'Cancelling task' },
  list_tasks: { icon: '📋', label: 'Listing tasks' },
  use_skill: { icon: '🧠', label: 'Using skill', argKey: 'name' },
  list_skills: { icon: '📋', label: 'Listing skills' },
  install_skill: { icon: '📥', label: 'Installing skill' },
  budget_status: { icon: '💰', label: 'Budget status' },
};

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function basename(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || p;
}

function truncate(maxLen: number): (v: string) => string {
  return (v: string) => v.length > maxLen ? v.slice(0, maxLen) + '…' : v;
}

export function formatToolStep(toolName: string, args: Record<string, any>): string {
  const config = TOOL_LABELS[toolName];
  if (!config) {
    return toolName;
  }

  let detail = '';
  if (config.argKey && args[config.argKey] !== undefined) {
    const raw = String(args[config.argKey]);
    detail = config.argTransform ? config.argTransform(raw) : raw;
  }

  return detail ? `${config.icon} ${config.label} ${detail}` : `${config.icon} ${config.label}`;
}

export function formatToolResult(toolName: string, result: unknown): string {
  if (result == null) return '';
  const str = typeof result === 'string' ? result : JSON.stringify(result);
  if (!str) return '';

  if (str.startsWith('Error') || str.startsWith('⚠')) {
    const first = str.split('\n')[0];
    return first.length > 80 ? first.slice(0, 77) + '…' : first;
  }

  const RESULT_HINTS: Record<string, (s: string) => string> = {
    read_file: (s) => `${s.split('\n').length} lines`,
    write_file: (s) => s.startsWith('Success') ? 'saved' : trimFirst(s),
    create_file: (s) => s.startsWith('Success') ? 'created' : trimFirst(s),
    edit_file: (s) => s.startsWith('Success') ? 'edited' : trimFirst(s),
    delete_file: (s) => s.startsWith('Success') ? 'deleted' : trimFirst(s),
    list_dir: (s) => {
      const entries = s.split('\n').filter(Boolean).length;
      return `${entries} entries`;
    },
    run_command: (s) => {
      if (s.includes('exited with code')) return s.split('\n')[0];
      const lines = s.split('\n').filter(Boolean).length;
      return lines <= 1 ? trimFirst(s) : `${lines} lines output`;
    },
    fetch_url: () => 'fetched',
    git_status: (s) => `${s.split('\n').filter(Boolean).length} lines`,
    git_diff: (s) => `${s.split('\n').filter(Boolean).length} lines`,
    git_log: (s) => `${s.split('\n').filter(Boolean).length} commits`,
    git_add: () => 'staged',
    git_commit: () => 'committed',
    git_push: () => 'pushed',
    create_pr: (s) => s.includes('created') ? 'created' : trimFirst(s),
    review_pr: (s) => `${s.split('\n').filter(Boolean).length} lines`,
    list_issues: (s) => `${s.split('\n').filter(Boolean).length} issues`,
    create_issue: (s) => s.includes('created') ? 'created' : trimFirst(s),
    github_api: (s) => `${s.split('\n').filter(Boolean).length} lines`,
    send_message: () => 'sent',
    send_file: () => 'sent',
    use_skill: (s) => trimFirst(s),
    schedule_task: (s) => trimFirst(s),
    cancel_task: () => 'cancelled',
    list_tasks: (s) => `${s.split('\n').filter(Boolean).length} tasks`,
    budget_status: () => 'reported',
    approve_scope: () => 'approved',
    approve_command: () => 'approved',
    cd: () => 'changed',
    list_skills: (s) => `${s.split('\n').filter(Boolean).length} skills`,
    install_skill: (s) => trimFirst(s),
  };

  const hint = RESULT_HINTS[toolName];
  if (hint) return hint(str);
  return trimFirst(str);
}

function trimFirst(s: string): string {
  const first = s.split('\n')[0];
  return first.length > 80 ? first.slice(0, 77) + '…' : first;
}

// ── Narrative formatting ────────────────────────────────────────────

/** A single recorded step for narrative building. */
export interface NarrativeStep {
  /** Raw tool name (e.g. "read_file") */
  tool: string;
  /** Human label produced by formatToolStep */
  label: string;
}

/**
 * Collapse consecutive runs of the same tool into grouped summaries.
 *
 * e.g. 3× read_file → "📄 Read 3 files"
 *      2× edit_file on same file → "✂️ Edited Button.tsx (2 changes)"
 *      2× run_command → kept separate (commands are distinct)
 */
function collapseSteps(steps: NarrativeStep[]): string[] {
  if (steps.length === 0) return [];

  // Tools where consecutive calls should be collapsed
  const COLLAPSIBLE: Record<string, { verb: string; noun: string }> = {
    read_file:   { verb: 'Read', noun: 'file' },
    write_file:  { verb: 'Wrote', noun: 'file' },
    create_file: { verb: 'Created', noun: 'file' },
    edit_file:   { verb: 'Edited', noun: 'file' },
    delete_file: { verb: 'Deleted', noun: 'file' },
    list_dir:    { verb: 'Listed', noun: 'directory' },
    fetch_url:   { verb: 'Fetched', noun: 'URL' },
  };

  const result: string[] = [];
  let i = 0;

  while (i < steps.length) {
    const current = steps[i];
    const collapsible = COLLAPSIBLE[current.tool];

    if (!collapsible) {
      // Non-collapsible: keep as-is
      result.push(current.label);
      i++;
      continue;
    }

    // Count consecutive same-tool calls
    let runEnd = i + 1;
    while (runEnd < steps.length && steps[runEnd].tool === current.tool) {
      runEnd++;
    }
    const runLen = runEnd - i;

    if (runLen === 1) {
      result.push(current.label);
    } else if (runLen <= 3 && current.tool === 'edit_file') {
      // For edits, check if same file — extract filename from label
      const files = new Set(steps.slice(i, runEnd).map(s => {
        const parts = s.label.split(' ');
        return parts[parts.length - 1] || '';
      }));
      if (files.size === 1) {
        const fileName = [...files][0];
        result.push(`✂️ Edited ${fileName} (${runLen} changes)`);
      } else {
        result.push(`✂️ Edited ${runLen} files`);
      }
    } else {
      const icon = TOOL_LABELS[current.tool]?.icon || '•';
      const plural = runLen > 1 ? `${collapsible.noun}s` : collapsible.noun;
      result.push(`${icon} ${collapsible.verb} ${runLen} ${plural}`);
    }

    i = runEnd;
  }

  return result;
}

/**
 * Format a progress narrative from accumulated steps.
 *
 * @param steps       All completed steps so far
 * @param current     Current activity string (or empty)
 * @param maxVisible  Max completed steps to show (rest collapsed as "... and N earlier steps")
 * @returns Formatted multi-line narrative string
 */
export function formatNarrative(
  steps: NarrativeStep[],
  current: string,
  maxVisible: number,
): string {
  const collapsed = collapseSteps(steps);
  const lines: string[] = [];

  const hiddenCount = Math.max(0, collapsed.length - maxVisible);
  const visible = hiddenCount > 0 ? collapsed.slice(hiddenCount) : collapsed;

  if (hiddenCount > 0) {
    lines.push(`  ... and ${hiddenCount} earlier step${hiddenCount === 1 ? '' : 's'}`);
  }

  for (const step of visible) {
    lines.push(`  ✓ ${step}`);
  }

  if (current) {
    lines.push(`  → ${current}`);
  }

  return lines.join('\n');
}