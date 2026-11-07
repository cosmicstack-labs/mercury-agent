import { afterAll, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tool, zodSchema, type Tool } from 'ai';
import { z } from 'zod';

const home = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  const dir = mkdtempSync(joinPath(tmpdir(), 'mercury-mcp-gate-'));
  process.env.MERCURY_HOME = dir;
  return dir;
});

const { PermissionManager, formatMcpArgs } = await import('../permissions.js');
const { CapabilityRegistry } = await import('../registry.js');
const { filterBotTools } = await import('../../bots/registry-factory.js');
const { formatToolStep } = await import('../../utils/tool-label.js');
const { registerSecretValue } = await import('../../utils/redact.js');
type McpManager = import('./manager.js').McpManager;

afterAll(() => rmSync(home, { recursive: true, force: true }));

const request = (extra: Partial<Parameters<InstanceType<typeof PermissionManager>['checkMcpTool']>[0]> = {}) => ({
  serverId: 'fx',
  toolName: 'echo',
  exposedName: 'mcp__fx__echo',
  args: { text: 'hi' },
  autoApprove: false,
  ...extra,
});

function manager(answer: string = 'no') {
  const pm = new PermissionManager();
  const ask = vi.fn().mockResolvedValue(answer);
  pm.onAsk(ask);
  pm.setCurrentContext('cli', 'cli-1');
  return { pm, ask };
}

describe('PermissionManager.checkMcpTool', () => {
  it('runs auto-approved tools without asking, even unattended', async () => {
    const { pm, ask } = manager();
    pm.setCurrentContext('internal', 'scheduler');
    expect(await pm.checkMcpTool(request({ autoApprove: true }))).toEqual({ allowed: true });
    expect(ask).not.toHaveBeenCalled();
  });

  it('shows server, tool and arguments, and honours yes and no', async () => {
    const yes = manager('yes');
    expect(await yes.pm.checkMcpTool(request())).toEqual({ allowed: true });
    expect(yes.ask).toHaveBeenCalledWith('MCP tool call\nServer: fx\nTool:   echo\nArguments:\n{\n  "text": "hi"\n}');

    const no = manager('no');
    expect(await no.pm.checkMcpTool(request())).toEqual({ allowed: false, reason: 'User denied MCP tool fx/echo' });
  });

  it('still asks under Allow All', async () => {
    const { pm, ask } = manager('yes');
    pm.setAutoApproveAll(true);
    expect(pm.isAutoApproveAll()).toBe(true);
    await pm.checkMcpTool(request());
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('remembers "always" for the same channel only', async () => {
    const { pm, ask } = manager('always');
    expect((await pm.checkMcpTool(request())).allowed).toBe(true);
    expect((await pm.checkMcpTool(request({ args: { text: 'again' } }))).allowed).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);

    pm.setCurrentContext('cli', 'cli-2');
    await pm.checkMcpTool(request());
    expect(ask).toHaveBeenCalledTimes(2);

    await pm.checkMcpTool(request({ toolName: 'add', exposedName: 'mcp__fx__add' }));
    expect(ask).toHaveBeenCalledTimes(3);
  });

  it('denies unattended runs, including internal turns with a turn grant', async () => {
    const { pm, ask } = manager('yes');
    pm.setCurrentContext('internal', 'scheduler');
    pm.beginTurnGrant();
    const result = await pm.checkMcpTool(request());
    pm.endTurnGrant();
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe(
      'MCP tool fx/echo needs approval; add "echo" to tools.autoApprove for server "fx" to run it unattended',
    );
    expect(ask).not.toHaveBeenCalled();
  });

  it('denies when nothing can ask, and in fail-closed mode', async () => {
    const pm = new PermissionManager();
    pm.setCurrentContext('cli', 'cli-1');
    expect((await pm.checkMcpTool(request())).allowed).toBe(false);

    const bot = manager('yes');
    bot.pm.setFailClosed(true);
    expect(await bot.pm.checkMcpTool(request())).toEqual({
      allowed: false,
      reason: 'Fail-closed: MCP tool fx/echo is not in tools.autoApprove',
    });
    expect(bot.ask).not.toHaveBeenCalled();
  });

  it('redacts and truncates the arguments it shows', async () => {
    const secret = ['gate-secret-', 'value-123'].join('');
    registerSecretValue(secret);
    const { pm, ask } = manager('no');
    await pm.checkMcpTool(request({ args: { token: secret } }));
    expect(ask.mock.calls[0]?.[0]).not.toContain(secret);

    // Ordinary arguments are shown whole, however many lines.
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]));
    expect(formatMcpArgs(many)).toBe(JSON.stringify(many, null, 2));

    // A long payload keeps its start and its end: nothing hides after a cut.
    const shown = formatMcpArgs({ note: 'hello', filler: 'x'.repeat(20_000), tail: 'DELETE EVERYTHING' });
    expect(shown).toContain('"note": "hello"');
    expect(shown).toContain('DELETE EVERYTHING');
    expect(shown).toMatch(/characters not shown/);
    expect(shown.length).toBeLessThan(4000);
  });

  it('a shell command that changes MCP setup always asks, even under Allow All', async () => {
    const { changesMcpSetup } = await import('../permissions.js');
    expect(changesMcpSetup('mercury mcp add evil --stdio sh -y --auto-approve run')).toBe(true);
    expect(changesMcpSetup('npx mercury-agent mcp enable evil')).toBe(true);
    expect(changesMcpSetup("sed -i 's/x/y/' ~/.mercury/mercury.yaml")).toBe(true);
    expect(changesMcpSetup('mercury mcp list')).toBe(false);
    expect(changesMcpSetup('ls -la')).toBe(false);

    const { pm, ask } = manager('no');
    pm.setAutoApproveAll(true);
    const check = await pm.checkShellCommand('mercury mcp add evil --stdio sh -y');
    expect(check.allowed).toBe(false);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(String(ask.mock.calls[0]?.[0])).toMatch(/always asks/);
    expect((await pm.checkShellCommand('echo hi')).allowed).toBe(true);
  });
});

