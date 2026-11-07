import { describe, expect, it } from 'vitest';
import { exposedToolName, isMcpToolName, MAX_TOOL_NAME_LENGTH, sanitizeToolPart } from './naming.js';

describe('MCP tool naming', () => {
  it('prefixes tools with the server id', () => {
    expect(exposedToolName('github', 'search_issues', new Set())).toBe('mcp__github__search_issues');
    expect(isMcpToolName('mcp__github__search_issues')).toBe(true);
    expect(isMcpToolName('read_file')).toBe(false);
  });

  it('replaces characters providers reject', () => {
    expect(sanitizeToolPart('files.read/v2 beta')).toBe('files_read_v2_beta');
    expect(sanitizeToolPart('')).toBe('_');
    expect(exposedToolName('docs', 'get.page', new Set())).toBe('mcp__docs__get_page');
  });

  it('caps long names at 64 characters with a stable hash suffix', () => {
    const long = 'a'.repeat(80);
    const name = exposedToolName('server-with-long-id', long, new Set());
    expect(name.length).toBe(MAX_TOOL_NAME_LENGTH);
    expect(name).toMatch(/^mcp__server-with-long-id__a+_[0-9a-f]{6}$/);
    expect(exposedToolName('server-with-long-id', long, new Set())).toBe(name);
  });

  it('adds a hash when two tools sanitize to the same name', () => {
    const first = exposedToolName('docs', 'get.page', new Set());
    const second = exposedToolName('docs', 'get page', new Set([first]));
    expect(second).not.toBe(first);
    expect(second).toMatch(/^mcp__docs__get_page_[0-9a-f]{6}$/);
  });

  it('is never mistaken for a plugin tool, and no plugin can take the id "mcp"', async () => {
    const { isPluginToolName, pluginToolAllowed } = await import('../../plugins/tool-bridge.js');
    const { RESERVED_PLUGIN_IDS, RESERVED_COMMANDS } = await import('../../plugins/types.js');
    expect(isPluginToolName('mcp__github__search_issues')).toBe(false);
    expect(pluginToolAllowed('mcp__github__search_issues', ['mcp__*', 'mcp__github__search_issues'])).toBe(false);
    expect(isPluginToolName('whatsapp__send_message')).toBe(true);
    expect(RESERVED_PLUGIN_IDS.has('mcp')).toBe(true);
    expect(RESERVED_COMMANDS.has('mcp')).toBe(true);
  });
});
