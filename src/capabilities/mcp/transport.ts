import { basename } from 'node:path';
import { StreamableHTTPClientTransport, type Transport } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { createGuardedFetch } from '../../utils/ssrf.js';
import { redactSecrets } from '../../utils/redact.js';
import type { ResolvedSecrets } from './config.js';
import type { McpServerConfig } from './types.js';

export const STDERR_TAIL_CHARS = 8 * 1024;
const STDERR_RAW_CHARS = 2 * STDERR_TAIL_CHARS;

export function appendStderr(raw: string, chunk: string): string {
  return (raw + chunk).slice(-STDERR_RAW_CHARS);
}

export function renderStderrTail(raw: string): string {
  let text = raw;
  if (raw.length >= STDERR_RAW_CHARS) {
    const newline = text.indexOf('\n');
    if (newline !== -1) text = text.slice(newline + 1);
  }
  return redactSecrets(text).slice(-STDERR_TAIL_CHARS);
}

export interface CreatedTransport {
  transport: Transport;
  stderrTail: () => string;
}

export function describeTarget(server: McpServerConfig): string {
  if (server.transport === 'stdio') return basename(server.command ?? '');
  try {
    return new URL(server.url ?? '').origin;
  } catch {
    return '';
  }
}

function createStdioTransport(server: McpServerConfig, resolved: ResolvedSecrets): CreatedTransport {
  const transport = new StdioClientTransport({
    command: server.command ?? '',
    args: resolved.args,
    cwd: server.cwd,
    env: { ...getDefaultEnvironment(), ...resolved.env },
    stderr: 'pipe',
  });
  let raw = '';
  transport.stderr?.on('data', (chunk: Buffer | string) => {
    raw = appendStderr(raw, chunk.toString());
  });
  return { transport, stderrTail: () => renderStderrTail(raw) };
}

function createHttpTransport(server: McpServerConfig, resolved: ResolvedSecrets): CreatedTransport {
  const transport = new StreamableHTTPClientTransport(new URL(server.url ?? ''), {
    fetch: createGuardedFetch({
      allowPrivate: server.allowPrivate === true,
      privateHint: 'Set allowPrivate: true for this MCP server (or add it with --allow-private) if you trust it.',
    }),
    requestInit: { headers: resolved.headers },
    redirectPolicy: 'same-origin',
  });
  return { transport, stderrTail: () => '' };
}

export function createTransport(server: McpServerConfig, resolved: ResolvedSecrets): CreatedTransport {
  return server.transport === 'stdio' ? createStdioTransport(server, resolved) : createHttpTransport(server, resolved);
}
