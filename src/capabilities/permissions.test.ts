import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionManager } from './permissions.js';

const mercuryHomes: string[] = [];
const originalMercuryHome = process.env.MERCURY_HOME;

function createPermissionManager(): PermissionManager {
  const mercuryHome = mkdtempSync(join(tmpdir(), 'mercury-permissions-'));
  mercuryHomes.push(mercuryHome);
  process.env.MERCURY_HOME = mercuryHome;
  return new PermissionManager();
}

afterEach(() => {
  for (const mercuryHome of mercuryHomes.splice(0)) {
    rmSync(mercuryHome, { recursive: true, force: true });
  }

  if (originalMercuryHome === undefined) {
    delete process.env.MERCURY_HOME;
  } else {
    process.env.MERCURY_HOME = originalMercuryHome;
  }
});

describe('PermissionManager session isolation', () => {
  it('isolates allow-all mode by channel', () => {
    const permissions = createPermissionManager();

    permissions.setCurrentChannel('telegram:1', 'telegram');
    permissions.setAutoApproveAll(true);

    permissions.setCurrentChannel('telegram:1', 'telegram');
    expect(permissions.isAutoApproveAll()).toBe(true);

    permissions.setCurrentChannel('telegram:2', 'telegram');
    expect(permissions.isAutoApproveAll()).toBe(false);
  });

  it('keeps blocked shell commands blocked even in allow-all mode', async () => {
    const permissions = createPermissionManager();

    permissions.setCurrentChannel('telegram:1', 'telegram');
    permissions.setAutoApproveAll(true);

    await expect(permissions.checkShellCommand('rm -rf /')).resolves.toMatchObject({
      allowed: false,
      needsApproval: false,
      reason: 'Blocked command: matches "rm -rf /"',
    });
  });

  it('keeps cwdOnly protection active even in allow-all mode', async () => {
    const permissions = createPermissionManager();
    const outsidePath = join(tmpdir(), 'outside-scope.txt');

    permissions.setCurrentChannel('telegram:1', 'telegram');
    permissions.setAutoApproveAll(true);

    await expect(permissions.checkShellCommand(`cat ${outsidePath}`)).resolves.toMatchObject({
      allowed: false,
      needsApproval: false,
      reason: `No permission to access ${outsidePath}. Use approve_scope tool with path="${outsidePath}" and mode="write" to request access.`,
    });
  });

  it('isolates pending approvals by channel', async () => {
    const permissions = createPermissionManager();

    permissions.setCurrentChannel('telegram:1', 'telegram');
    permissions.addPendingApproval('git');

    permissions.setCurrentChannel('telegram:1', 'telegram');
    await expect(permissions.checkShellCommand('git push origin main')).resolves.toMatchObject({
      allowed: true,
      needsApproval: false,
    });

    permissions.setCurrentChannel('telegram:2', 'telegram');
    await expect(permissions.checkShellCommand('git push origin main')).resolves.toMatchObject({
      allowed: false,
      needsApproval: true,
    });
  });

  it('isolates temp scopes by channel', async () => {
    const permissions = createPermissionManager();
    const sharedPath = join(tmpdir(), 'isolated-scope', 'note.txt');

    permissions.setCurrentChannel('telegram:1', 'telegram');
    permissions.addTempScope(sharedPath, true, false);

    permissions.setCurrentChannel('telegram:1', 'telegram');
    await expect(permissions.checkFsAccess(sharedPath, 'read')).resolves.toMatchObject({ allowed: true });

    permissions.setCurrentChannel('telegram:2', 'telegram');
    await expect(permissions.checkFsAccess(sharedPath, 'read')).resolves.toMatchObject({ allowed: false });
  });

  it('passes channel context to approval prompts', async () => {
    const permissions = createPermissionManager();
    const askHandler = vi.fn().mockResolvedValue('yes');

    permissions.onAsk(askHandler);
    permissions.setCurrentChannel('telegram:42', 'telegram');

    await permissions.requestScopeExternal('/tmp/shared', 'read');

    expect(askHandler).toHaveBeenCalledWith(
      'Mercury needs read access to:\n/tmp/shared\n\nAllow access?',
      { channelId: 'telegram:42', channelType: 'telegram' },
    );
  });
});
