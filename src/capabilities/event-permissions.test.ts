import { afterAll, describe, expect, it, vi } from 'vitest';
import { linkSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const home = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'mercury-event-permissions-'));
  process.env.MERCURY_HOME = root;
  return root;
});
const { PermissionManager } = await import('./permissions.js');
const { makeContext, deriveChildContext, isSubsetContext } = await import('./permission-context.js');
const { WebChannel } = await import('../channels/web.js');
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('event consent stays separate from the destination conversation', () => {
  it.each(['global', 'session'])('requires a fresh web decision despite %s Allow All', async (bypass) => {
    const channel = new WebChannel('Mercury');
    const target = 'event-request';
    const seen: Array<{ type: string; data?: Record<string, unknown> }> = [];
    if (bypass === 'global') channel.setBypassPermissions(true);
    else channel.setSessionPermissionMode('owner-conversation', 'allow-all');
    channel.emitCloudMessage('event', target, 'owner-conversation', 'conversation', undefined, (event) => {
      seen.push(event);
      return true;
    });
    const pm = new PermissionManager();
    pm.onAsk((prompt, options) => channel.askPermission(prompt, pm.getCurrentChannelId(), options));
    const event = makeContext({ channelType: 'web', channelId: target, rememberApprovals: false });
    const request = () => pm.withContext(event, () => pm.approvePluginTool('fixture:write', 'Write event output?'));
    const pendingId = () => seen.filter((item) => item.type === 'permission_request').at(-1)?.data?.id as string;
    for (const answer of ['always', 'no', 'cancel']) {
      const before = seen.filter((item) => item.type === 'permission_request').length;
      const pending = request();
      expect(seen.filter((item) => item.type === 'permission_request')).toHaveLength(before + 1);
      const id = pendingId();
      expect(id).toBeTruthy();
      if (answer === 'cancel') expect(channel.cancelInteraction(id, target)).toBe(true);
      else expect(channel.resolveApproval(id, answer, target)).toBe(true);
      await expect(pending).resolves.toBe(answer === 'always');
    }
    // Event consent neither changes the owner's mode nor feeds owner learning.
    await expect(channel.askPermission('Owner action', target)).resolves.toBe('yes');
    expect(pm.drainAnswers()).toEqual([]);
  });

  it.each(['file', 'shell', 'family', 'plugin', 'mcp', 'hardlink'])('does not inherit or retain %s Always approvals', async (kind) => {
    const pm = new PermissionManager();
    pm.getManifest().capabilities.shell.blocked = [];
    pm.getManifest().capabilities.shell.cwdOnly = false;
    pm.setFamilyApprovalPolicy(() => true);
    const root = join(home, kind);
    mkdirSync(root);
    pm.getManifest().capabilities.filesystem.scopes = [{ path: root, read: true, write: true }];
    if (kind === 'hardlink') {
      for (const id of ['old', 'new']) {
        writeFileSync(join(root, id), 'data');
        linkSync(join(root, id), join(root, `${id}-alias`));
      }
    }
    const owner = makeContext({ channelType: 'web', channelId: 'same-conversation' });
    const event = makeContext({ ...owner, rememberApprovals: false });
    let answer = 'always';
    const ask = vi.fn(async () => answer);
    pm.onAsk(ask);
    const action = async (id: string) => {
      if (kind === 'file' || kind === 'hardlink') return (await pm.checkFsAccess(join(root, id), kind === 'file' ? 'write' : 'read')).allowed;
      if (kind === 'plugin') return pm.approvePluginTool(`plugin:${id}`, 'Run plugin tool?');
      if (kind === 'mcp') return (await pm.checkMcpTool({ serverId: 'fixture', toolName: id, exposedName: id, args: {}, autoApprove: false })).allowed;
      return (await pm.checkShellCommand(kind === 'family' ? `pandoc ${id}.md -o ${id}.html` : `event-fixture-${id}`)).allowed;
    };
    expect(await pm.withContext(owner, () => action('old'))).toBe(true);
    answer = 'no';
    expect(await pm.withContext(owner, () => action('old'))).toBe(true);
    ask.mockClear();
    expect(await pm.withContext(event, () => action('old'))).toBe(false);
    expect(ask).toHaveBeenCalledTimes(1);
    if (kind === 'family') {
      // An earlier pandoc approval covers this family in the owner's chat,
      // but a different argv must still prompt during an event.
      expect(await pm.withContext(event, () => action('new'))).toBe(false);
    }
    answer = 'always';
    ask.mockClear();
    expect(await pm.withContext(event, () => action('new'))).toBe(true);
    expect(await pm.withContext(event, () => action('new'))).toBe(true);
    expect(ask).toHaveBeenCalledTimes(2);
    answer = 'no';
    expect(await pm.withContext(event, () => action('new'))).toBe(false);
    expect(await pm.withContext(owner, () => action('old'))).toBe(true);
    if (kind !== 'family') expect(await pm.withContext(owner, () => action('new'))).toBe(false);
    expect(pm.currentContext().rememberApprovals).toBe(true);
  });

  it('inherits the restriction in delegated work and preserves explicit manifest MCP policy', async () => {
    const event = makeContext({ channelType: 'web', channelId: 'destination', rememberApprovals: false });
    const child = deriveChildContext(event);
    expect(child.channelId).toBe('destination');
    expect(child.rememberApprovals).toBe(false);
    expect(isSubsetContext(child, event)).toBe(true);
    expect(isSubsetContext(makeContext({ ...event, rememberApprovals: true }), event)).toBe(false);
    const pm = new PermissionManager();
    const ask = vi.fn(async () => 'always');
    pm.onAsk(ask);
    expect(await pm.withContext(event, () => pm.checkMcpTool({ serverId: 'fixture', toolName: 'read', exposedName: 'read', args: {}, autoApprove: true }))).toEqual({ allowed: true });
    expect(ask).not.toHaveBeenCalled();
    await pm.withContext(event, () => pm.requestApproval('One external event action'));
    expect(pm.drainAnswers()).toEqual([]);
  });
});
