import { describe, expect, it } from 'vitest';
import { redactSecrets } from '../../utils/redact.js';
import { resolveSecrets, validateMcpConfig } from './config.js';

const join = (...parts: string[]) => parts.join('');

describe('validateMcpConfig', () => {
  it('treats a missing section as no servers', () => {
    expect(validateMcpConfig(undefined)).toEqual({ servers: {}, problems: [], warnings: [] });
    expect(validateMcpConfig({})).toEqual({ servers: {}, problems: [], warnings: [] });
  });

  it('accepts stdio and http servers', () => {
    const result = validateMcpConfig({
      servers: {
        github: {
          transport: 'stdio',
          command: 'npx',
          args: ['-y', 'server-github'],
          env: { GITHUB_TOKEN: '${env:GITHUB_TOKEN}' },
          tools: { allow: ['search_issues'], autoApprove: ['search_issues'] },
        },
        docs: {
          transport: 'http',
          url: 'https://mcp.example.com/mcp',
          headers: { Authorization: 'Bearer ${env:DOCS_TOKEN}' },
          enabled: false,
        },
      },
    });
    expect(result.problems).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(Object.keys(result.servers)).toEqual(['github', 'docs']);
  });

  it('drops invalid servers with a reason and keeps the rest', () => {
    const result = validateMcpConfig({
      servers: {
        Bad_Id: { transport: 'stdio', command: 'x' },
        nocommand: { transport: 'stdio' },
        ftp: { transport: 'http', url: 'ftp://example.com/mcp' },
        typo: { transport: 'stdio', command: 'x', comand: 'y' },
        unknown: { transport: 'sse', url: 'https://example.com' },
        good: { transport: 'stdio', command: 'node' },
      },
    });
    expect(Object.keys(result.servers)).toEqual(['good']);
    expect(result.problems).toHaveLength(5);
    expect(result.problems[0]).toMatch(/^mcp\.servers\.Bad_Id: server id must match/);
    expect(result.problems[1]).toMatch(/^mcp\.servers\.nocommand\.command: /);
    expect(result.problems[2]).toMatch(/^mcp\.servers\.ftp\.url: url must use http or https/);
    expect(result.problems[3]).toMatch(/^mcp\.servers\.typo: /);
    expect(result.problems[4]).toMatch(/^mcp\.servers\.unknown\.transport: /);
  });

  it('rejects a non-mapping section', () => {
    expect(validateMcpConfig('nope').problems).toEqual(['mcp: expected a mapping with a "servers" key']);
    expect(validateMcpConfig({ servers: [] }).problems).toEqual([
      'mcp.servers: expected a mapping of server id to server settings',
    ]);
  });

  it('warns about literal secrets in env and headers', () => {
    const result = validateMcpConfig({
      servers: {
        gh: {
          transport: 'stdio',
          command: 'npx',
          env: { GITHUB_TOKEN: join('ghp_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '1234') },
        },
        docs: {
          transport: 'http',
          url: 'https://mcp.example.com/mcp',
          headers: { Authorization: join('Bearer ', 'abcdefghijklmnopqrstuvwxyz0123456789') },
        },
      },
    });
    expect(result.warnings).toEqual([
      'mcp.servers.gh.env.GITHUB_TOKEN looks like a literal secret; use "${env:NAME}" and keep the value in .env',
      'mcp.servers.docs.headers.Authorization looks like a literal secret; use "${env:NAME}" and keep the value in .env',
    ]);
  });
});

describe('autoApprove warnings', () => {
  it('warns when an auto-approved tool is not allowed or is denied', () => {
    const result = validateMcpConfig({
      servers: {
        hidden: { transport: 'stdio', command: 'x', tools: { autoApprove: ['search'] } },
        denied: { transport: 'stdio', command: 'x', tools: { allow: ['*'], deny: ['search'], autoApprove: ['search'] } },
        fine: { transport: 'stdio', command: 'x', tools: { allow: ['search'], autoApprove: ['search'] } },
        wildcard: { transport: 'stdio', command: 'x', tools: { allow: ['*'], autoApprove: ['search'] } },
      },
    });
    expect(result.warnings).toEqual([
      `mcp.servers.hidden.tools.autoApprove: "search" is not allowed, so the agent can't see it; add it to tools.allow`,
      `mcp.servers.denied.tools.autoApprove: "search" is in tools.deny, so the agent can't see it; remove it from tools.deny`,
    ]);
  });
});

describe('resolveSecrets', () => {
  it('expands env references in args, env and headers and registers the values', () => {
    const token = join('resolved-token-', 'value-0001');
    const resolved = resolveSecrets(
      {
        transport: 'stdio',
        command: 'node',
        args: ['--token=${env:MCP_T}'],
        env: { TOKEN: '${env:MCP_T}', PLAIN: 'yes' },
        headers: { Authorization: 'Bearer ${env:MCP_T}' },
      },
      { MCP_T: token },
    );
    expect(resolved).toEqual({
      args: [`--token=${token}`],
      env: { TOKEN: token, PLAIN: 'yes' },
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(redactSecrets(`leak ${token}`)).toBe('leak ****');
  });

  it('fails when a referenced variable is missing or empty', () => {
    expect(() => resolveSecrets({ transport: 'stdio', command: 'x', env: { A: '${env:MISSING_ONE}' } }, {})).toThrow(
      'env MISSING_ONE is not set',
    );
    expect(() => resolveSecrets({ transport: 'stdio', command: 'x', args: ['${env:EMPTY}'] }, { EMPTY: '' })).toThrow(
      'env EMPTY is not set',
    );
  });
});
