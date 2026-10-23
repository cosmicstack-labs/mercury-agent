import { Hono } from 'hono';
import type { McpManager } from '../../capabilities/mcp/manager.js';
import type { McpServerStatus } from '../../capabilities/mcp/types.js';

const mcp = new Hono();
let manager: McpManager | null = null;

export function setMcpManager(next: McpManager | null): void {
  manager = next;
}

export function toPublicMcpStatus(status: McpServerStatus) {
  return {
    id: status.id,
    transport: status.transport,
    enabled: status.enabled,
    state: status.state,
    target: status.target,
    error: status.error ?? null,
    toolCount: status.toolCount,
    tools: status.tools.map((tool) => ({
      name: tool.name,
      exposedName: tool.exposedName,
      allowed: tool.allowed,
      autoApprove: tool.autoApprove,
      skipped: tool.skipped ?? null,
    })),
  };
}

mcp.get('/api/mcp', (c) => {
  const servers = manager ? manager.status().map(toPublicMcpStatus) : [];
  return c.json({ available: manager !== null, servers });
});

export default mcp;
