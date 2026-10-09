import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

/**
 * Argv-lane execution: an auto-approved command must run through
 * execFile(absBinary, argv, { env: minimal }) — never spawn(..., {shell}).
 */
vi.mock('node:child_process', () => {
  const fakeChild = (stdoutText: string) => {
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn();
    child.killed = false;
    child.exitCode = null;
    setTimeout(() => {
      child.stdout.write(stdoutText);
      child.exitCode = 0;
      child.emit('exit', 0);
    }, 1);
    return child;
  };
  return {
    execFile: vi.fn(() => fakeChild('argv-output\n')),
    spawn: vi.fn(() => fakeChild('shell-output\n')),
  };
});

import { execFile, spawn } from 'node:child_process';
import { createRunCommandTool } from './run-command.js';
import { setPinnedBinariesForTest, pinnedPath } from './argv-lane.js';
import type { PermissionManager } from '../permissions.js';

const run = (t: any, input: Record<string, unknown>) => (t.execute as any)(input, { toolCallId: 't', messages: [] });

function fakePermissions(result: { allowed: boolean; lane?: 'argv' | 'shell'; reason?: string }) {
  return { checkShellCommand: vi.fn(async () => ({ needsApproval: false, ...result })) } as unknown as PermissionManager & { checkShellCommand: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  vi.mocked(execFile).mockClear();
  vi.mocked(spawn).mockClear();
  setPinnedBinariesForTest({ cat: '/usr/bin/cat', git: '/usr/bin/git', ls: '/bin/ls' });
  process.env.SUPER_SECRET_TOKEN = 'do-not-leak';
});

describe('run_command argv lane', () => {
  it('executes an auto-approved command with execFile, the pinned absolute binary and a minimal env', async () => {
    const permissions = fakePermissions({ allowed: true, lane: 'argv' });
    const tool = createRunCommandTool(permissions, () => '/work', () => {});
    const out = await run(tool, { command: 'cat "my file.txt" other' });

    expect(out).toBe('argv-output');
    expect(spawn).not.toHaveBeenCalled();
    expect(execFile).toHaveBeenCalledTimes(1);
    const [file, args, opts] = vi.mocked(execFile).mock.calls[0] as unknown as [string, string[], any];
    expect(file).toBe('/usr/bin/cat');
    expect(args).toEqual(['my file.txt', 'other']);
    expect(opts.cwd).toBe('/work');
    expect(opts.shell).toBe(false);
    expect(opts.env.PATH).toBe(pinnedPath());
    expect(opts.env.SUPER_SECRET_TOKEN).toBeUndefined();
    expect(permissions.checkShellCommand).toHaveBeenCalledWith('cat "my file.txt" other', { cwd: '/work' });
  });

  it('a user-approved command that the argv lane can express still runs without a shell', async () => {
    const tool = createRunCommandTool(fakePermissions({ allowed: true, lane: 'shell' }), () => '/work', () => {});
    await run(tool, { command: 'git log --oneline' });
    expect(spawn).not.toHaveBeenCalled();
    const [file, args] = vi.mocked(execFile).mock.calls[0] as unknown as [string, string[]];
    expect(file).toBe('/usr/bin/git');
    expect(args.slice(-1)).toEqual(['--oneline']);
    expect(args).toContain('core.fsmonitor=false');
  });

  it('approval-lane commands (pipelines) run the exact approved string through the shell', async () => {
    const tool = createRunCommandTool(fakePermissions({ allowed: true, lane: 'shell' }), () => '/work', () => {});
    const out = await run(tool, { command: 'git log | head -5' });
    expect(out).toBe('shell-output');
    expect(execFile).not.toHaveBeenCalled();
    const [cmd, , opts] = vi.mocked(spawn).mock.calls[0] as unknown as [string, string[], any];
    expect(cmd).toBe('git log | head -5');
    expect(opts.shell).toBe(true);
  });

  it('never falls back to a shell for an argv-lane approval it cannot execute directly', async () => {
    setPinnedBinariesForTest({});
    const tool = createRunCommandTool(fakePermissions({ allowed: true, lane: 'argv' }), () => '/work', () => {});
    const out = await run(tool, { command: 'cat README.md' });
    expect(out).toMatch(/requires approval/);
    expect(spawn).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
  });

  it('cd runs in-process and executes nothing', async () => {
    const setCwd = vi.fn();
    const tool = createRunCommandTool(fakePermissions({ allowed: true, lane: 'argv' }), () => process.cwd(), setCwd);
    const out = await run(tool, { command: 'cd src' });
    expect(out).toMatch(/Changed directory to/);
    expect(setCwd).toHaveBeenCalledOnce();
    expect(spawn).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
  });

  it('denied commands execute nothing', async () => {
    const tool = createRunCommandTool(fakePermissions({ allowed: false, reason: 'User denied: rm -rf x' }), () => '/work', () => {});
    expect(await run(tool, { command: 'rm -rf x' })).toBe('Error: User denied: rm -rf x');
    expect(spawn).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
  });
});
