import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Tool } from 'ai';

const home = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  const dir = mkdtempSync(joinPath(tmpdir(), 'mercury-mcp-e2e-'));
  process.env.MERCURY_HOME = dir;
  return dir;
});

const { CapabilityRegistry } = await import('../registry.js');
const { McpManager } = await import('./manager.js');
const { formatMcpChatStatus, formatServerList, addServer } = await import('./admin.js');
const { collectMcpReport, formatMcpReport } = await import('./doctor.js');
const { default: mcpApi, setMcpManager } = await import('../../web/api/mcp.js');
const { loadConfig, saveConfig } = await import('../../utils/config.js');
const { logger } = await import('../../utils/logger.js');
type McpServerConfig = import('./types.js').McpServerConfig;
type Manager = InstanceType<typeof McpManager>;
type Registry = InstanceType<typeof CapabilityRegistry>;

const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-fixture-server.mjs', import.meta.url));
const SENTINEL = ['sk-mcp-sentinel-', 'A1b2C3d4E5f6G7h8J9k0'].join('');
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

function fixture(extra: Partial<McpServerConfig> = {}): McpServerConfig {
  return { transport: 'stdio', command: process.execPath, args: [FIXTURE], ...extra };
}

async function startHttpFixture(
  env: Record<string, string>,
  port = 0,
): Promise<{ url: string; stop: () => Promise<void> }> {
  const child: ChildProcess = spawn(process.execPath, [FIXTURE, '--http', String(port)], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  cleanups.push(() => {
    child.kill();
  });
  const listening = await new Promise<number>((resolve, reject) => {
    let buffered = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      buffered += chunk.toString();
      const match = /LISTENING (\d+)/.exec(buffered);
      if (match) resolve(Number(match[1]));
    });
    child.once('exit', (code) => reject(new Error(`fixture exited with ${code}`)));
  });
  const stop = () =>
    new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('exit', () => resolve());
      child.kill();
    });
  return { url: `http://127.0.0.1:${listening}/mcp`, stop };
}

interface Harness {
  registry: Registry;
  manager: Manager;
  ask: ReturnType<typeof vi.fn>;
  run: (name: string, input?: Record<string, unknown>) => Promise<unknown>;
}

