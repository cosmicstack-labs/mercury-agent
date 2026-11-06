import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { McpResourceGate, McpServerConfig } from './types.js';
import { MAX_CATALOG_PAGE_CHARS } from './resources.js';
import { MAX_RESULT_CHARS } from './result.js';

const home = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'mercury-resources-'));
  process.env.MERCURY_HOME = dir;
  return dir;
});
const { McpManager } = await import('./manager.js');
const { CapabilityRegistry } = await import('../registry.js');
const { WebChannel } = await import('../../channels/web.js');
const { filterBotTools } = await import('../../bots/registry-factory.js');
const { makeContext } = await import('../permission-context.js');
const { validateMcpConfig } = await import('./config.js');
const { registerSecretValue } = await import('../../utils/redact.js');
const FIXTURE = fileURLToPath(new URL('./fixtures/resource-fixture-server.mjs', import.meta.url));
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
afterAll(() => rmSync(home, { recursive: true, force: true }));

async function harness(extra: Partial<McpServerConfig> = {}, options: { answer?: string; gate?: McpResourceGate; http?: boolean } = {}) {
  const log = join(home, `${randomUUID()}.jsonl`);
  const registry = new CapabilityRegistry();
  const ask = vi.fn().mockResolvedValue(options.answer ?? 'no');
  registry.permissions.onAsk(ask);
  registry.permissions.setCurrentContext('cli', 'owner');
  let config: McpServerConfig = { transport: 'stdio', command: process.execPath, args: [FIXTURE], resources: { allow: ['*'], deny: ['docs://secret'] }, ...extra };
  if (options.http) {
    const child = spawn(process.execPath, [FIXTURE, '--http'], { env: { ...process.env, FIXTURE_LOG: log, FIXTURE_TOKEN: 'fixture-bearer' }, stdio: ['ignore', 'pipe', 'ignore'] });
    cleanups.push(() => new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('exit', () => resolve()); child.kill();
    }));
    const port = await new Promise<string>((resolve, reject) => {
      let text = '';
      child.stdout!.on('data', (chunk: Buffer) => { text += chunk.toString(); const match = /LISTENING (\d+)/.exec(text); if (match) resolve(match[1]); });
      child.once('exit', () => reject(new Error('HTTP fixture exited before listening')));
    });
    config = { transport: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: 'Bearer fixture-bearer' }, allowPrivate: true, resources: config.resources, ...extra };
  } else config.env = { ...config.env, FIXTURE_LOG: log };
  const manager = new McpManager({ docs: config }, {
    gate: (request) => registry.permissions.checkMcpTool(request),
    resourceGate: options.gate ?? ((request) => registry.permissions.checkMcpResource(request)),
    backoff: { initialMs: 20, maxMs: 50, maxAttempts: 2 },
  });
  registry.attachMcp(manager);
  cleanups.push(() => manager.close());
  await manager.connectAll();
  if (manager.status()[0].state !== 'connected') throw new Error(JSON.stringify({ status: manager.status()[0], fixture: FIXTURE, runtime: process.execPath }));
  const run = async (name: 'list_mcp_resources' | 'read_mcp_resource', args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<string> => {
    const tool = registry.getTools()[name];
    if (!tool?.execute) throw new Error(`Missing tool ${name}`);
    return await tool.execute(args, { toolCallId: 'fixture', messages: [], abortSignal: signal }) as string;
  };
  const calls = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { method: string; params?: { uri?: string; cursor?: string }; pid: number }) : [];
  return { registry, manager, ask, run, calls };
}

