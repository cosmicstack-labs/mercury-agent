import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, lstatSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PermissionManager } from '../permissions.js';
import { makeContext, deriveChildContext, isSubsetContext } from '../permission-context.js';
import { createRunCommandTool } from '../shell/run-command.js';
import { evaluateArgvPolicy, pinnedBinary } from '../shell/argv-lane.js';
import { createReadFileTool } from './read-file.js';
import { createWriteFileTool } from './write-file.js';
import { createEditFileTool } from './edit-file.js';
import { createCreateFileTool } from './create-file.js';

const run = (tool: { execute?: unknown }, input: Record<string, unknown>): Promise<string> =>
  (tool.execute as (input: unknown, options: unknown) => Promise<string>)(input, { toolCallId: 'boundary', messages: [] });

// Native filesystem operations: Windows uses junctions, which do not need
// symlink privileges. CI's Windows job runs these against NTFS, not win32 mocks.
describe('workspace permission boundary', () => {
  let root: string;
  let ws: string;
  let outside: string;
  let permissions: PermissionManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mercury-boundary-'));
    ws = join(root, 'workspace');
    outside = join(root, 'outside');
    mkdirSync(ws); mkdirSync(outside);
    vi.stubEnv('MERCURY_HOME', join(root, 'mercury'));
    writeFileSync(join(outside, 'marker.txt'), 'outside-marker');
    writeFileSync(join(ws, 'plain.txt'), 'inside-marker');
    symlinkSync(outside, join(ws, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    linkSync(join(outside, 'marker.txt'), join(ws, 'hard.txt'));
    permissions = new PermissionManager();
    permissions.getManifest().capabilities.filesystem.scopes = [{ path: ws, read: true, write: true }];
    permissions.getManifest().capabilities.shell.cwdOnly = false;
    permissions.setFailClosed(true);
    permissions.setCurrentContext('bot', 'boundary');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('native shell execution reads a normal file, and both tools deny outside aliases', async () => {
    const program = process.platform === 'win32' ? 'findstr' : 'cat';
    expect(pinnedBinary(program), `${program} is required on this platform`).toBeTruthy();
    const command = (file: string) => process.platform === 'win32' ? `findstr marker "${file}"` : `cat "${file}"`;
    const shell = createRunCommandTool(permissions, () => ws, () => {});
    const read = createReadFileTool(permissions, () => ws);
    expect(await run(shell, { command: command('plain.txt') })).toBe('inside-marker');
    for (const path of ['alias/marker.txt', './alias/marker.txt', 'hard.txt', join(ws, 'alias', 'marker.txt')]) {
      expect(await run(read, { path })).not.toContain('outside-marker');
      expect(await run(shell, { command: command(path) })).not.toContain('outside-marker');
      expect(await permissions.checkShellCommand(command(path), { cwd: ws })).toMatchObject({ allowed: false });
    }
  });

  it('uses the supplied tool cwd, including a symlinked workspace root', async () => {
    const linkedWs = join(root, 'workspace-link');
    symlinkSync(ws, linkedWs, process.platform === 'win32' ? 'junction' : 'dir');
    permissions.setBinaryResolver(() => process.execPath);
    expect(permissions.classifyArgvLane('cat plain.txt', linkedWs).ok).toBe(true);
    expect(permissions.classifyArgvLane('cat alias/marker.txt', linkedWs).ok).toBe(false);
    expect(permissions.classifyArgvLane('cat ../outside/marker.txt', ws).ok).toBe(false);
    expect(permissions.classifyArgvLane('cd alias', ws).ok).toBe(false);
  });

  it('cwdOnly uses the current tool cwd and retains parent traversal when checking execute grants', async () => {
    permissions.getManifest().capabilities.shell.cwdOnly = true;
    permissions.getManifest().capabilities.filesystem.scopes = [];
    permissions.setBinaryResolver(() => process.execPath);
    // Windows TEMP commonly contains RUNNER~1. Exercise a literal tilde
    // only in this operand, so other boundary checks keep their own causes.
    const path = join(ws, 'plain~1.txt').replaceAll('\\', '/');
    writeFileSync(path, 'inside-marker');
    const operand = JSON.stringify(path);
    const checked = await permissions.checkShellCommand(`cat ${operand}`, { cwd: ws });
    expect(checked, JSON.stringify(checked)).toMatchObject({ allowed: true, lane: 'argv' });
    // An execute grant for cwd must not accidentally cover ../outside.
    permissions.getManifest().capabilities.filesystem.scopes = [{ path: ws, read: true, write: true, execute: true }];
    expect(await permissions.checkShellCommand('node ../outside/program.js', { cwd: ws })).toMatchObject({ allowed: false });
  });

  it('checks attached pattern-file operands and long option values', () => {
    permissions.setBinaryResolver(() => process.execPath);
    for (const command of ['grep -fhard.txt x plain.txt', 'grep -ifhard.txt plain.txt', 'rg -fhard.txt plain.txt', 'grep --file=hard.txt plain.txt']) {
      expect(permissions.classifyArgvLane(command, ws).ok, command).toBe(false);
    }
  });

  it.each(['find -L .', 'find . -follow', 'ls -laL .', 'du -aL .', 'grep -Rn pattern .', 'grep -R1 pattern .', 'grep --dereference-recursiv pattern .', 'grep --dereference-recursive pattern .', 'rg -nL pattern .', 'rg --follow pattern .', 'tree -al .', 'findstr /S pattern plain.txt', 'findstr /F:list.txt pattern', 'findstr pattern "*.txt"'])('requires explicit approval for %s', (command) => {
    expect(evaluateArgvPolicy(command).ok).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('native grep follow variants cannot traverse a junction without approval', async () => {
    const grep = pinnedBinary('grep');
    expect(grep).toBeTruthy();
    const tool = createRunCommandTool(permissions, () => ws, () => {});
    for (const command of ['grep -R1 marker .', 'grep --dereference-recursiv marker .']) {
      expect(await run(tool, { command })).not.toContain('outside-marker');
      expect(await permissions.checkShellCommand(command, { cwd: ws })).toMatchObject({ allowed: false });
    }
  });

  it('an explicit owner approval still permits a shell read of an outside alias', async () => {
    permissions.setFailClosed(false);
    permissions.setCurrentContext('web', 'owner');
    const ask = vi.fn().mockResolvedValue('yes');
    permissions.onAsk(ask);
    const command = process.platform === 'win32' ? 'findstr marker hard.txt' : 'cat hard.txt';
    expect(await run(createRunCommandTool(permissions, () => ws, () => {}), { command })).toBe('outside-marker');
    expect(ask).toHaveBeenCalledWith(`Run command: ${command}`);
  });

  it('credential aliases remain denied even when an owner would approve', async () => {
    const home = process.env.MERCURY_HOME!;
    writeFileSync(join(home, 'devices.json'), 'synthetic-login-marker');
    symlinkSync(home, join(ws, 'credentials'), process.platform === 'win32' ? 'junction' : 'dir');
    permissions.setFailClosed(false);
    const ask = vi.fn().mockResolvedValue('yes'); permissions.onAsk(ask);
    permissions.setBinaryResolver(() => process.execPath);
    expect(await permissions.checkShellCommand('cat credentials/devices.json', { cwd: ws })).toMatchObject({ allowed: false });
    expect(ask).not.toHaveBeenCalled();
  });

  it.each(['write', 'edit'] as const)('denies %s through a hardlink without changing its outside alias', async (mode) => {
    const tool = mode === 'write' ? createWriteFileTool(permissions, () => ws) : createEditFileTool(permissions, () => ws);
    const result = await run(tool, { path: 'hard.txt', content: 'overwritten', old_string: 'outside', new_string: 'overwritten' });
    expect(result).toContain('hard links');
    expect(readFileSync(join(outside, 'marker.txt'), 'utf8')).toBe('outside-marker');
  });

  it.each(['write', 'edit'] as const)('%s verifies identity after a file is replaced during approval', async (mode) => {
    permissions.setFailClosed(false);
    permissions.setCurrentContext('web', 'owner');
    permissions.onAsk(async () => {
      unlinkSync(join(ws, 'plain.txt'));
      linkSync(join(outside, 'marker.txt'), join(ws, 'plain.txt'));
      return 'yes';
    });
    const tool = mode === 'write' ? createWriteFileTool(permissions, () => ws) : createEditFileTool(permissions, () => ws);
    expect(await run(tool, { path: 'plain.txt', content: 'overwritten', old_string: 'outside', new_string: 'overwritten' })).toContain('changed between');
    expect(readFileSync(join(outside, 'marker.txt'), 'utf8')).toBe('outside-marker');
  });

  it('refuses a new hardlink created while approval was pending, even with the same inode', async () => {
    permissions.setFailClosed(false); permissions.setCurrentContext('web', 'owner');
    permissions.onAsk(async () => { linkSync(join(ws, 'plain.txt'), join(outside, 'new-alias.txt')); return 'yes'; });
    expect(await run(createWriteFileTool(permissions, () => ws), { path: 'plain.txt', content: 'overwritten' })).toContain('changed between');
    expect(readFileSync(join(outside, 'new-alias.txt'), 'utf8')).toBe('inside-marker');
  });

  it('writes the approved canonical file when a parent junction is redirected during approval', async () => {
    const inside = join(ws, 'inside'); mkdirSync(inside); writeFileSync(join(inside, 'marker.txt'), 'inside-marker');
    const alias = join(ws, 'inside-link'); symlinkSync(inside, alias, process.platform === 'win32' ? 'junction' : 'dir');
    permissions.setFailClosed(false); permissions.setCurrentContext('web', 'owner');
    permissions.onAsk(async () => { rmSync(alias); symlinkSync(outside, alias, process.platform === 'win32' ? 'junction' : 'dir'); return 'yes'; });
    expect(await run(createWriteFileTool(permissions, () => ws), { path: 'inside-link/marker.txt', content: 'updated' })).toContain('Successfully');
    expect(readFileSync(join(inside, 'marker.txt'), 'utf8')).toBe('updated');
    expect(readFileSync(join(outside, 'marker.txt'), 'utf8')).toBe('outside-marker');
  });

  it('edits a verified descriptor from position zero and truncates a shorter replacement', async () => {
    expect(await run(createEditFileTool(permissions, () => ws), { path: 'plain.txt', old_string: 'inside-marker', new_string: '☿' })).toContain('Edited');
    expect(readFileSync(join(ws, 'plain.txt'), 'utf8')).toBe('☿');
  });

  it('hardlink write approval names the alias risk and does not reuse read approval', async () => {
    permissions.setFailClosed(false); permissions.setCurrentContext('web', 'owner');
    const ask = vi.fn().mockResolvedValue('always'); permissions.onAsk(ask);
    await run(createReadFileTool(permissions, () => ws), { path: 'hard.txt' });
    expect(await run(createWriteFileTool(permissions, () => ws), { path: 'hard.txt', content: 'approved' })).toContain('Successfully');
    expect(ask.mock.calls.some(([prompt]) => prompt.includes('Write hard-linked file:') && prompt.includes('outside the approved scopes'))).toBe(true);
    expect(readFileSync(join(outside, 'marker.txt'), 'utf8')).toBe('approved');
  });

  it('hardlink write Always approval does not cross channels with the same source ID', async () => {
    permissions.setFailClosed(false); permissions.setCurrentContext('cli', 'shared-id');
    permissions.onAsk(async () => 'always');
    const tool = createWriteFileTool(permissions, () => ws);
    expect(await run(tool, { path: 'hard.txt', content: 'cli-approved' })).toContain('Successfully');
    permissions.setCurrentContext('web', 'shared-id');
    const ask = vi.fn().mockResolvedValue('no'); permissions.onAsk(ask);
    expect(await run(tool, { path: 'hard.txt', content: 'web-overwrite' })).toContain('hard links');
    expect(ask).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(outside, 'marker.txt'), 'utf8')).toBe('cli-approved');
  });

  it('fresh approval contexts neither reuse nor retain hardlink write Always grants', async () => {
    permissions.setFailClosed(false);
    const owner = makeContext({ channelType: 'web', channelId: 'shared-owner' });
    const fresh = makeContext({ ...owner, rememberApprovals: false });
    const child = deriveChildContext(fresh);
    expect(owner.rememberApprovals).toBe(true);
    expect(child.rememberApprovals).toBe(false);
    expect(isSubsetContext(child, fresh)).toBe(true);
    expect(isSubsetContext(owner, fresh)).toBe(false);
    const ask = vi.fn().mockResolvedValue('always');
    permissions.onAsk(ask);
    const tool = createWriteFileTool(permissions, () => ws);
    const write = (context: typeof owner, path: string, content: string) => permissions.withContext(context, () => run(tool, { path, content }));
    expect(await write(owner, 'hard.txt', 'owner-approved')).toContain('Successfully');
    ask.mockResolvedValue('no');
    expect(await write(owner, 'hard.txt', 'remembered-owner')).toContain('Successfully');
    ask.mockClear();
    expect(await write(fresh, 'hard.txt', 'must-not-write')).toContain('hard links');
    expect(ask).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(outside, 'marker.txt'), 'utf8')).toBe('remembered-owner');

    writeFileSync(join(outside, 'second.txt'), 'second-original');
    linkSync(join(outside, 'second.txt'), join(ws, 'second-hard.txt'));
    ask.mockResolvedValue('always');
    expect(await write(child, 'second-hard.txt', 'one-time-write')).toContain('Successfully');
    ask.mockResolvedValue('no');
    expect(await write(child, 'second-hard.txt', 'must-not-write')).toContain('hard links');
    expect(await write(owner, 'second-hard.txt', 'must-not-leak-grant')).toContain('hard links');
    expect(readFileSync(join(outside, 'second.txt'), 'utf8')).toBe('one-time-write');
    expect(await write(owner, 'hard.txt', 'owner-still-approved')).toContain('Successfully');
  });

  it('refuses a canonical parent replaced by an outside junction during creation approval', async () => {
    const parent = join(ws, 'parent'); mkdirSync(parent);
    permissions.setFailClosed(false); permissions.setCurrentContext('web', 'owner');
    permissions.onAsk(async () => {
      renameSync(parent, join(ws, 'original-parent'));
      symlinkSync(outside, parent, process.platform === 'win32' ? 'junction' : 'dir');
      return 'yes';
    });
    expect(await run(createCreateFileTool(permissions, () => ws), { path: 'parent/nested/new.txt', content: 'overwritten' })).toContain('parent changed');
    expect(() => lstatSync(join(outside, 'nested'))).toThrow();
  });

  it('refuses an outside junction inserted into a previously missing parent during approval', async () => {
    permissions.setFailClosed(false); permissions.setCurrentContext('web', 'owner');
    permissions.onAsk(async () => {
      symlinkSync(outside, join(ws, 'new-parent'), process.platform === 'win32' ? 'junction' : 'dir');
      return 'yes';
    });
    expect(await run(createCreateFileTool(permissions, () => ws), { path: 'new-parent/nested/new.txt', content: 'overwritten' })).toContain('parent changed');
    expect(() => lstatSync(join(outside, 'nested'))).toThrow();
  });

  it('creates ordinary missing parents after approval', async () => {
    expect(await run(createCreateFileTool(permissions, () => ws), { path: 'new-parent/nested/new.txt', content: 'safe' })).toContain('Successfully');
    expect(readFileSync(join(ws, 'new-parent/nested/new.txt'), 'utf8')).toBe('safe');
  });

  it.skipIf(process.platform === 'win32')('a FIFO replacement is refused without blocking open in a real child process', () => {
    const target = join(ws, 'plain.txt');
    const stat = lstatSync(target);
    unlinkSync(target);
    execFileSync('mkfifo', [target]);
    const helper = new URL('./verified-write.ts', import.meta.url).href;
    const source = `import { openVerifiedWrite } from ${JSON.stringify(helper)};
      const result = openVerifiedWrite(${JSON.stringify({ canonical: target, allowed: true, fileId: { dev: stat.dev, ino: stat.ino }, fileNlink: stat.nlink })}, ${JSON.stringify(target)});
      if (!result.error) process.exit(2);
      process.stdout.write(result.error);`;
    const result = execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '--eval', source], { timeout: 2000, encoding: 'utf8' });
    expect(result).toContain('Error');
  });

  it('exclusive create refuses a hardlink planted while approval is pending', async () => {
    permissions.setFailClosed(false); permissions.setCurrentContext('web', 'owner');
    permissions.onAsk(async () => { linkSync(join(outside, 'marker.txt'), join(ws, 'new.txt')); return 'yes'; });
    expect(await run(createCreateFileTool(permissions, () => ws), { path: 'new.txt', content: 'overwritten' })).toContain('Error:');
    expect(readFileSync(join(outside, 'marker.txt'), 'utf8')).toBe('outside-marker');
  });
});
