import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse, relative } from 'node:path';
import { PermissionManager } from '../permissions.js';
import { createRunCommandTool } from './run-command.js';

const quote = (path: string) => JSON.stringify(path.replaceAll('\\', '/'));

describe('session cwd is not a workspace permission grant', () => {
  let root: string;
  let workspace: string;
  let outside: string;
  let nested: string;
  let permissions: PermissionManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mercury-cwd-'));
    workspace = join(root, 'workspace');
    outside = join(root, 'workspace-other');
    nested = join(workspace, 'nested');
    mkdirSync(nested, { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(workspace, 'inside.txt'), 'inside-marker');
    writeFileSync(join(outside, 'outside.txt'), 'outside-marker');
    vi.stubEnv('MERCURY_HOME', join(root, 'mercury'));
    // Capture the manager's startup workspace without changing the worker cwd.
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(workspace);
    try { permissions = new PermissionManager(); } finally { cwd.mockRestore(); }
    permissions.getManifest().capabilities.filesystem.scopes = [];
    permissions.getManifest().capabilities.shell.cwdOnly = true;
    permissions.setFailClosed(true);
    permissions.setCurrentContext('bot', 'cwd-boundary');
    permissions.setBinaryResolver(() => process.execPath);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it.each(['root', 'parent', 'outside'] as const)('a cwd moved to %s does not authorize an outside absolute operand', async (where) => {
    const cwd = where === 'root' ? parse(root).root : where === 'parent' ? root : outside;
    permissions.setBotShellAllowList(['cat *']);
    const command = `cat ${quote(join(outside, 'outside.txt'))}`;
    expect(await permissions.checkShellCommand(command, { cwd })).toMatchObject({ allowed: false });
    expect(permissions.classifyArgvLane(command, cwd).ok).toBe(false);
  });

  it.each(['outside.txt', './outside.txt', '../workspace-other/outside.txt'])('a moved cwd cannot authorize relative operand %s', async (operand) => {
    permissions.setBotShellAllowList(['cat *']);
    expect(await permissions.checkShellCommand(`cat ${operand}`, { cwd: outside })).toMatchObject({ allowed: false });
    expect(permissions.classifyArgvLane(`cat ${operand}`, outside).ok).toBe(false);
  });

  it.skipIf(process.platform !== 'win32')('retains unquoted native Windows absolute paths before bot allowlists', async () => {
    permissions.setBotShellAllowList(['cat *']);
    const operand = `${parse(workspace).root}mercury-outside\\marker.txt`;
    expect(await permissions.checkShellCommand(`cat ${operand}`, { cwd: parse(workspace).root })).toMatchObject({ allowed: false });
  });

  it('resolves parent traversal from a nested cwd without shrinking the fixed workspace', async () => {
    expect(await permissions.checkShellCommand('cat ../inside.txt', { cwd: nested })).toMatchObject({ allowed: true, lane: 'argv' });
    expect(await permissions.checkShellCommand('cat ../../workspace-other/outside.txt', { cwd: nested })).toMatchObject({ allowed: false });
  });

  it('does not treat a sibling sharing the workspace prefix as in bounds', async () => {
    permissions.setBotShellAllowList(['cat *']);
    expect(await permissions.checkShellCommand(`cat ${quote(join(outside, 'outside.txt'))}`, { cwd: workspace })).toMatchObject({ allowed: false });
  });

  it('the argv lane keeps the fixed boundary when cwdOnly is disabled', async () => {
    permissions.getManifest().capabilities.shell.cwdOnly = false;
    expect(await permissions.checkShellCommand('cat outside.txt', { cwd: outside })).toMatchObject({ allowed: false });
    expect(await permissions.checkShellCommand(`cat ${quote(join(workspace, 'inside.txt'))}`, { cwd: outside })).toMatchObject({ allowed: true, lane: 'argv' });
  });

  it('read scopes still authorize the argv lane outside the fixed workspace', async () => {
    permissions.getManifest().capabilities.shell.cwdOnly = false;
    permissions.getManifest().capabilities.filesystem.scopes = [{ path: outside, read: true, write: false }];
    expect(await permissions.checkShellCommand('cat outside.txt', { cwd: outside })).toMatchObject({ allowed: true, lane: 'argv' });
  });

  it.each(['write', 'execute', 'temporary'] as const)('preserves an explicit %s scope beyond the workspace', async (grant) => {
    permissions.setBotShellAllowList(['cat *']);
    if (grant === 'temporary') permissions.addTempScope(outside, true, true);
    else permissions.getManifest().capabilities.filesystem.scopes = [{ path: outside, read: true, write: grant === 'write', execute: grant === 'execute' }];
    expect(await permissions.checkShellCommand('cat outside.txt', { cwd: outside })).toMatchObject({ allowed: true, lane: 'shell' });
  });

  it('a first granted outside operand cannot hide a second ungranted one', async () => {
    permissions.setBotShellAllowList(['cat *']);
    permissions.getManifest().capabilities.filesystem.scopes = [{ path: join(outside, 'outside.txt'), read: true, write: true }];
    writeFileSync(join(outside, 'other.txt'), 'other-marker');
    expect(await permissions.checkShellCommand('cat outside.txt other.txt', { cwd: outside })).toMatchObject({ allowed: false });
  });

  it('canonical argv checks still reject a symlink from the workspace to the moved cwd', () => {
    symlinkSync(outside, join(workspace, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(permissions.classifyArgvLane(`cat ${quote(join(workspace, 'alias', 'outside.txt'))}`, outside).ok).toBe(false);
  });

  it('run_command does not execute an outside read after a session cwd change', async () => {
    permissions.setBotShellAllowList(['cat *', 'findstr *']);
    const tool = createRunCommandTool(permissions, () => parse(root).root, () => {});
    const path = relative(parse(root).root, join(outside, 'outside.txt'));
    const command = process.platform === 'win32' ? `findstr marker ${quote(path)}` : `cat ${quote(path)}`;
    const result = await (tool.execute as (input: unknown, options: unknown) => Promise<string>)({ command }, { toolCallId: 'moved-cwd', messages: [] });
    expect(result).toMatch(/^Error:/);
    expect(result).not.toContain('outside-marker');
  });
});
