import { redactSecrets } from '../../utils/redact.js';
import { validateMcpConfig } from './config.js';
import type { McpConfig, McpServerConfig, McpServerStatus } from './types.js';

export interface ConfigWithMcp {
  mcp?: McpConfig;
}

export interface AddServerOptions {
  stdio?: string;
  http?: string;
  args?: string[];
  env?: string[];
  header?: string[];
  cwd?: string;
  allow?: string;
  autoApprove?: string;
  allowPrivate?: boolean;
  disabled?: boolean;
}

const ENV_REF = /\$\{env:[A-Za-z_][A-Za-z0-9_]*\}/;

export function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parsePairs(entries: string[] | undefined, separator: '=' | ':', label: string): Record<string, string> | undefined {
  if (!entries?.length) return undefined;
  const out: Record<string, string> = {};
  for (const entry of entries) {
    const index = entry.indexOf(separator);
    const key = index > 0 ? entry.slice(0, index).trim() : '';
    if (!key) throw new Error(`Invalid ${label} "${entry}": expected NAME${separator}value`);
    out[key] = entry.slice(index + 1).trim();
  }
  return out;
}

export function buildServerConfig(options: AddServerOptions): McpServerConfig {
  if (Boolean(options.stdio) === Boolean(options.http)) {
    throw new Error('Pass exactly one of --stdio <command> or --http <url>');
  }
  const allow = splitList(options.allow);
  const autoApprove = splitList(options.autoApprove);
  const tools = allow.length || autoApprove.length ? { allow, autoApprove } : undefined;
  const enabled = options.disabled ? false : undefined;
  if (options.stdio) {
    if (options.header?.length) throw new Error('--header only applies to --http servers');
    if (options.allowPrivate) throw new Error('--allow-private only applies to --http servers');
    return stripUndefined({
      transport: 'stdio',
      command: options.stdio,
      args: options.args?.length ? options.args : undefined,
      env: parsePairs(options.env, '=', '--env'),
      cwd: options.cwd,
      enabled,
      tools,
    });
  }
  if (options.args?.length) throw new Error('Command arguments only apply to --stdio servers');
  if (options.env?.length) throw new Error('--env only applies to --stdio servers');
  if (options.cwd) throw new Error('--cwd only applies to --stdio servers');
  return stripUndefined({
    transport: 'http',
    url: options.http,
    headers: parsePairs(options.header, ':', '--header'),
    allowPrivate: options.allowPrivate ? true : undefined,
    enabled,
    tools,
  });
}

function stripUndefined(server: McpServerConfig): McpServerConfig {
  return Object.fromEntries(Object.entries(server).filter(([, value]) => value !== undefined)) as unknown as McpServerConfig;
}

function servers(config: ConfigWithMcp): Record<string, McpServerConfig> {
  if (!config.mcp) config.mcp = {};
  if (!config.mcp.servers) config.mcp.servers = {};
  return config.mcp.servers;
}

export function getServer(config: ConfigWithMcp, id: string): McpServerConfig {
  const server = config.mcp?.servers?.[id];
  if (!server) throw new Error(`No MCP server named "${id}". Run \`mercury mcp list\` to see configured servers.`);
  return server;
}

export function addServer(config: ConfigWithMcp, id: string, server: McpServerConfig): string[] {
  if (config.mcp?.servers?.[id]) throw new Error(`An MCP server named "${id}" already exists`);
  const validation = validateMcpConfig({ servers: { [id]: server } });
  if (validation.problems.length) throw new Error(validation.problems[0]);
  servers(config)[id] = server;
  return validation.warnings;
}

export function removeServer(config: ConfigWithMcp, id: string): void {
  getServer(config, id);
  delete servers(config)[id];
}

export function setServerEnabled(config: ConfigWithMcp, id: string, enabled: boolean): McpServerConfig {
  const server = getServer(config, id);
  if (enabled) delete server.enabled;
  else server.enabled = false;
  return server;
}

export function allowTools(config: ConfigWithMcp, id: string, tools: string[]): McpServerConfig {
  const server = getServer(config, id);
  const filter = (server.tools ??= {});
  filter.allow = [...new Set([...(filter.allow ?? []), ...tools])];
  if (filter.deny) filter.deny = filter.deny.filter((tool) => !tools.includes(tool));
  return server;
}