describe('Mercury config file protection', () => {
  function writer(answer: string) {
    const { pm, ask } = manager(answer);
    pm.getManifest().capabilities.filesystem.scopes = [{ path: home, read: true, write: true }];
    pm.setAutoApproveAll(true);
    return { pm, ask };
  }

  it('asks before writing mercury.yaml, .env or permissions.yaml even under Allow All', async () => {
    for (const file of ['mercury.yaml', '.env', 'permissions.yaml']) {
      const { pm, ask } = writer('no');
      const result = await pm.checkFsAccess(join(home, file), 'write');
      expect(result.allowed).toBe(false);
      expect(ask.mock.calls[0]?.[0]).toMatch(/^Write to Mercury config file: /);
    }
    const { pm } = writer('yes');
    expect((await pm.checkFsAccess(join(home, 'mercury.yaml'), 'write')).allowed).toBe(true);
  });

  it('denies config writes when nobody can confirm', async () => {
    const { pm, ask } = writer('yes');
    pm.setCurrentContext('internal', 'scheduler');
    const result = await pm.checkFsAccess(join(home, 'mercury.yaml'), 'write');
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/is a Mercury config file/);
    expect(ask).not.toHaveBeenCalled();
  });

  it('leaves other files in the same folder alone', async () => {
    const { pm, ask } = writer('no');
    expect((await pm.checkFsAccess(join(home, 'notes.txt'), 'write')).allowed).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it('matches config files case-insensitively on macOS', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      const { pm, ask } = writer('no');
      const result = await pm.checkFsAccess(join(home, 'MERCURY.YAML'), 'write');
      expect(result.allowed).toBe(false);
      expect(ask.mock.calls[0]?.[0]).toMatch(/^Write to Mercury config file: /);
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });
});

describe('MCP tools in the registry and filters', () => {
  const echo: Tool = tool({
    description: 'echo',
    inputSchema: zodSchema(z.object({})),
    execute: async () => 'ok',
  });
  const fakeMcp = { getTools: () => ({ mcp__fx__echo: echo }) } as unknown as McpManager;

  it('adds MCP tools to the tool set and names', () => {
    const registry = new CapabilityRegistry({} as never);
    registry.registerAll();
    registry.attachMcp(fakeMcp);
    expect(registry.getTools().mcp__fx__echo).toBe(echo);
    expect(registry.getToolNames()).toContain('mcp__fx__echo');
    expect(registry.getMcpManager()).toBe(fakeMcp);
  });

  it('hides MCP tools from members and from plan mode', () => {
    const registry = new CapabilityRegistry({} as never);
    registry.registerAll();
    registry.attachMcp(fakeMcp);
    expect(registry.getPlanTools().mcp__fx__echo).toBeUndefined();
    registry.permissions.setCurrentSenderRole('member');
    expect(registry.getTools().mcp__fx__echo).toBeUndefined();
    registry.permissions.setCurrentSenderRole('admin');
    expect(registry.getTools().mcp__fx__echo).toBe(echo);
  });

  it('never gives bots MCP tools, even when allow-listed', () => {
    const filtered = filterBotTools(
      { read_file: 1, mcp__fx__echo: 2 },
      {} as never,
      { tools: { allow: ['read_file', 'mcp__fx__echo'], deny: [] } } as never,
    );
    expect(Object.keys(filtered)).toEqual(['read_file']);
  });

  it('labels MCP tool steps by server and tool', () => {
    expect(formatToolStep('mcp__github__search_issues', {})).toBe('🔌 github › search_issues');
    expect(formatToolStep('some_unknown_tool', {})).toBe('some_unknown_tool');
  });
});
