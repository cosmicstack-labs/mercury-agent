import { describe, expect, it, vi, beforeEach } from 'vitest';
import { resolve } from 'node:path';

// Regression tests for ROADMAP P0.4: the git helpers used to build a shell
// string from a model-chosen path and run it through execSync with no
// permission check. They must now (a) hand the path to git as one argv
// element via execFileSync and (b) refuse out-of-scope paths before exec.

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(() => ''),
  execSync: vi.fn(() => { throw new Error('execSync must not be used by git helpers'); }),
}));

import { execFileSync, execSync } from 'node:child_process';
import { createGitStatusTool } from './git-status.js';
import { createGitLogTool } from './git-log.js';
import { createGitDiffTool } from './git-diff.js';
import { createGitPushTool } from './git-push.js';
import type { PermissionManager } from '../permissions.js';

const CWD = '/repo';
const INJECTED = '/tmp/x"; echo pwned; "';

function fakePermissions(opts: { readAllowed: boolean; shellAllowed?: boolean }) {
  return {
    checkFsAccess: vi.fn(async () => ({ allowed: opts.readAllowed, reason: opts.readAllowed ? undefined : 'out of scope' })),
    checkShellCommand: vi.fn(async () => ({ allowed: opts.shellAllowed ?? true, needsApproval: false })),
  } as unknown as PermissionManager & { checkFsAccess: ReturnType<typeof vi.fn>; checkShellCommand: ReturnType<typeof vi.fn> };
}

const run = (t: any, input: Record<string, unknown>) => (t.execute as any)(input, { toolCallId: 't', messages: [] });

beforeEach(() => {
  vi.mocked(execFileSync).mockClear();
  vi.mocked(execFileSync).mockImplementation(() => '' as any);
  vi.mocked(execSync).mockClear();
});

