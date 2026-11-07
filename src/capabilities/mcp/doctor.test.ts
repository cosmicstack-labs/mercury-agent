import { describe, expect, it } from 'vitest';
import chalk from 'chalk';
import { fileURLToPath } from 'node:url';
import { collectMcpReport, formatMcpReport, mcpReportFailed, summarizeMcpConfig } from './doctor.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-fixture-server.mjs', import.meta.url));
chalk.level = 0;

describe('mercury doctor --mcp', () => {
  it('probes enabled servers and reports each state', async () => {
    const report = await collectMcpReport(
      {
        servers: {
          fx: { transport: 'stdio', command: process.execPath, args: [FIXTURE], tools: { allow: ['echo'] } },
          nokey: { transport: 'stdio', command: process.execPath, args: [FIXTURE], env: { T: '${env:MCP_DOCTOR_UNSET}' } },
          off: { transport: 'stdio', command: 'node', enabled: false },
          Broken: { transport: 'stdio', command: 'node' },
        },
      },
      5_000,
    );
    expect(report.servers.map((s) => [s.id, s.state])).toEqual([
      ['fx', 'connected'],
      ['nokey', 'failed'],
      ['off', 'disabled'],
    ]);
    expect(mcpReportFailed(report)).toBe(true);

    const lines = formatMcpReport(report);
    expect(lines).toContain('  ✓ fx: connected, 8 tools, 1 allowed — node' + (process.platform === 'win32' ? '.exe' : ''));
    expect(lines).toContain('  ✗ nokey: failed — env MCP_DOCTOR_UNSET is not set — node' + (process.platform === 'win32' ? '.exe' : ''));
    expect(lines).toContain('  - off: disabled — node');
    expect(lines.some((line) => line.startsWith('  ✗ mcp.servers.Broken: server id must match'))).toBe(true);
  }, 30_000);

  it('passes when everything connects and says so when nothing is configured', async () => {
    const report = await collectMcpReport(undefined);
    expect(mcpReportFailed(report)).toBe(false);
    expect(formatMcpReport(report)).toContain('  No MCP servers configured. Add one with `mercury mcp add`.');
  });

  it('summarizes the configuration without connecting', () => {
    expect(summarizeMcpConfig(undefined)).toBeNull();
    expect(
      summarizeMcpConfig({
        servers: {
          a: { transport: 'stdio', command: 'x' },
          b: { transport: 'stdio', command: 'x', enabled: false },
          Bad: { transport: 'stdio', command: 'x' },
        },
      }),
    ).toBe('MCP: 2 servers configured (1 enabled, 1 invalid). Check them with `mercury doctor --mcp`.');
  });
});
