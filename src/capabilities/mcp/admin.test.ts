import { afterAll, describe, expect, it, vi } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const home = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  const dir = mkdtempSync(joinPath(tmpdir(), 'mercury-mcp-admin-'));
  process.env.MERCURY_HOME = dir;
  return dir;
});

const admin = await import('./admin.js');
const { loadConfig, saveConfig } = await import('../../utils/config.js');
type McpServerStatus = import('./types.js').McpServerStatus;

afterAll(() => rmSync(home, { recursive: true, force: true }));

const join2 = (...parts: string[]) => parts.join('');

describe('buildServerConfig', () => {
  it('builds a stdio server from CLI options', () => {
    expect(
      admin.buildServerConfig({
        stdio: 'npx',
        args: ['-y', 'server-github'],
        env: ['GITHUB_TOKEN=${env:GITHUB_TOKEN}'],
        allow: 'search_issues, get_issue',
        autoApprove: 'search_issues',
      }),
    ).toEqual({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'server-github'],
      env: { GITHUB_TOKEN: '${env:GITHUB_TOKEN}' },
      tools: { allow: ['search_issues', 'get_issue'], autoApprove: ['search_issues'] },
    });
  });

  it('builds an http server from CLI options', () => {
    expect(
      admin.buildServerConfig({
        http: 'http://127.0.0.1:8080/mcp',
        header: ['Authorization: Bearer ${env:DOCS_TOKEN}'],
        allowPrivate: true,
        disabled: true,
      }),
    ).toEqual({
      transport: 'http',
      url: 'http://127.0.0.1:8080/mcp',
      headers: { Authorization: 'Bearer ${env:DOCS_TOKEN}' },
      allowPrivate: true,
      enabled: false,
    });
  });

  it('rejects mixed or missing transports and misplaced options', () => {
    expect(() => admin.buildServerConfig({})).toThrow('Pass exactly one of --stdio <command> or --http <url>');
    expect(() => admin.buildServerConfig({ stdio: 'a', http: 'https://x' })).toThrow('Pass exactly one');
    expect(() => admin.buildServerConfig({ stdio: 'a', header: ['A: b'] })).toThrow('--header only applies');
    expect(() => admin.buildServerConfig({ http: 'https://x', env: ['A=b'] })).toThrow('--env only applies');
    expect(() => admin.buildServerConfig({ http: 'https://x', args: ['x'] })).toThrow('Command arguments only apply');
    expect(() => admin.buildServerConfig({ stdio: 'a', env: ['NOVALUE'] })).toThrow('Invalid --env "NOVALUE"');
  });
});