describe('bounded MCP resources through the real SDK', () => {
  it('connects a resources-only server, requires opt-in separate from tools, and lists server IDs locally', async () => {
    const off = await harness({ tools: { allow: ['*'] }, resources: undefined });
    expect(off.manager.status()[0].state).toBe('connected');
    expect(off.registry.getTools().read_mcp_resource).toBeUndefined();
    expect(off.calls().some((call) => call.method === 'tools/list')).toBe(false);
    const enabled = await harness();
    expect(JSON.parse(await enabled.run('list_mcp_resources'))).toEqual({ servers: ['docs'] });
    expect(enabled.ask).not.toHaveBeenCalled();
    expect(enabled.calls().some((call) => call.method.startsWith('resources/'))).toBe(false);
  });

  it('fetches exactly one remote page per requested page, keeps URIs stable and hides denied resources', async () => {
    const h = await harness({}, { answer: 'yes' });
    const first = JSON.parse(await h.run('list_mcp_resources', { server: 'docs' }));
    expect(first.resources.map((r: { uri: string }) => r.uri)).toEqual(['docs://alpha']);
    expect(first.nextCursor).toMatch(/^[a-f0-9-]{36}$/);
    expect(h.calls().filter((c) => c.method === 'resources/list')).toHaveLength(1);
    const second = JSON.parse(await h.run('list_mcp_resources', { server: 'docs', cursor: first.nextCursor }));
    expect(second.resources[0].uri).toBe('docs://beta');
    expect(second.nextCursor).toBeUndefined();
    expect(h.calls().filter((c) => c.method === 'resources/list')).toHaveLength(2);
    const text = await h.run('read_mcp_resource', { server: 'docs', uri: second.resources[0].uri });
    expect(text).toContain('Requested URI: "docs://beta"');
    expect(text).toContain('Source URI: "docs://beta"');
    expect(text).toContain('Reference text');
    expect(text).toContain('(untrusted)');
  });

  it('paginates an oversized remote page locally with bounded output and metadata storage', async () => {
    const h = await harness({ env: { FIXTURE_RESOURCE_COUNT: '1000' } }, { answer: 'always' });
    let cursor: string | undefined;
    const uris = new Set<string>();
    let pages = 0;
    do {
      const output = await h.run('list_mcp_resources', { server: 'docs', cursor });
      expect(output.length).toBeLessThanOrEqual(MAX_CATALOG_PAGE_CHARS);
      const result = JSON.parse(output);
      expect(result.notice).toContain('omitted');
      for (const item of result.resources) { expect(uris.has(item.uri)).toBe(false); uris.add(item.uri); }
      cursor = result.nextCursor;
      expect(++pages).toBeLessThan(16);
    } while (cursor);
    expect(uris.size).toBeGreaterThan(100);
    expect(uris.size).toBeLessThanOrEqual(256);
    expect(h.calls().filter((c) => c.method === 'resources/list')).toHaveLength(1);
  });

  it('bounds text, omits binary bytes and redacts registered secrets', async () => {
    const secret = 'resource-secret-sentinel-0123456789';
    registerSecretValue(secret);
    const h = await harness({ env: { FIXTURE_SECRET: secret }, resources: { allow: ['*'] } }, { answer: 'yes' });
    const large = await h.run('read_mcp_resource', { server: 'docs', uri: 'docs://large' });
    expect(large.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    expect(large).toContain('[Resource content truncated]');
    expect(large).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
    const binary = await h.run('read_mcp_resource', { server: 'docs', uri: 'docs://binary' });
    expect(binary).toContain('[Binary resource omitted]');
    expect(binary).not.toContain('YmluYXJ5');
    expect(await h.run('read_mcp_resource', { server: 'docs', uri: 'docs://secret' })).not.toContain(secret);
  });

  it('does not dispatch denied, disallowed or cancelled resource reads', async () => {
    const h = await harness();
    expect(await h.run('read_mcp_resource', { server: 'docs', uri: 'docs://alpha' })).toContain('denied');
    expect(await h.run('read_mcp_resource', { server: 'docs', uri: 'docs://secret' })).toContain('not allowed');
    const ac = new AbortController(); ac.abort();
    expect(await h.run('read_mcp_resource', { server: 'docs', uri: 'docs://alpha' }, ac.signal)).toContain('cancelled');
    expect(h.calls().some((c) => c.method === 'resources/read')).toBe(false);
  });

  it('omits other returned URIs even when configured as allowed, preserving exact approval and source', async () => {
    const h = await harness({ env: { FIXTURE_EXTRA_CONTENT: '1' } }, { answer: 'yes' });
    const text = await h.run('read_mcp_resource', { server: 'docs', uri: 'docs://alpha' });
    expect(text).toContain('Approved alpha reference');
    expect(text).toContain('Source URI: "docs://alpha"');
    expect(text).toContain('[Content for other resource URIs omitted]');
    for (const extra of ['docs://secret', 'docs://beta', 'denied-resource-content-marker', 'different-allowed-resource-marker']) {
      expect(text).not.toContain(extra);
    }
    expect(h.ask).toHaveBeenCalledTimes(1);
    expect(h.calls().filter((c) => c.method === 'resources/read').map((c) => c.params?.uri)).toEqual(['docs://alpha']);
  });

  it('allows only exact configured unattended reads and keeps catalog approval separate', async () => {
    const h = await harness({ resources: { allow: ['*'], autoApprove: ['docs://alpha'] } });
    h.registry.permissions.setCurrentContext('internal', 'scheduled');
    expect(await h.run('read_mcp_resource', { server: 'docs', uri: 'docs://alpha' })).toContain('Reference text');
    expect(await h.run('read_mcp_resource', { server: 'docs', uri: 'docs://beta' })).toContain('need owner approval');
    expect(await h.run('list_mcp_resources', { server: 'docs' })).toContain('need owner approval');
    expect(h.ask).not.toHaveBeenCalled();
  });

  it('does not turn a late approval into a request or a remembered grant after cancellation', async () => {
    const h = await harness();
    let answer!: (value: string) => void;
    const gate = new Promise<string>((resolve) => { answer = resolve; });
    h.registry.permissions.onAsk(() => gate);
    const ac = new AbortController();
    const reading = h.run('read_mcp_resource', { server: 'docs', uri: 'docs://alpha' }, ac.signal);
    ac.abort(); answer('always');
    expect(await reading).toContain('cancelled');
    h.registry.permissions.onAsk(async () => 'no');
    expect(await h.run('read_mcp_resource', { server: 'docs', uri: 'docs://alpha' })).toContain('denied');
    expect(h.calls().some((c) => c.method === 'resources/read')).toBe(false);
  });

  it('keeps resource helpers out of plan, member and bot tool sets', async () => {
    const h = await harness({}, { answer: 'yes' });
    expect(h.registry.getPlanTools().read_mcp_resource).toBeUndefined();
    const tools = h.registry.getTools();
    const bot = filterBotTools(tools, {} as never, { tools: { allow: Object.keys(tools), deny: [] } } as never);
    expect(bot.read_mcp_resource).toBeUndefined();
    expect(bot.list_mcp_resources).toBeUndefined();
    h.registry.permissions.setCurrentSenderRole('member');
    expect(h.registry.getTools().read_mcp_resource).toBeUndefined();
    expect(await tools.read_mcp_resource.execute!({ server: 'docs', uri: 'docs://alpha' }, { toolCallId: 'retained', messages: [] })).toContain('unavailable to members');
  });

  it('rechecks retained helpers for members, fail-closed bots and restricted children before local listing or URI auto-approval', async () => {
    const h = await harness({ resources: { allow: ['*'], autoApprove: ['docs://alpha'] } }, { answer: 'yes' });
    const tools = h.registry.getTools();
    const invoke = (name: 'list_mcp_resources' | 'read_mcp_resource', args: Record<string, unknown>) =>
      tools[name].execute!(args, { toolCallId: 'retained', messages: [] });
    const requests = [
      ['list_mcp_resources', {}],
      ['list_mcp_resources', { server: 'docs' }],
      ['read_mcp_resource', { server: 'docs', uri: 'docs://alpha' }],
    ] as const;
    const pm = h.registry.permissions;
    for (const context of [
      makeContext({ senderRole: 'member' }),
      makeContext({ channelType: 'internal', allowedTools: ['read_file'] }),
      makeContext({ allowedTools: [] }),
    ]) {
      await pm.withContext(context, async () => {
        for (const [name, args] of requests) {
          const result = await invoke(name, args);
          expect(result).toMatch(/unavailable to members|not allowed in this context/);
          expect(result).not.toContain('"docs"');
        }
      });
    }
    pm.setFailClosed(true);
    for (const [name, args] of requests) expect(await invoke(name, args)).toContain('fail-closed');
    pm.setFailClosed(false);
    expect(h.ask).not.toHaveBeenCalled();
    expect(h.calls().some((c) => c.method.startsWith('resources/'))).toBe(false);

    await pm.withContext(makeContext({ allowedTools: ['list_mcp_resources'] }), async () => {
      expect(await invoke('list_mcp_resources', {})).toBe('{"servers":["docs"]}');
      expect(await invoke('read_mcp_resource', { server: 'docs', uri: 'docs://alpha' })).toContain('not allowed in this context');
    });
    await pm.withContext(makeContext({ allowedTools: ['read_mcp_resource'] }), async () => {
      expect(await invoke('list_mcp_resources', {})).toContain('not allowed in this context');
      expect(await invoke('read_mcp_resource', { server: 'docs', uri: 'docs://alpha' })).toContain('Reference text');
    });
    expect(h.calls().filter((c) => c.method.startsWith('resources/'))).toHaveLength(1);
    expect(h.ask).not.toHaveBeenCalled();
  });

  it('remembers approval only for the same protocol, source channel, server and exact URI', async () => {
    const h = await harness({}, { answer: 'always' });
    const pm = h.registry.permissions;
    const read = (type: string, id: string, uri: string) => pm.withContext(makeContext({ channelType: type, channelId: id }), () => h.run('read_mcp_resource', { server: 'docs', uri }));
    await read('web', 'A', 'docs://alpha');
    await read('web', 'A', 'docs://alpha');
    expect(h.ask).toHaveBeenCalledTimes(1);
    await read('cli', 'A', 'docs://alpha');
    await read('web', 'B', 'docs://alpha');
    await read('web', 'A', 'docs://beta');
    await pm.withContext(makeContext({ channelType: 'web', channelId: 'A' }), () => h.run('list_mcp_resources', { server: 'docs' }));
    expect(h.ask).toHaveBeenCalledTimes(5);
    await pm.withContext(makeContext({ channelType: 'web', channelId: 'A' }), () => pm.checkMcpResource({ serverId: 'other', operation: 'read', uri: 'docs://alpha', autoApprove: false }));
    expect(h.ask).toHaveBeenCalledTimes(6);
  });

  it('asks through a real WebChannel even when Allow All is enabled', async () => {
    const h = await harness();
    const web = new WebChannel('Mercury');
    cleanups.push(() => web.stop());
    web.setBypassPermissions(true);
    web.addSSEClient({ enqueue() {}, close() {} } as unknown as ReadableStreamDefaultController, 'web-session');
    h.registry.permissions.setCurrentContext('web', 'web-session');
    h.registry.permissions.onAsk((prompt, options) => web.askPermission(prompt, 'web-session', options));
    const reading = h.run('read_mcp_resource', { server: 'docs', uri: 'docs://alpha' });
    const pending = web.pendingFor('web-session');
    expect(pending).toHaveLength(1);
    expect(h.calls().some((c) => c.method === 'resources/read')).toBe(false);
    expect(web.resolveApproval(pending[0].data!.id as string, 'no', 'web-session')).toBe(true);
    expect(await reading).toContain('denied');
    expect(h.calls().some((c) => c.method === 'resources/read')).toBe(false);
  });

  it('times out once without retrying a read', async () => {
    const h = await harness({ timeoutMs: 30 }, { answer: 'yes' });
    expect(await h.run('read_mcp_resource', { server: 'docs', uri: 'docs://slow' })).toMatch(/timed out/i);
    expect(h.calls().filter((c) => c.method === 'resources/read')).toHaveLength(1);
  });

  it('cancels a dispatched read without retrying and leaves the connection usable', async () => {
    const h = await harness({}, { answer: 'yes' });
    const ac = new AbortController();
    const reading = h.run('read_mcp_resource', { server: 'docs', uri: 'docs://slow' }, ac.signal);
    await vi.waitFor(() => expect(h.calls().filter((c) => c.method === 'resources/read')).toHaveLength(1));
    ac.abort();
    expect(await reading).toMatch(/cancel|abort/i);
    await vi.waitFor(() => expect(h.calls().some((c) => c.method === 'notifications/cancelled')).toBe(true));
    expect(h.calls().filter((c) => c.method === 'resources/read')).toHaveLength(1);
    expect(await h.run('read_mcp_resource', { server: 'docs', uri: 'docs://alpha' })).toContain('Reference text');
  });

  it('reconnects after a crash without replaying reads, and invalidates old catalog cursors', async () => {
    const h = await harness({}, { answer: 'always' });
    const first = JSON.parse(await h.run('list_mcp_resources', { server: 'docs' }));
    const oldPid = h.calls()[0].pid;
    expect(await h.run('read_mcp_resource', { server: 'docs', uri: 'docs://crash' })).toMatch(/closed|connection/i);
    await vi.waitFor(() => {
      expect(h.manager.status()[0].state).toBe('connected');
      expect(h.calls().some((c) => c.method === 'initialize' && c.pid !== oldPid)).toBe(true);
    }, { timeout: 5000 });
    expect(await h.run('list_mcp_resources', { server: 'docs', cursor: first.nextCursor })).toContain('cursor expired');
    expect(JSON.parse(await h.run('list_mcp_resources', { server: 'docs' })).resources[0].uri).toBe('docs://alpha');
    expect(h.calls().filter((c) => c.method === 'resources/read' && c.params?.uri === 'docs://crash')).toHaveLength(1);
  });

  it('uses the guarded HTTP transport and configured authentication for resource reads', async () => {
    const h = await harness({}, { answer: 'yes', http: true });
    expect(h.manager.status()[0].state).toBe('connected');
    expect(await h.run('read_mcp_resource', { server: 'docs', uri: 'docs://alpha' })).toContain('Reference text');
    expect(h.calls().filter((c) => c.method === 'resources/read')).toHaveLength(1);
  });
});

describe('resource configuration', () => {
  it('accepts URI filters while rejecting wildcard auto-approval and invalid URI fields', () => {
    const config = (resources: unknown) => validateMcpConfig({ servers: { docs: { transport: 'stdio', command: 'node', resources } } });
    expect(config({ allow: ['*'], deny: ['docs://private'], autoApprove: ['docs://alpha'] }).problems).toEqual([]);
    for (const resources of [{ autoApprove: ['*'] }, { allow: ['relative/path'] }, { allow: ['docs://newline\ninjection'] }, { allow: ['docs://' + 'x'.repeat(2048)] }]) {
      expect(config(resources).problems).toHaveLength(1);
    }
    expect(config({ allow: ['docs://alpha'], autoApprove: ['docs://beta'] }).warnings[0]).toContain('resources.allow');
  });
});
