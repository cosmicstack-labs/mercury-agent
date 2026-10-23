import chalk from 'chalk';
import { formatStatusLine } from './admin.js';
import { validateMcpConfig } from './config.js';
import { DEFAULT_CONNECT_TIMEOUT_MS, probeMcpServer } from './manager.js';
import { describeTarget } from './transport.js';
import type { McpServerConfig, McpServerStatus } from './types.js';

export interface McpReport {
  servers: McpServerStatus[];
  problems: string[];
  warnings: string[];
}

function disabledStatus(id: string, server: McpServerConfig): McpServerStatus {
  return {
    id,
    transport: server.transport,
    enabled: false,
    state: 'disabled',
    target: describeTarget(server),
    toolCount: 0,
    tools: [],
  };
}

export async function collectMcpReport(raw: unknown, timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS): Promise<McpReport> {
  const validation = validateMcpConfig(raw);
  const servers = await Promise.all(
    Object.entries(validation.servers).map(([id, server]) =>
      server.enabled === false ? disabledStatus(id, server) : probeMcpServer(id, server, timeoutMs),
    ),
  );
  return { servers, problems: validation.problems, warnings: validation.warnings };
}

export function mcpReportFailed(report: McpReport): boolean {
  return report.problems.length > 0 || report.servers.some((server) => server.state === 'failed');
}

export function formatMcpReport(report: McpReport): string[] {
  const lines: string[] = ['', chalk.bold('  MCP servers')];
  if (!report.servers.length && !report.problems.length) {
    lines.push(chalk.dim('  No MCP servers configured. Add one with `mercury mcp add`.'), '');
    return lines;
  }
  for (const server of report.servers) {
    const line = formatStatusLine(server);
    if (server.state === 'connected') lines.push(chalk.green(`  ✓ ${line}`));
    else if (server.state === 'disabled') lines.push(chalk.dim(`  - ${line}`));
    else lines.push(chalk.red(`  ✗ ${line}`));
    for (const tool of server.tools.filter((t) => t.skipped)) {
      lines.push(chalk.yellow(`      skipped ${tool.name}: ${tool.skipped}`));
    }
    if (server.state === 'failed' && server.stderrTail) {
      for (const stderrLine of server.stderrTail.trim().split('\n').slice(-10)) {
        lines.push(chalk.dim(`      ${stderrLine}`));
      }
    }
  }
  for (const problem of report.problems) lines.push(chalk.red(`  ✗ ${problem}`));
  for (const warning of report.warnings) lines.push(chalk.yellow(`  ⚠ ${warning}`));
  lines.push('');
  return lines;
}

export function summarizeMcpConfig(raw: unknown): string | null {
  const { servers, problems } = validateMcpConfig(raw);
  const total = Object.keys(servers).length;
  if (!total && !problems.length) return null;
  const enabled = Object.values(servers).filter((server) => server.enabled !== false).length;
  const invalid = problems.length ? `, ${problems.length} invalid` : '';
  return `MCP: ${total} server${total === 1 ? '' : 's'} configured (${enabled} enabled${invalid}). Check them with \`mercury doctor --mcp\`.`;
}

export async function runMcpDoctor(raw: unknown): Promise<{ lines: string[]; ok: boolean }> {
  const report = await collectMcpReport(raw);
  return { lines: formatMcpReport(report), ok: !mcpReportFailed(report) };
}
