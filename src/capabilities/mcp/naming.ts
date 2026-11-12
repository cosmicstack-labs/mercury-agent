import { createHash } from 'node:crypto';

export const MCP_TOOL_PREFIX = 'mcp__';
export const MAX_TOOL_NAME_LENGTH = 64;
export const MCP_LIST_RESOURCES_TOOL = 'list_mcp_resources';
export const MCP_READ_RESOURCE_TOOL = 'read_mcp_resource';

export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX) || name === MCP_LIST_RESOURCES_TOOL || name === MCP_READ_RESOURCE_TOOL;
}

export function sanitizeToolPart(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_-]/g, '_');
  return cleaned || '_';
}

function shortHash(serverId: string, toolName: string): string {
  return createHash('sha256').update(`${serverId}/${toolName}`).digest('hex').slice(0, 6);
}

export function exposedToolName(serverId: string, toolName: string, taken: ReadonlySet<string>): string {
  const base = `${MCP_TOOL_PREFIX}${serverId}__${sanitizeToolPart(toolName)}`;
  if (base.length <= MAX_TOOL_NAME_LENGTH && !taken.has(base)) return base;
  const suffix = `_${shortHash(serverId, toolName)}`;
  return `${base.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length)}${suffix}`;
}