async function harness(
  servers: Record<string, McpServerConfig>,
  options: { answer?: string; connectTimeoutMs?: number; backoff?: { initialMs?: number; maxMs?: number; maxAttempts?: number } } = {},
): Promise<Harness> {
  const registry = new CapabilityRegistry({} as never);
  registry.registerAll();
  const ask = vi.fn().mockResolvedValue(options.answer ?? 'no');
  registry.permissions.onAsk(ask);
  registry.permissions.setCurrentContext('cli', 'e2e');
  const manager = new McpManager(servers, {
    gate: (request) => registry.permissions.checkMcpTool(request),
    connectTimeoutMs: options.connectTimeoutMs,
    backoff: options.backoff,
  });
  registry.attachMcp(manager);
  cleanups.push(() => manager.close());
  await manager.connectAll();
  const run = async (name: string, input: Record<string, unknown> = {}) => {
    const tool: Tool | undefined = registry.getTools()[name];
    if (!tool?.execute) throw new Error(`tool ${name} is not available`);
    return tool.execute(input, { toolCallId: 'e2e', messages: [] });
  };
  return { registry, manager, ask, run };
}

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('MCP end to end over stdio', () => {
  const servers = () => ({
    fx: fixture({ tools: { allow: ['echo', 'add', 'crash'], autoApprove: ['add', 'crash'] } }),
  });

  it('exposes only allowed tools next to the built-in ones', async () => {
    const { registry } = await harness(servers());
    const names = registry.getToolNames();
    expect(names).toEqual(expect.arrayContaining(['read_file', 'mcp__fx__echo', 'mcp__fx__add', 'mcp__fx__crash']));
    expect(names).not.toContain('mcp__fx__fail');
    expect(names).not.toContain('mcp__fx__read_env');
  }, 20_000);

  it('asks before a call and runs it on yes', async () => {
    const { ask, run } = await harness(servers(), { answer: 'yes' });
    expect(await run('mcp__fx__echo', { text: 'hello' })).toBe('hello');
    expect(ask).toHaveBeenCalledWith('MCP tool call\nServer: fx\nTool:   echo\nArguments:\n{\n  "text": "hello"\n}');
  }, 20_000);

  it('returns a denial to the agent on no', async () => {
    const { run } = await harness(servers(), { answer: 'no' });
    expect(await run('mcp__fx__echo', { text: 'hello' })).toBe('Error: User denied MCP tool fx/echo');
  }, 20_000);

  it('stops asking after "always" for that channel', async () => {
    const { ask, run } = await harness(servers(), { answer: 'always' });
    await run('mcp__fx__echo', { text: 'one' });
    expect(await run('mcp__fx__echo', { text: 'two' })).toBe('two');
    expect(ask).toHaveBeenCalledTimes(1);
  }, 20_000);

  it('still asks under Allow All', async () => {
    const { registry, ask, run } = await harness(servers(), { answer: 'yes' });
    registry.permissions.setAutoApproveAll(true);
    await run('mcp__fx__echo', { text: 'x' });
    expect(ask).toHaveBeenCalledTimes(1);
  }, 20_000);

  it('runs only auto-approved tools in unattended turns', async () => {
    const { registry, ask, run } = await harness(servers(), { answer: 'yes' });
    registry.permissions.setCurrentContext('internal', 'scheduler');
    registry.permissions.beginTurnGrant();
    try {
      expect(await run('mcp__fx__add', { a: 2, b: 3 })).toBe('5');
      expect(await run('mcp__fx__echo', { text: 'x' })).toBe(
        'Error: MCP tool fx/echo needs approval; add "echo" to tools.autoApprove for server "fx" to run it unattended',
      );
    } finally {
      registry.permissions.endTurnGrant();
    }
    expect(ask).not.toHaveBeenCalled();
  }, 20_000);

  it('keeps MCP tools out of plan mode and away from members', async () => {
    const { registry } = await harness(servers());
    expect(Object.keys(registry.getPlanTools()).some((name) => name.startsWith('mcp__'))).toBe(false);
    registry.permissions.setCurrentSenderRole('member');
    expect(Object.keys(registry.getTools()).some((name) => name.startsWith('mcp__'))).toBe(false);
  }, 20_000);

  it('recovers when the server process dies mid-session', async () => {
    const { manager, run } = await harness(servers(), { backoff: { initialMs: 50, maxMs: 200 } });
    expect(await run('mcp__fx__crash')).toBe('bye');
    await waitFor(() => manager.status()[0]?.state === 'reconnecting');
    expect(await run('mcp__fx__add', { a: 1, b: 2 })).toMatch(/^Error: MCP fx\/add failed: server fx is reconnecting/);
    await waitFor(() => manager.status()[0]?.state === 'connected');
    expect(await run('mcp__fx__add', { a: 1, b: 2 })).toBe('3');
  }, 30_000);
});

describe('MCP end to end over Streamable HTTP', () => {
  it('blocks a loopback server unless allowPrivate is set', async () => {
    const { url } = await startHttpFixture({});
    const blocked = await harness({ web: { transport: 'http', url, tools: { allow: ['*'] } } }, { backoff: { maxAttempts: 0 } });
    expect(blocked.manager.status()[0]).toMatchObject({ state: 'failed' });
    expect(blocked.manager.status()[0]?.error).toMatch(/private\/internal address \(SSRF protection\)\. Set allowPrivate: true/);
    expect(Object.keys(blocked.registry.getTools()).some((name) => name.startsWith('mcp__'))).toBe(false);

    const allowed = await harness(
      { web: { transport: 'http', url, allowPrivate: true, tools: { allow: ['add'] } } },
      { answer: 'yes' },
    );
    expect(allowed.manager.status()[0]?.state).toBe('connected');
    expect(await allowed.run('mcp__web__add', { a: 20, b: 22 })).toBe('42');
  }, 30_000);

  it('marks a server reconnecting when it goes down and recovers when it is back', async () => {
    const first = await startHttpFixture({});
    const port = Number(new URL(first.url).port);
    const { manager, run } = await harness(
      { web: { transport: 'http', url: first.url, allowPrivate: true, tools: { allow: ['add'], autoApprove: ['add'] } } },
      { backoff: { initialMs: 50, maxMs: 200, maxAttempts: 100 } },
    );
    expect(await run('mcp__web__add', { a: 1, b: 1 })).toBe('2');

    await first.stop();
    expect(String(await run('mcp__web__add', { a: 1, b: 1 }))).toMatch(/^Error: MCP web\/add failed: /);
    expect(manager.status()[0]?.state).toBe('reconnecting');

    await startHttpFixture({}, port);
    await waitFor(() => manager.status()[0]?.state === 'connected', 15_000);
    expect(await run('mcp__web__add', { a: 20, b: 22 })).toBe('42');
  }, 40_000);
});

