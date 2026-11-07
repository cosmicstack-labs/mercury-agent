import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport, type Tool } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';

const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-fixture-server.mjs', import.meta.url));
const TOKEN = 'fixture-token-0123456789';

type Content = { type: string; text?: string; mimeType?: string };

const clients: Client[] = [];

function newClient(options?: ConstructorParameters<typeof Client>[1]): Client {
  const client = new Client({ name: 'mercury-test', version: '0.0.0' }, options);
  clients.push(client);
  return client;
}

function stdioTransport(env: Record<string, string> = {}): StdioClientTransport {
  return new StdioClientTransport({
    command: process.execPath,
    args: [FIXTURE],
    env: { ...getDefaultEnvironment(), ...env },
    stderr: 'pipe',
  });
}

function firstText(result: { content?: unknown }): string {
  const content = (result.content ?? []) as Content[];
  return content.find((c) => c.type === 'text')?.text ?? '';
}

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((c) => c.close()));
});

describe('MCP v2 client over stdio', () => {
  it('lists and calls tools', async () => {
    const client = newClient();
    await client.connect(stdioTransport());

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['echo', 'add', 'image', 'fail']));

    expect(firstText(await client.callTool({ name: 'echo', arguments: { text: 'hi' } }))).toBe('hi');

    const image = await client.callTool({ name: 'image', arguments: {} });
    const parts = image.content as Content[];
    expect(parts.map((p) => p.type)).toEqual(['text', 'image']);
    expect(parts[1]?.mimeType).toBe('image/png');

    const failed = await client.callTool({ name: 'fail', arguments: {} });
    expect(failed.isError).toBe(true);
  }, 20_000);

  it('only passes the environment it is given', async () => {
    process.env.MCP_FIXTURE_HIDDEN = 'parent-only-value';
    try {
      const client = newClient();
      await client.connect(stdioTransport({ MCP_FIXTURE_VISIBLE: 'given' }));
      expect(firstText(await client.callTool({ name: 'read_env', arguments: { name: 'MCP_FIXTURE_VISIBLE' } }))).toBe('given');
      expect(firstText(await client.callTool({ name: 'read_env', arguments: { name: 'MCP_FIXTURE_HIDDEN' } }))).toBe('(unset)');
    } finally {
      delete process.env.MCP_FIXTURE_HIDDEN;
    }
  }, 20_000);

  it('refreshes tools on tools/list_changed', async () => {
    let resolveChanged!: (tools: Tool[]) => void;
    const changed = new Promise<Tool[]>((resolve) => {
      resolveChanged = resolve;
    });
    const client = newClient({
      listChanged: {
        tools: {
          debounceMs: 0,
          onChanged: (error, tools) => {
            if (!error && tools) resolveChanged(tools);
          },
        },
      },
    });
    await client.connect(stdioTransport());
    await client.callTool({ name: 'add_tool', arguments: { name: 'late_tool' } });
    const tools = await changed;
    expect(tools.map((t) => t.name)).toContain('late_tool');
  }, 20_000);
});

describe('MCP v2 client over Streamable HTTP', () => {
  let server: ChildProcess;
  let url: URL;

  beforeAll(async () => {
    server = spawn(process.execPath, [FIXTURE, '--http', '0'], {
      env: { ...process.env, FIXTURE_REQUIRE_TOKEN: TOKEN },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const port = await new Promise<number>((resolve, reject) => {
      let buffered = '';
      server.stdout!.on('data', (chunk: Buffer) => {
        buffered += chunk.toString();
        const match = /LISTENING (\d+)/.exec(buffered);
        if (match) resolve(Number(match[1]));
      });
      server.once('exit', (code) => reject(new Error(`fixture exited with ${code}`)));
    });
    url = new URL(`http://127.0.0.1:${port}/mcp`);
  }, 20_000);

  afterAll(() => {
    server?.kill();
  });

  it('connects through a custom fetch with static headers', async () => {
    let calls = 0;
    const countingFetch: typeof fetch = (input, init) => {
      calls += 1;
      return fetch(input, init);
    };
    const client = newClient();
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        fetch: countingFetch,
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      }),
    );

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('add');
    expect(firstText(await client.callTool({ name: 'add', arguments: { a: 2, b: 3 } }))).toBe('5');
    expect(calls).toBeGreaterThan(0);
  }, 20_000);

  it('fails to connect without the token', async () => {
    const client = newClient();
    await expect(client.connect(new StreamableHTTPClientTransport(url))).rejects.toThrow();
  }, 20_000);
});