describe('editing servers', () => {
  it('adds, enables, disables, allows, disallows and removes', () => {
    const config: Parameters<typeof admin.addServer>[0] = {};
    expect(admin.addServer(config, 'fx', { transport: 'stdio', command: 'node' })).toEqual([]);
    expect(() => admin.addServer(config, 'fx', { transport: 'stdio', command: 'node' })).toThrow('already exists');
    expect(() => admin.addServer(config, 'Bad_Id', { transport: 'stdio', command: 'node' })).toThrow(/server id must match/);

    expect(admin.setServerEnabled(config, 'fx', false).enabled).toBe(false);
    expect(admin.setServerEnabled(config, 'fx', true).enabled).toBeUndefined();

    admin.allowTools(config, 'fx', ['echo', 'add']);
    admin.allowTools(config, 'fx', ['echo']);
    expect(config.mcp?.servers?.fx?.tools?.allow).toEqual(['echo', 'add']);

    config.mcp!.servers!.fx!.tools!.autoApprove = ['echo'];
    admin.disallowTools(config, 'fx', ['echo']);
    expect(config.mcp?.servers?.fx?.tools).toEqual({ allow: ['add'], autoApprove: [] });

    admin.allowTools(config, 'fx', ['*']);
    admin.disallowTools(config, 'fx', ['add']);
    expect(config.mcp?.servers?.fx?.tools?.deny).toEqual(['add']);
    admin.allowTools(config, 'fx', ['add']);
    expect(config.mcp?.servers?.fx?.tools?.deny).toEqual([]);

    admin.removeServer(config, 'fx');
    expect(config.mcp?.servers).toEqual({});
    expect(() => admin.removeServer(config, 'fx')).toThrow('No MCP server named "fx"');
  });

  it('returns literal-secret warnings when adding', () => {
    const warnings = admin.addServer({}, 'gh', {
      transport: 'stdio',
      command: 'npx',
      env: { GITHUB_TOKEN: join2('ghp_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '1234') },
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/GITHUB_TOKEN looks like a literal secret/);
  });

  it('warns when adding an auto-approved tool that is not allowed', () => {
    const warnings = admin.addServer({}, 'docs', admin.buildServerConfig({ http: 'https://x.example/mcp', autoApprove: 'search' }));
    expect(warnings).toEqual([
      `mcp.servers.docs.tools.autoApprove: "search" is not allowed, so the agent can't see it; add it to tools.allow`,
    ]);
  });

  it('keeps ${env:} references literal through a config save', () => {
    const config = loadConfig();
    admin.addServer(config, 'docs', {
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer ${env:DOCS_TOKEN}' },
    });
    process.env.DOCS_TOKEN = join2('docs-token-', 'never-written');
    saveConfig(config);
    const yaml = readFileSync(join(home, 'mercury.yaml'), 'utf-8');
    expect(yaml).toContain('Bearer ${env:DOCS_TOKEN}');
    expect(yaml).not.toContain('never-written');
    expect(loadConfig().mcp?.servers?.docs?.headers).toEqual({ Authorization: 'Bearer ${env:DOCS_TOKEN}' });
    delete process.env.DOCS_TOKEN;
  });
});

describe('formatting', () => {
  it('lists servers with masked literal values', () => {
    const lines = admin.formatServerList({
      mcp: {
        servers: {
          gh: {
            transport: 'stdio',
            command: 'npx',
            args: ['-y', 'server github'],
            env: { GITHUB_TOKEN: '${env:GITHUB_TOKEN}', MODE: 'read-only-mode' },
            tools: { allow: ['search_issues'], autoApprove: ['search_issues'] },
          },
          docs: {
            transport: 'http',
            url: 'https://mcp.example.com/mcp?token=abc',
            headers: { 'X-Key': 'literal-header-value' },
            allowPrivate: true,
            enabled: false,
          },
        },
      },
    });
    expect(lines).toEqual([
      'gh  stdio  enabled  npx -y "server github"',
      '  tools: allow search_issues · auto-approve search_issues',
      '  env: GITHUB_TOKEN=${env:GITHUB_TOKEN}, MODE=read****mode',
      'docs  http  disabled  https://mcp.example.com/mcp',
      '  tools: none allowed',
      '  headers: X-Key=lite****alue',
      '  private network: allowed',
    ]);
    expect(admin.formatServerList({})[0]).toMatch(/^No MCP servers configured/);
  });

  const statuses: McpServerStatus[] = [
    {
      id: 'gh',
      transport: 'stdio',
      enabled: true,
      state: 'connected',
      target: 'npx',
      toolCount: 3,
      tools: [
        { name: 'search_issues', exposedName: 'mcp__gh__search_issues', allowed: true, autoApprove: true },
        { name: 'create_issue', exposedName: 'mcp__gh__create_issue', allowed: false, autoApprove: false },
        { name: 'odd', exposedName: 'mcp__gh__odd', allowed: true, autoApprove: false, skipped: 'input schema is not an object' },
      ],
    },
    { id: 'docs', transport: 'http', enabled: true, state: 'failed', target: 'https://mcp.example.com', error: 'env DOCS_TOKEN is not set', toolCount: 0, tools: [] },
    { id: 'off', transport: 'stdio', enabled: false, state: 'disabled', target: 'node', toolCount: 0, tools: [] },
  ];

  it('summarises server status for /mcp', () => {
    expect(admin.formatMcpChatStatus(statuses, '')).toBe(
      [
        '**MCP servers:**',
        '',
        '• gh: connected, 3 tools, 1 allowed — npx',
        '• docs: failed — env DOCS_TOKEN is not set — https://mcp.example.com',
        '• off: disabled — node',
        '',
        'Details: /mcp tools <server>',
      ].join('\n'),
    );
    expect(admin.formatMcpChatStatus([], '')).toMatch(/^No MCP servers configured/);
  });

  it('lists tools for /mcp tools <server>', () => {
    expect(admin.formatMcpChatStatus(statuses, 'tools gh')).toBe(
      [
        '**gh** tools:',
        '',
        '• search_issues → mcp__gh__search_issues (allowed, auto-approve)',
        '• create_issue → mcp__gh__create_issue (hidden)',
        '• odd → mcp__gh__odd (skipped: input schema is not an object)',
      ].join('\n'),
    );
    expect(admin.formatMcpChatStatus(statuses, 'tools nope')).toBe('Usage: /mcp tools <server>. Servers: gh, docs, off');
  });

  it('quotes stdio arguments that contain spaces', () => {
    expect(admin.formatStdioCommand({ transport: 'stdio', command: 'node', args: ['a b', 'c'] })).toBe('node "a b" c');
  });
});
