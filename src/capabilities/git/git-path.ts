import { resolve, isAbsolute } from 'node:path';
import type { PermissionManager } from '../permissions.js';
import { readDenialMessage } from '../filesystem/verified-read.js';
import { pinnedBinary, pinnedSearchDirs, minimalEnv } from '../shell/argv-lane.js';

/**
 * Resolve a model-chosen path against the tool cwd and run it through the
 * same filesystem read check `read_file` / `list_dir` use, so a git helper
 * can never inspect a tree the user has not approved for reading.
 *
 * Returns the resolved path on success, or the same denial message
 * `read_file` returns so the model learns to call `approve_scope`.
 */
export async function checkGitReadPath(
  permissions: PermissionManager,
  getCwd: () => string,
  path: string,
): Promise<{ resolved: string; error?: undefined } | { resolved: string; error: string }> {
  const resolved = isAbsolute(path) ? resolve(path) : resolve(getCwd(), path);
  const check = await permissions.checkFsAccess(resolved, 'read');
  if (!check.allowed) {
    return { resolved, error: readDenialMessage(resolved, check) };
  }
  // Hand back the canonical directory so git runs where the check looked.
  return { resolved: check.canonical ?? resolved };
}

/**
 * Git positional arguments must never be allowed to masquerade as options
 * (`--receive-pack=…`, `--upload-pack=…`, `--exec=…` run arbitrary programs).
 */
export function looksLikeGitOption(value: string): boolean {
  return value.startsWith('-');
}

/**
 * Invocation for the auto-approved git read helpers (git_status, git_log,
 * git_diff): the git binary from the pinned system PATH (never
 * `process.env.PATH`, #103), a minimal environment, and config overrides so
 * a repository's own `.git/config` cannot make a read run a program
 * (fsmonitor hook, pager, external diff, textconv filter).
 */
export function gitReadInvocation(args: string[]): { file: string; args: string[]; env: NodeJS.ProcessEnv } | { error: string } {
  const file = pinnedBinary('git');
  if (!file) {
    return { error: `Error: git was not found in the pinned system PATH (${pinnedSearchDirs().join(', ')}). Use run_command to run git with approval.` };
  }
  const [sub, ...rest] = args;
  const body = sub === 'diff' || sub === 'log' ? [sub, '--no-ext-diff', '--no-textconv', ...rest] : args;
  return { file, args: [...GIT_READ_HARDENING, ...body], env: minimalEnv() };
}

export const GIT_READ_HARDENING: readonly string[] = ['-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '--no-pager'];