export function disallowTools(config: ConfigWithMcp, id: string, tools: string[]): McpServerConfig {
  const server = getServer(config, id);
  const filter = (server.tools ??= {});
  const wildcard = filter.allow?.includes('*') === true;
  filter.allow = (filter.allow ?? []).filter((tool) => !tools.includes(tool));
  if (filter.autoApprove) filter.autoApprove = filter.autoApprove.filter((tool) => !tools.includes(tool));
  const stillWildcard = wildcard && filter.allow.includes('*');
  const named = tools.filter((tool) => tool !== '*');
  if (stillWildcard && named.length) {
    filter.deny = [...new Set([...(filter.deny ?? []), ...named])];
  }
  return server;
}

export function maskValue(value: string): string {
  if (ENV_REF.test(value)) return redactSecrets(value);
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

function quoteArg(arg: string): string {
  return /[\s"']/.test(arg) ? JSON.stringify(arg) : arg;
}

export function formatStdioCommand(server: McpServerConfig): string {
  return [server.command ?? '', ...(server.args ?? [])].map(quoteArg).join(' ');
}

function formatTarget(server: McpServerConfig): string {
  if (server.transport === 'stdio') return redactSecrets(formatStdioCommand(server));
  try {
    const url = new URL(server.url ?? '');
    return `${url.origin}${url.pathname}`;
  } catch {
    return '(invalid url)';
  }
}

function formatPairs(values: Record<string, string> | undefined): string {
  return Object.entries(values ?? {})
    .map(([key, value]) => `${key}=${maskValue(value)}`)
    .join(', ');
}

export function formatServerList(config: ConfigWithMcp): string[] {
  const entries = Object.entries(config.mcp?.servers ?? {});
  if (!entries.length) return ['No MCP servers configured. Add one with `mercury mcp add <id> --stdio <command>` or `--http <url>`.'];
  const lines: string[] = [];
  for (const [id, server] of entries) {
    const state = server.enabled === false ? 'disabled' : 'enabled';
    lines.push(`${id}  ${server.transport}  ${state}  ${formatTarget(server)}`);
    const allow = server.tools?.allow ?? [];
    const deny = server.tools?.deny ?? [];
    const autoApprove = server.tools?.autoApprove ?? [];
    lines.push(`  tools: ${allow.length ? `allow ${allow.join(', ')}` : 'none allowed'}`
      + (deny.length ? ` · deny ${deny.join(', ')}` : '')
      + (autoApprove.length ? ` · auto-approve ${autoApprove.join(', ')}` : ''));
    if (server.env && Object.keys(server.env).length) lines.push(`  env: ${formatPairs(server.env)}`);
    if (server.headers && Object.keys(server.headers).length) lines.push(`  headers: ${formatPairs(server.headers)}`);
    if (server.allowPrivate) lines.push('  private network: allowed');
  }
  return lines;
}

export function formatStatusLine(status: McpServerStatus): string {
  const target = status.target ? ` — ${status.target}` : '';
  if (status.state === 'disabled') return `${status.id}: disabled${target}`;
  if (status.state === 'failed') return `${status.id}: failed — ${status.error ?? 'unknown error'}${target}`;
  if (status.state === 'connecting') return `${status.id}: connecting${target}`;
  const allowed = status.tools.filter((tool) => tool.allowed && !tool.skipped).length;
  const prefix = status.state === 'reconnecting' ? `reconnecting (${status.error ?? 'connection lost'})` : 'connected';
  return `${status.id}: ${prefix}, ${status.toolCount} tools, ${allowed} allowed${target}`;
}

export function formatToolLines(status: McpServerStatus): string[] {
  if (!status.tools.length) return ['(no tools reported)'];
  return status.tools.map((tool) => {
    const state = tool.skipped
      ? `skipped: ${tool.skipped}`
      : tool.allowed
        ? tool.autoApprove
          ? 'allowed, auto-approve'
          : 'allowed'
        : 'hidden';
    return `${tool.name} → ${tool.exposedName} (${state})`;
  });
}

export function formatMcpChatStatus(statuses: McpServerStatus[], args: string): string {
  if (!statuses.length) {
    return 'No MCP servers configured. Add one from the terminal with `mercury mcp add`.';
  }
  const [sub, id] = args.split(/\s+/).filter(Boolean);
  if (sub === 'tools') {
    const status = statuses.find((s) => s.id === id);
    if (!id || !status) return `Usage: /mcp tools <server>. Servers: ${statuses.map((s) => s.id).join(', ')}`;
    return [`**${status.id}** tools:`, '', ...formatToolLines(status).map((line) => `• ${line}`)].join('\n');
  }
  return ['**MCP servers:**', '', ...statuses.map((status) => `• ${formatStatusLine(status)}`), '', 'Details: /mcp tools <server>'].join('\n');
}
