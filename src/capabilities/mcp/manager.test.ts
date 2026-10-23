import { afterEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { Tool } from 'ai';
import { McpManager, probeMcpServer, type McpManagerOptions } from './manager.js';
import type { McpGate, McpServerConfig } from './types.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-fixture-server.mjs', import.meta.url));
const allowAll: McpGate = async () => ({ allowed: true });
const managers: McpManager[] = [];

function fixture(extra: Partial<McpServerConfig> = {}): McpServerConfig {
  return { transport: 'stdio', command: process.execPath, args: [FIXTURE], ...extra };
}

function manager(servers: Record<string, McpServerConfig>, options: Partial<McpManagerOptions> = {}): McpManager {
  const created = new McpManager(servers, { gate: allowAll, ...options });
  managers.push(created);
  return created;
}

async function run(tool: Tool | undefined, input: Record<string, unknown>): Promise<unknown> {
  expect(tool?.execute).toBeTypeOf('function');
  return tool!.execute!(input, { toolCallId: 'call-1', messages: [] });
}

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map((m) => m.close()));
});

describe('McpManager', () => {
  it('exposes only allowed tools, with deny winning over allow', async () => {
    const m = manager({
      fx: fixture({ tools: { allow: ['*'], deny: ['fail', 'crash', 'add_tool'] } }),
      picky: fixture({ tools: { allow: ['echo'] } }),
      off: fixture({ enabled: false, tools: { allow: ['*'] } }),
    });
    await m.connectAll();
    const names = Object.keys(m.getTools()).sort();
    expect(names).toEqual([
      'mcp__fx__add',
      'mcp__fx__big',
      'mcp__fx__echo',
      'mcp__fx__image',
      'mcp__fx__read_env',
      'mcp__picky__echo',
    ]);
    const status = Object.fromEntries(m.status().map((s) => [s.id, s]));
    expect(status.fx?.state).toBe('connected');
    expect(status.fx?.toolCount).toBe(8);
    expect(status.fx?.target).toMatch(/node/i);
    expect(status.off?.state).toBe('disabled');
    expect(status.off?.enabled).toBe(false);
  }, 20_000);

  it('runs tools through the gate and converts results to text', async () => {
    const gate = vi.fn<McpGate>(async (request) =>
      request.toolName === 'add' ? { allowed: true } : { allowed: false, reason: 'User denied: echo' },
    );
    const m = manager({ fx: fixture({ tools: { allow: ['add', 'echo', 'image'], autoApprove: ['add'] } }) }, { gate });
    await m.connectAll();
    const tools = m.getTools();

    expect(await run(tools.mcp__fx__add, { a: 2, b: 3 })).toBe('5');
    expect(gate).toHaveBeenCalledWith({
      serverId: 'fx',
      toolName: 'add',
      exposedName: 'mcp__fx__add',
      args: { a: 2, b: 3 },
      autoApprove: true,
    });
    expect(await run(tools.mcp__fx__echo, { text: 'hi' })).toBe('Error: User denied: echo');
    expect(m.isAutoApproved('mcp__fx__add')).toBe(true);
    expect(m.isAutoApproved('mcp__fx__echo')).toBe(false);
  }, 20_000);

  it('returns an error string when the gate throws', async () => {
    const m = manager(
      { fx: fixture({ tools: { allow: ['echo'] } }) },
      { gate: async () => Promise.reject(new Error('handler crashed')) },
    );
    await m.connectAll();
    expect(await run(m.getTools().mcp__fx__echo, { text: 'x' })).toBe(
      'Error: permission check for MCP fx/echo failed: handler crashed',
    );
  }, 20_000);

  it('keeps healthy servers working when others fail', async () => {
    const m = manager(
      {
        good: fixture({ tools: { allow: ['echo'] } }),
        missing: { transport: 'stdio', command: 'mercury-no-such-command-xyz', tools: { allow: ['*'] } },
        nosecret: fixture({ env: { TOKEN: '${env:MCP_TEST_UNSET_VARIABLE}' }, tools: { allow: ['*'] } }),
        hangs: {
          transport: 'stdio',
          command: process.execPath,
          args: ['-e', 'setInterval(() => {}, 1000)'],
          tools: { allow: ['*'] },
        },
      },
      { connectTimeoutMs: 4_000, backoff: { maxAttempts: 0 } },
    );
    const started = Date.now();
    await m.connectAll();
    expect(Date.now() - started).toBeLessThan(15_000);

    expect(Object.keys(m.getTools())).toEqual(['mcp__good__echo']);
    expect(await run(m.getTools().mcp__good__echo, { text: 'still here' })).toBe('still here');

    const status = Object.fromEntries(m.status().map((s) => [s.id, s]));
    expect(status.good?.state).toBe('connected');
    expect(status.missing?.state).toBe('failed');
    expect(status.nosecret?.state).toBe('failed');
    expect(status.nosecret?.error).toBe('env MCP_TEST_UNSET_VARIABLE is not set');
    expect(status.hangs?.state).toBe('failed');
    expect(status.hangs?.error).toMatch(/timed out after 4000 ms/);
  }, 40_000);

  it('reconnects after the server process dies', async () => {
    const m = manager(
      { fx: fixture({ tools: { allow: ['add', 'crash'] } }) },
      { backoff: { initialMs: 50, maxMs: 200 } },
    );
    await m.connectAll();
    expect(await run(m.getTools().mcp__fx__crash, {})).toBe('bye');

    await waitFor(() => m.status()[0]?.state === 'reconnecting');
    const during = await run(m.getTools().mcp__fx__add, { a: 1, b: 1 });
    expect(during).toMatch(/^Error: MCP fx\/add failed: server fx is reconnecting/);

    await waitFor(() => m.status()[0]?.state === 'connected');
    expect(await run(m.getTools().mcp__fx__add, { a: 1, b: 1 })).toBe('2');
  }, 30_000);

  it('gives up on a server that dies right after every connect', async () => {
    const m = manager(
      { fx: fixture({ env: { FIXTURE_EXIT_AFTER_LIST: '1' }, tools: { allow: ['*'] } }) },
      { backoff: { initialMs: 20, maxMs: 20, maxAttempts: 3 } },
    );
    await m.connectAll();
    await waitFor(() => m.status()[0]?.state === 'failed', 15_000);
    expect(m.status()[0]?.error).toMatch(/gave up after 3 attempts/);
    expect(m.getTools()).toEqual({});
  }, 30_000);

  it('picks up tools announced through tools/list_changed', async () => {
    const onToolsChanged = vi.fn();
    const m = manager({ fx: fixture({ tools: { allow: ['*'] } }) }, { onToolsChanged });
    await m.connectAll();
    expect(m.getTools().mcp__fx__late_tool).toBeUndefined();

    await run(m.getTools().mcp__fx__add_tool, { name: 'late_tool' });
    await waitFor(() => m.getTools().mcp__fx__late_tool !== undefined);
    expect(onToolsChanged).toHaveBeenCalled();
  }, 20_000);

  it('stops reconnecting once closed', async () => {
    const m = manager({ fx: fixture({ tools: { allow: ['crash'] } }) }, { backoff: { initialMs: 50, maxMs: 50 } });
    await m.connectAll();
    await run(m.getTools().mcp__fx__crash, {});
    await m.close();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(m.status()[0]).toMatchObject({ state: 'failed', error: 'manager closed', toolCount: 0 });
    expect(m.getTools()).toEqual({});
  }, 20_000);
});

describe('probeMcpServer', () => {
  it('reports tools with their allow and skip state', async () => {
    const status = await probeMcpServer('fx', fixture({ tools: { allow: ['echo'], autoApprove: ['echo'] } }));
    expect(status.state).toBe('connected');
    expect(status.tools.find((t) => t.name === 'echo')).toEqual({
      name: 'echo',
      exposedName: 'mcp__fx__echo',
      allowed: true,
      autoApprove: true,
      skipped: undefined,
    });
    expect(status.tools.find((t) => t.name === 'add')?.allowed).toBe(false);
  }, 20_000);

  it('reports a failure reason', async () => {
    const status = await probeMcpServer(
      'gone',
      { transport: 'stdio', command: 'mercury-no-such-command-xyz' },
      2_000,
    );
    expect(status.state).toBe('failed');
    expect(status.error).toBeTruthy();
  }, 20_000);
});