describe('MCP failure isolation', () => {
  it('starts with broken servers present and keeps the rest working', async () => {
    const started = Date.now();
    const { manager, registry, run } = await harness(
      {
        good: fixture({ tools: { allow: ['echo'], autoApprove: ['echo'] } }),
        missing: { transport: 'stdio', command: 'mercury-no-such-command-xyz', tools: { allow: ['*'] } },
        hangs: { transport: 'stdio', command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], tools: { allow: ['*'] } },
        crashes: fixture({ env: { FIXTURE_EXIT_AT_START: '1' }, tools: { allow: ['*'] } }),
      },
      { connectTimeoutMs: 4_000, backoff: { maxAttempts: 0 } },
    );
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(registry.getTools().read_file).toBeDefined();
    expect(Object.keys(registry.getTools()).filter((name) => name.startsWith('mcp__'))).toEqual(['mcp__good__echo']);
    expect(await run('mcp__good__echo', { text: 'fine' })).toBe('fine');
    const states = Object.fromEntries(manager.status().map((s) => [s.id, s.state]));
    expect(states).toEqual({ good: 'connected', missing: 'failed', hangs: 'failed', crashes: 'failed' });
  }, 40_000);
});

describe('MCP secrets never leak', () => {
  const logged: string[] = [];

  beforeAll(() => {
    process.env.MCP_SENTINEL = SENTINEL;
    for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const) {
      vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
        logged.push(JSON.stringify(args));
      }) as never);
    }
  });

  afterAll(() => {
    delete process.env.MCP_SENTINEL;
    vi.restoreAllMocks();
  });

  it('keeps the sentinel out of results, status, API, chat, CLI, doctor, logs and YAML', async () => {
    const { url } = await startHttpFixture({ FIXTURE_REQUIRE_TOKEN: SENTINEL });
    const servers: Record<string, McpServerConfig> = {
      echoer: fixture({ env: { TOKEN: '${env:MCP_SENTINEL}' }, tools: { allow: ['read_env'], autoApprove: ['read_env'] } }),
      leaky: fixture({ env: { FIXTURE_STDERR_SECRET: '${env:MCP_SENTINEL}', FIXTURE_EXIT_AT_START: '1' } }),
      web: {
        transport: 'http',
        url,
        allowPrivate: true,
        headers: { Authorization: 'Bearer ${env:MCP_SENTINEL}' },
        tools: { allow: ['echo'], autoApprove: ['echo'] },
      },
      wrongweb: {
        transport: 'http',
        url,
        allowPrivate: true,
        headers: { Authorization: 'Bearer ${env:MCP_SENTINEL}-wrong' },
        tools: { allow: ['*'] },
      },
    };
    const { manager, run } = await harness(servers, { backoff: { maxAttempts: 0 } });

    const states = Object.fromEntries(manager.status().map((s) => [s.id, s.state]));
    expect(states).toEqual({ echoer: 'connected', leaky: 'failed', web: 'connected', wrongweb: 'failed' });
    expect(manager.status().find((s) => s.id === 'wrongweb')?.error).toMatch(/^HTTP 401 Unauthorized/);

    const result = String(await run('mcp__echoer__read_env', { name: 'TOKEN' }));
    expect(result).toBe('****');
    expect(String(await run('mcp__web__echo', { text: `said ${SENTINEL}` }))).toBe('said ****');

    const statusJson = JSON.stringify(manager.status());
    const leaky = manager.status().find((s) => s.id === 'leaky');
    expect(leaky?.stderrTail).toContain('starting with token ****');

    setMcpManager(manager);
    const apiJson = await (await mcpApi.request('/api/mcp')).text();
    setMcpManager(null);

    const chat = formatMcpChatStatus(manager.status(), '') + formatMcpChatStatus(manager.status(), 'tools echoer');

    const config = loadConfig();
    for (const [id, server] of Object.entries(servers)) addServer(config, id, server);
    const cliList = formatServerList(config).join('\n');
    saveConfig(config);
    const yaml = readFileSync(join(home, 'mercury.yaml'), 'utf-8');
    expect(yaml).toContain('${env:MCP_SENTINEL}');

    const doctor = formatMcpReport(await collectMcpReport({ servers }, 10_000)).join('\n');
    expect(doctor).toContain('starting with token ****');

    const surfaces = { result, statusJson, apiJson, chat, cliList, yaml, doctor, logs: logged.join('\n') };
    for (const [surface, text] of Object.entries(surfaces)) {
      expect(text.includes(SENTINEL), `sentinel leaked into ${surface}`).toBe(false);
    }
    expect(logged.length).toBeGreaterThan(0);
  }, 60_000);
});
