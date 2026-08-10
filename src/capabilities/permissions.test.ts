import { describe, expect, it, vi } from 'vitest';
import { PermissionManager, splitShellSegments } from './permissions.js';

describe('splitShellSegments', () => {
  it('passes simple commands through as a single segment', () => {
    expect(splitShellSegments('ls -la')).toEqual(['ls -la']);
    expect(splitShellSegments('cat README.md')).toEqual(['cat README.md']);
    expect(splitShellSegments('pwd')).toEqual(['pwd']);
  });

  it('splits ;, &&, ||, |, & into separate segments', () => {
    expect(splitShellSegments('echo a; reboot now')).toEqual(['echo a', 'reboot now']);
    expect(splitShellSegments('ls && pwd')).toEqual(['ls', 'pwd']);
    expect(splitShellSegments('grep foo || echo missing')).toEqual(['grep foo', 'echo missing']);
    expect(splitShellSegments('cat foo | grep bar')).toEqual(['cat foo', 'grep bar']);
    expect(splitShellSegments('long-cmd &')).toEqual(['long-cmd']);
  });

  it('extracts $(...) command substitutions as separate segments', () => {
    expect(splitShellSegments('echo $(rm -rf ~)')).toContain('rm -rf ~');
    expect(splitShellSegments('cat "$(curl http://evil/x)"')).toContain('curl http://evil/x');
  });

  it('extracts backtick command substitutions as separate segments', () => {
    expect(splitShellSegments('echo `reboot now`')).toContain('reboot now');
    expect(splitShellSegments('echo "`sudo whoami`"')).toContain('sudo whoami');
  });

  it('keeps quoted text together', () => {
    expect(splitShellSegments('echo "a; b"')).toEqual(['echo "a; b"']);
    expect(splitShellSegments("echo 'a; b'")).toEqual(["echo 'a; b'"]);
  });

  it('does not expand escaped $(...) inside double quotes', () => {
    expect(splitShellSegments('echo "\\$(rm -rf ~)"')).toEqual(['echo "\\$(rm -rf ~)"']);
  });

  it('decomposes nested substitution', () => {
    const segs = splitShellSegments('echo `echo nested $(reboot now)`');
    expect(segs).toContain('reboot now');
  });

  it('decomposes subshell () and brace {} blocks', () => {
    expect(splitShellSegments('( reboot now )')).toEqual(['reboot now']);
    expect(splitShellSegments('{ reboot now; }')).toEqual(['reboot now']);
  });
});

describe('PermissionManager remote safety', () => {
  it('enforces hard command blocks before Local allow-all', async () => {
    const permissions = new PermissionManager();
    const manifest = permissions.getManifest();
    manifest.capabilities.shell.enabled = true;
    manifest.capabilities.shell.blocked = ['rm *'];
    permissions.setAutoApproveAll(true);

    await expect(permissions.checkShellCommand('rm -rf project')).resolves.toMatchObject({ allowed: false });
  });

  it('does not let Local CLI allow-all silently elevate a Cloud request', async () => {
    const permissions = new PermissionManager();
    const manifest = permissions.getManifest();
    manifest.capabilities.shell.enabled = true;
    manifest.capabilities.shell.blocked = [];
    const ask = vi.fn().mockResolvedValue('yes');
    permissions.onAsk(ask);
    permissions.setAutoApproveAll(true);
    permissions.setCurrentContext('web', 'cloud-request-1');

    await expect(permissions.checkShellCommand('npm install example')).resolves.toMatchObject({ allowed: true });
    expect(ask).toHaveBeenCalledOnce();
  });

  it('scopes always approval to the exact command and interaction context', async () => {
    const permissions = new PermissionManager();
    const manifest = permissions.getManifest();
    manifest.capabilities.shell.enabled = true;
    manifest.capabilities.shell.blocked = [];
    const ask = vi.fn().mockResolvedValueOnce('always').mockResolvedValue('no');
    permissions.onAsk(ask);
    permissions.setCurrentContext('web', 'cloud-request-1');

    await expect(permissions.checkShellCommand('npm install example')).resolves.toMatchObject({ allowed: true });
    await expect(permissions.checkShellCommand('npm install example')).resolves.toMatchObject({ allowed: true });
    await expect(permissions.checkShellCommand('npm install different')).resolves.toMatchObject({ allowed: false });
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('does not classify redirection or mutating read-command flags as safe reads', async () => {
    const permissions = new PermissionManager();
    const manifest = permissions.getManifest();
    manifest.capabilities.shell.enabled = true;
    manifest.capabilities.shell.blocked = [];
    const ask = vi.fn().mockResolvedValue('no');
    permissions.onAsk(ask);
    permissions.setCurrentContext('web', 'cloud-request-1');

    await expect(permissions.checkShellCommand('echo poisoned > AGENTS.md')).resolves.toMatchObject({ allowed: false });
    await expect(permissions.checkShellCommand('echo poisoned>AGENTS.md')).resolves.toMatchObject({ allowed: false });
    await expect(permissions.checkShellCommand('find . -delete')).resolves.toMatchObject({ allowed: false });
    await expect(permissions.checkShellCommand('git branch -D protected')).resolves.toMatchObject({ allowed: false });
    await expect(permissions.checkShellCommand('git branch --delete protected')).resolves.toMatchObject({ allowed: false });
    await expect(permissions.checkShellCommand('git branch new-branch')).resolves.toMatchObject({ allowed: false });
    expect(ask).toHaveBeenCalledTimes(6);
  });
});