describe('git helpers pass the path as a single argv element (no shell)', () => {
  it('git_status: -C <path> is one argv element', async () => {
    const permissions = fakePermissions({ readAllowed: true });
    await run(createGitStatusTool(permissions, () => CWD), { path: INJECTED });

    expect(execSync).not.toHaveBeenCalled();
    expect(execFileSync).toHaveBeenCalledTimes(1);
    const [file, args, opts] = vi.mocked(execFileSync).mock.calls[0] as unknown as [string, string[], any];
    expect(file).toBe('git');
    expect(args).toEqual(['-C', resolve(INJECTED), 'status', '--porcelain']);
    expect(opts.cwd).toBe(CWD);
    expect(opts.shell).toBeUndefined();
  });

  it('git_log: path follows `--` as one argv element', async () => {
    const permissions = fakePermissions({ readAllowed: true });
    await run(createGitLogTool(permissions, () => CWD), { path: INJECTED, count: 5 });

    expect(execSync).not.toHaveBeenCalled();
    const [file, args] = vi.mocked(execFileSync).mock.calls[0] as unknown as [string, string[]];
    expect(file).toBe('git');
    expect(args).toEqual(['log', '--oneline', '--decorate', '-5', '--', INJECTED]);
  });

  it('git_diff: path follows `--` as one argv element', async () => {
    const permissions = fakePermissions({ readAllowed: true });
    await run(createGitDiffTool(permissions, () => CWD), { path: INJECTED, staged: true });

    expect(execSync).not.toHaveBeenCalled();
    const [file, args] = vi.mocked(execFileSync).mock.calls[0] as unknown as [string, string[]];
    expect(file).toBe('git');
    expect(args).toEqual(['diff', '--cached', '--', INJECTED]);
  });

  it('git_push: remote and branch are argv elements, and options are refused', async () => {
    const permissions = fakePermissions({ readAllowed: true, shellAllowed: true });
    const push = createGitPushTool(permissions, () => CWD);

    await run(push, { remote: 'origin; echo pwned', branch: 'main' });
    expect(execSync).not.toHaveBeenCalled();
    const [file, args] = vi.mocked(execFileSync).mock.calls[0] as unknown as [string, string[]];
    expect(file).toBe('git');
    expect(args).toEqual(['push', 'origin; echo pwned', 'main']);

    vi.mocked(execFileSync).mockClear();
    const result = await run(push, { remote: '--receive-pack=echo pwned', branch: 'main' });
    expect(result).toMatch(/must be names/);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('git_status without a path runs plain `git status --porcelain` and skips the scope check', async () => {
    const permissions = fakePermissions({ readAllowed: false });
    await run(createGitStatusTool(permissions, () => CWD), {});
    expect(permissions.checkFsAccess).not.toHaveBeenCalled();
    const [, args] = vi.mocked(execFileSync).mock.calls[0] as unknown as [string, string[]];
    expect(args).toEqual(['status', '--porcelain']);
  });
});

describe('git helpers reject out-of-scope paths before any exec', () => {
  const OUTSIDE = '/etc/secret';
  // The tools resolve the path first, so on Windows this becomes D:\etc\secret.
  const OUTSIDE_RESOLVED = resolve(OUTSIDE);
  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const DENIED = new RegExp(`^Error: Permission denied for read access to ${escapeRe(OUTSIDE_RESOLVED)}\\. Use the approve_scope tool`);

  it.each([
    ['git_status', (p: PermissionManager) => createGitStatusTool(p, () => CWD), { path: OUTSIDE }],
    ['git_log', (p: PermissionManager) => createGitLogTool(p, () => CWD), { path: OUTSIDE }],
    ['git_diff', (p: PermissionManager) => createGitDiffTool(p, () => CWD), { path: OUTSIDE }],
  ])('%s denies with the read_file-style message and never execs', async (_name, make, input) => {
    const permissions = fakePermissions({ readAllowed: false });
    const result = await run(make(permissions), input);

    expect(result).toMatch(DENIED);
    expect(permissions.checkFsAccess).toHaveBeenCalledWith(OUTSIDE_RESOLVED, 'read');
    expect(execFileSync).not.toHaveBeenCalled();
    expect(execSync).not.toHaveBeenCalled();
  });

  it('resolves relative paths against the tool cwd before checking scope', async () => {
    const permissions = fakePermissions({ readAllowed: false });
    await run(createGitLogTool(permissions, () => CWD), { path: '../outside' });
    expect(permissions.checkFsAccess).toHaveBeenCalledWith(resolve(CWD, '../outside'), 'read');
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('git_push denies before exec when the shell permission check fails', async () => {
    const permissions = fakePermissions({ readAllowed: true, shellAllowed: false });
    const result = await run(createGitPushTool(permissions, () => CWD), {});
    expect(result).toMatch(/^Error:/);
    expect(permissions.checkShellCommand).toHaveBeenCalledWith('git push origin');
    expect(execFileSync).not.toHaveBeenCalled();
  });
});

describe('output format is unchanged', () => {
  it('git_status reports a clean tree, git_log/git_diff report empty results', async () => {
    const permissions = fakePermissions({ readAllowed: true });
    expect(await run(createGitStatusTool(permissions, () => CWD), {})).toBe('Working tree clean — no changes.');
    expect(await run(createGitLogTool(permissions, () => CWD), {})).toBe('No commits found.');
    expect(await run(createGitDiffTool(permissions, () => CWD), {})).toBe('No differences found.');

    // The pre-existing behaviour trims the whole result (including the
    // leading porcelain status column); keep it byte-for-byte identical.
    vi.mocked(execFileSync).mockImplementation(() => ' M src/a.ts\n?? new.ts\n' as any);
    expect(await run(createGitStatusTool(permissions, () => CWD), {})).toBe('M src/a.ts\n?? new.ts');
  });

  it('surfaces git stderr as an Error line', async () => {
    const permissions = fakePermissions({ readAllowed: true });
    vi.mocked(execFileSync).mockImplementation(() => { throw Object.assign(new Error('boom'), { stderr: 'fatal: not a git repository\n' }); });
    expect(await run(createGitDiffTool(permissions, () => CWD), {})).toBe('Error: fatal: not a git repository');
  });
});
