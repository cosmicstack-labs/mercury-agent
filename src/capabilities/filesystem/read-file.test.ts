import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, linkSync, realpathSync, lstatSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { PermissionManager } from '../permissions.js';
import { createReadFileTool } from './read-file.js';
import { createListDirTool } from './list-dir.js';
import { openVerified } from './verified-read.js';

async function run(toolInstance: any, input: any): Promise<string> {
  return toolInstance.execute(input, { toolCallId: 't', messages: [] });
}

describe('read_file / list_dir read authorisation', () => {
  let root: string;
  let ws: string;
  let outside: string;

  function makePermissions(ask?: (prompt: string) => Promise<string>): PermissionManager {
    const permissions = new PermissionManager();
    const manifest = permissions.getManifest();
    manifest.capabilities.filesystem.enabled = true;
    manifest.capabilities.filesystem.scopes = [{ path: ws, read: true, write: false }];
    permissions.setAutoApproveAll(false);
    permissions.setCurrentContext('web', 'cloud-request-1');
    if (ask) permissions.onAsk(ask);
    return permissions;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mercury-readtool-'));
    ws = join(root, 'ws');
    outside = join(root, 'outside');
    mkdirSync(ws);
    mkdirSync(outside);
    writeFileSync(join(outside, 'id_rsa'), 'PRIVATE KEY');
    writeFileSync(join(ws, 'plain.txt'), 'hello');
    symlinkSync(join(outside, 'id_rsa'), join(ws, 'alias.txt'));
    symlinkSync(outside, join(ws, 'outside-dir'));
    writeFileSync(join(ws, 'linked.txt'), 'linked');
    linkSync(join(ws, 'linked.txt'), join(outside, 'linked-alias.txt'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reads a plain in-scope file', async () => {
    const tool = createReadFileTool(makePermissions(), () => ws);
    await expect(run(tool, { path: 'plain.txt' })).resolves.toBe('hello');
  });

  it('refuses an in-scope symlink to ~/.ssh-style secrets and teaches the approve_scope lesson for the TARGET', async () => {
    const tool = createReadFileTool(makePermissions(), () => ws);
    const out = await run(tool, { path: join(ws, 'alias.txt') });
    const target = realpathSync(join(outside, 'id_rsa'));
    expect(out).not.toContain('PRIVATE KEY');
    expect(out).toMatch(/^Error: Permission denied for read access to /);
    expect(out).toContain(`(it resolves to ${target})`);
    expect(out).toContain(`Use the approve_scope tool with path="${dirname(target)}" and mode="read"`);
  });

  it('keeps the original denial shape for an ordinary out-of-scope read', async () => {
    const tool = createReadFileTool(makePermissions(), () => ws);
    const out = await run(tool, { path: join(outside, 'id_rsa') });
    expect(out).toBe(`Error: Permission denied for read access to ${join(outside, 'id_rsa')}. Use the approve_scope tool with path="${outside}" and mode="read" to request access from the user.`);
  });

  it('refuses a hard-linked file when no approval handler exists', async () => {
    const tool = createReadFileTool(makePermissions(), () => ws);
    const out = await run(tool, { path: 'linked.txt' });
    expect(out).toMatch(/^Error: Permission denied for read access to .*hard links/);
    expect(out).not.toBe('linked');
  });

  it('reads a hard-linked file once the user approves it', async () => {
    const ask = vi.fn().mockResolvedValue('yes');
    const tool = createReadFileTool(makePermissions(ask), () => ws);
    await expect(run(tool, { path: 'linked.txt' })).resolves.toBe('linked');
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('list_dir refuses an in-scope symlink to an outside directory', async () => {
    const tool = createListDirTool(makePermissions(), () => ws);
    const out = await run(tool, { path: 'outside-dir' });
    expect(out).toMatch(/^Error: Permission denied for read access to /);
    expect(out).not.toContain('id_rsa');
  });

  it('list_dir lists a plain in-scope directory', async () => {
    const tool = createListDirTool(makePermissions(), () => ws);
    const out = await run(tool, { path: ws });
    expect(out).toContain('plain.txt');
  });

  it('reports a missing file after the check passes', async () => {
    const tool = createReadFileTool(makePermissions(), () => ws);
    await expect(run(tool, { path: 'missing.txt' })).resolves.toMatch(/^Error: File not found: /);
  });
});

describe('openVerified (TOCTOU guard)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mercury-openverified-'));
    writeFileSync(join(root, 'a.txt'), 'a');
    writeFileSync(join(root, 'b.txt'), 'b');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('opens the file when fstat matches the pre-check identity', () => {
    const st = lstatSync(join(root, 'a.txt'));
    const opened = openVerified(join(root, 'a.txt'), { dev: st.dev, ino: st.ino });
    expect(opened.error).toBeUndefined();
    closeSync(opened.fd!);
  });

  it('refuses when the path now points at a different inode (symlink swapped in after the check)', () => {
    const checked = lstatSync(join(root, 'a.txt'));
    rmSync(join(root, 'a.txt'));
    symlinkSync(join(root, 'b.txt'), join(root, 'a.txt'));
    const opened = openVerified(join(root, 'a.txt'), { dev: checked.dev, ino: checked.ino });
    expect(opened.error).toMatch(/changed between the permission check and the read/);
  });

  it('refuses a swapped-in regular file too (replace, not symlink)', () => {
    const checked = lstatSync(join(root, 'a.txt'));
    rmSync(join(root, 'a.txt'));
    writeFileSync(join(root, 'a.txt'), 'replacement');
    const opened = openVerified(join(root, 'a.txt'), { dev: checked.dev, ino: checked.ino });
    expect(opened.error).toMatch(/changed between the permission check and the read/);
  });
});
