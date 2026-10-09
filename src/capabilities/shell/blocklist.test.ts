import { describe, expect, it } from 'vitest';
import { BLOCKED_COMMANDS, NEEDS_APPROVAL_COMMANDS } from './blocklist.js';
import { PermissionManager, globToRegExp } from '../permissions.js';

const matches = (command: string, pattern: string) => globToRegExp(pattern).test(command);
const blocked = (cmd: string) => BLOCKED_COMMANDS.some((p) => matches(cmd, p));
const needsApproval = (cmd: string) => NEEDS_APPROVAL_COMMANDS.some((p) => matches(cmd, p));

describe('shell blocklist — Windows / PowerShell gaps', () => {
  it('blocks Set-ExecutionPolicy bare and wrapped in powershell/pwsh', () => {
    expect(blocked('Set-ExecutionPolicy Unrestricted')).toBe(true);
    expect(blocked('set-executionpolicy -Scope CurrentUser Bypass')).toBe(true);
    expect(blocked('powershell -Command Set-ExecutionPolicy Bypass')).toBe(true);
    expect(blocked('powershell.exe -NoProfile -c "Set-ExecutionPolicy Unrestricted -Force"')).toBe(true);
    expect(blocked('pwsh -c Set-ExecutionPolicy RemoteSigned')).toBe(true);
    expect(blocked('Get-ExecutionPolicy')).toBe(false);
  });

  it('blocks PowerShell recursive deletes of a drive root or home in either argument order', () => {
    for (const cmd of [
      'Remove-Item -Recurse -Force C:\\',
      'Remove-Item -Recurse -Force C:\\*',
      'Remove-Item -Recurse -Force -Path C:\\',
      'Remove-Item C:\\ -Recurse',
      'Remove-Item C:\\* -Force -Recurse',
      'Remove-Item -Path C:\\ -Recurse -Force',
      'remove-item -r D:\\',
      'rm -r ~',
      'rm -rf ~\\*',
      'rm -Recurse -Force ~/*',
      'ri -r C:\\',
      'rmdir -Recurse C:\\',
      'rd -r ~',
      'del -Recurse -Force /',
      'erase -r /*',
    ]) {
      expect(blocked(cmd), cmd).toBe(true);
    }
  });

  it('does not block relative-path recursive deletes inside a project (those need approval instead)', () => {
    for (const cmd of [
      'Remove-Item -Recurse -Force node_modules',
      'rm -r build',
      'rm -rf ./node_modules',
      'Remove-Item .\\tmp -Recurse',
      'Remove-Item -Path .\\dist -Recurse -Force',
    ]) {
      expect(blocked(cmd), cmd).toBe(false);
      expect(needsApproval(cmd), cmd).toBe(true);
    }
    // Absolute-path recursive deletes are blocked, mirroring the existing
    // `rm -rf /*` and `del /s /q C:\*` policy on the other shells.
    expect(blocked('Remove-Item -Recurse -Force C:\\Users\\jane\\proj\\dist')).toBe(true);
    expect(blocked('rm -rf /home/jane/proj/dist')).toBe(true);
    expect(blocked('rd /s /q C:\\Users\\jane\\proj\\dist')).toBe(true);
  });

  it('routes pwsh like powershell — approval, never auto-approve', () => {
    expect(needsApproval('pwsh -c Get-ChildItem')).toBe(true);
    expect(needsApproval('powershell -c Get-ChildItem')).toBe(true);
    expect(blocked('pwsh -c Get-ChildItem')).toBe(false);
  });

  it('keeps the POSIX root/home forms and the cmd.exe `rd /s /q C:\\` gap closed', () => {
    for (const cmd of ['rm -rf /', 'rm -fr ~', 'rm -rf /*', 'rd /s /q C:\\', 'rd /s /q C:\\*']) {
      expect(blocked(cmd), cmd).toBe(true);
    }
  });

  it('is what the default permission manifest enforces (not a parallel copy)', async () => {
    const pm = new PermissionManager();
    const manifestBlocked = pm.getManifest().capabilities.shell.blocked;
    for (const pattern of BLOCKED_COMMANDS) expect(manifestBlocked).toContain(pattern);
    await expect(pm.checkShellCommand('Set-ExecutionPolicy Unrestricted')).resolves.toMatchObject({ allowed: false });
    await expect(pm.checkShellCommand('Remove-Item -Recurse -Force C:\\')).resolves.toMatchObject({ allowed: false });
  });
});
