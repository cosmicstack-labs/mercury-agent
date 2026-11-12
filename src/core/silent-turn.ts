/**
 * A turn whose model ended on tool calls without writing a word (common in
 * Mercury Code: write the files, run the tests, stop). The owner used to see
 * "(no text response)". Instead they get what was actually done, built from
 * the turn's own tool calls: files written, edited and deleted, commands run
 * and whether they passed — never invented, never empty.
 */
import { basename } from 'node:path';

export interface TurnAction {
  tool: string;
  input: unknown;
  /** The tool reported success. */
  ok: boolean;
}

const MAX_ITEMS = 6;

function arg(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const v = (input as Record<string, unknown>)[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function list(items: string[]): string {
  const unique = [...new Set(items)];
  const shown = unique.slice(0, MAX_ITEMS).map((i) => `\`${i}\``).join(', ');
  return unique.length > MAX_ITEMS ? `${shown} and ${unique.length - MAX_ITEMS} more` : shown;
}

function oneLine(command: string): string {
  const flat = command.replace(/\s+/g, ' ').trim();
  return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat;
}

/** The reply for a turn that produced no text. */
export function summarizeSilentTurn(actions: readonly TurnAction[]): string {
  const created: string[] = [];
  const edited: string[] = [];
  const deleted: string[] = [];
  const commands: Array<{ command: string; ok: boolean }> = [];
  const failedFiles: string[] = [];
  let looked = 0;
  let other = 0;

  for (const a of actions) {
    const path = arg(a.input, 'path') ?? arg(a.input, 'file_path') ?? arg(a.input, 'filePath');
    const name = path ? basename(path) : undefined;
    switch (a.tool) {
      case 'write_file':
      case 'create_file':
        if (!name) { other++; break; }
        if (a.ok) created.push(name); else failedFiles.push(name);
        break;
      case 'edit_file':
        if (!name) { other++; break; }
        if (a.ok) edited.push(name); else failedFiles.push(name);
        break;
      case 'delete_file':
        if (name && a.ok) deleted.push(name); else if (name) failedFiles.push(name);
        break;
      case 'run_command': {
        const command = arg(a.input, 'command');
        if (command) commands.push({ command: oneLine(command), ok: a.ok });
        else other++;
        break;
      }
      case 'read_file':
      case 'list_dir':
      case 'git_status':
      case 'git_diff':
      case 'git_log':
        looked++;
        break;
      default:
        other++;
    }
  }

  const lines: string[] = [];
  // Written then edited in the same turn: say it once, as written.
  const editedOnly = edited.filter((f) => !created.includes(f));
  if (created.length) lines.push(`- Wrote ${list(created)}`);
  if (editedOnly.length) lines.push(`- Edited ${list(editedOnly)}`);
  if (deleted.length) lines.push(`- Deleted ${list(deleted)}`);
  if (commands.length) {
    // The last run of each command is the one that counts.
    const last = new Map<string, boolean>();
    for (const c of commands) { last.delete(c.command); last.set(c.command, c.ok); }
    const runs = [...last.entries()];
    for (const [command, ok] of runs.slice(-MAX_ITEMS)) lines.push(`- Ran \`${command}\` — ${ok ? 'succeeded' : 'failed'}`);
    if (runs.length > MAX_ITEMS) lines.push(`- …and ${runs.length - MAX_ITEMS} more commands`);
  }
  // A file whose later attempt worked isn't a failure.
  const stillFailed = failedFiles.filter((f) => !created.includes(f) && !edited.includes(f) && !deleted.includes(f));
  if (stillFailed.length) lines.push(`- Couldn't change ${list(stillFailed)}`);
  if (lines.length === 0 && looked > 0) lines.push(`- Looked through ${looked} file${looked === 1 ? '' : 's'} and folder${looked === 1 ? '' : 's'}`);
  if (other > 0 && lines.length > 0) lines.push(`- Plus ${other} other step${other === 1 ? '' : 's'}`);

  if (lines.length === 0) {
    return other > 0
      ? `I finished ${other} step${other === 1 ? '' : 's'} but didn't write a summary. Ask me what I did, or say "continue" if there's more to do.`
      : 'I didn\'t get a written answer this time. Send your message again, or say "continue" if I should keep going.';
  }
  const lastRuns = new Map<string, boolean>();
  for (const c of commands) lastRuns.set(c.command, c.ok);
  const anyFailed = [...lastRuns.values()].some((ok) => !ok) || stillFailed.length > 0;
  const head = anyFailed ? 'Here\'s what I did — not everything succeeded:' : 'Done. Here\'s what I did:';
  return `${head}\n${lines.join('\n')}`;
}
