import { afterEach, describe, expect, it } from 'vitest';
import app, { setMcpManager } from './mcp.js';
import type { McpManager } from '../../capabilities/mcp/manager.js';
import type { McpServerStatus } from '../../capabilities/mcp/types.js';

const status: McpServerStatus = {
  id: 'docs',
  transport: 'http',
  enabled: true,
  state: 'failed',
  target: 'https://mcp.example.com',
  error: 'HTTP 401',
  toolCount: 1,
  tools: [{ name: 'search', exposedName: 'mcp__docs__search', allowed: true, autoApprove: false }],
  stderrTail: 'server log line that must stay local',
};

afterEach(() => setMcpManager(null));

describe('GET /api/mcp', () => {
  it('reports no servers when MCP is not running in this process', async () => {
    const res = await app.request('/api/mcp');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: false, servers: [] });
  });

  it('returns only the public status fields', async () => {
    setMcpManager({ status: () => [status] } as unknown as McpManager);
    const body = await (await app.request('/api/mcp')).json();
    expect(body).toEqual({
      available: true,
      servers: [
        {
          id: 'docs',
          transport: 'http',
          enabled: true,
          state: 'failed',
          target: 'https://mcp.example.com',
          error: 'HTTP 401',
          toolCount: 1,
          tools: [{ name: 'search', exposedName: 'mcp__docs__search', allowed: true, autoApprove: false, skipped: null }],
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain('server log line');
  });
});
