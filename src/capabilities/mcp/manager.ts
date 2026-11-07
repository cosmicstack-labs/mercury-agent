import type { Schema, Tool } from 'ai';
import { Client, type Tool as McpTool } from '@modelcontextprotocol/client';
import { logger } from '../../utils/logger.js';
import { redactSecrets } from '../../utils/redact.js';
import { resolveSecrets } from './config.js';
import { exposedToolName } from './naming.js';
import { toInputSchema } from './schema.js';
import { buildMcpTool } from './tool.js';
import { createTransport, describeTarget } from './transport.js';
import type { McpCallResultLike } from './result.js';
import type { McpGate, McpServerConfig, McpServerState, McpServerStatus, McpToolStatus } from './types.js';

export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
export const DEFAULT_CALL_TIMEOUT_MS = 60_000;
export const CLOSE_TIMEOUT_MS = 3_000;

export interface McpBackoff {
  initialMs: number;
  maxMs: number;
  maxAttempts: number;
  stableMs: number;
}

const DEFAULT_BACKOFF: McpBackoff = { initialMs: 1_000, maxMs: 300_000, maxAttempts: 10, stableMs: 60_000 };

export interface McpManagerOptions {
  gate: McpGate;
  onToolsChanged?: () => void;
  connectTimeoutMs?: number;
  backoff?: Partial<McpBackoff>;
}

interface DescribedTool {
  status: McpToolStatus;
  description?: string;
  schema?: Schema<Record<string, unknown>>;
}

interface ToolEntry extends McpToolStatus {
  tool?: Tool;
}

interface ServerEntry {
  id: string;
  config: McpServerConfig;
  state: McpServerState;
  error?: string;
  client?: Client;
  stderrTail: () => string;
  tools: ToolEntry[];
  attempts: number;
  connectedAt?: number;
  generation: number;
  timer?: ReturnType<typeof setTimeout>;
}

function clientInfo(): { name: string; version: string } {
  const version = (globalThis as { __MERCURY_VERSION__?: string }).__MERCURY_VERSION__ ?? '0.0.0';
  return { name: 'mercury', version };
}

function errorMessage(err: unknown): string {
  const data = (err as { data?: { status?: unknown; statusText?: unknown; text?: unknown } } | null)?.data;
  if (data && typeof data.status === 'number') {
    const statusText = typeof data.statusText === 'string' && data.statusText ? ` ${data.statusText}` : '';
    const body = typeof data.text === 'string' && data.text.trim() ? `: ${data.text.trim().slice(0, 200)}` : '';
    return redactSecrets(`HTTP ${data.status}${statusText}${body}`);
  }
  return redactSecrets(err instanceof Error ? err.message : String(err));
}

const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

function isConnectionError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    const { code, message, cause } = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof code === 'string' && CONNECTION_ERROR_CODES.has(code)) return true;
    if (message === 'fetch failed') return true;
    current = cause;
  }
  return false;
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function closeQuietly(client: Client): Promise<void> {
  try {
    await withTimeout(client.close(), CLOSE_TIMEOUT_MS, 'close');
  } catch {
    return;
  }
}

export function isToolAllowed(config: McpServerConfig, toolName: string): boolean {
  const filter = config.tools ?? {};
  if (filter.deny?.includes(toolName)) return false;
  return filter.allow?.includes('*') === true || filter.allow?.includes(toolName) === true;
}

export function isToolAutoApproved(config: McpServerConfig, toolName: string): boolean {
  return config.tools?.autoApprove?.includes(toolName) === true;
}

export function describeTools(serverId: string, config: McpServerConfig, tools: McpTool[]): DescribedTool[] {
  const taken = new Set<string>();
  const seen = new Set<string>();
  const described: DescribedTool[] = [];
  for (const tool of tools) {
    if (seen.has(tool.name)) continue;
    seen.add(tool.name);
    const exposedName = exposedToolName(serverId, tool.name, taken);
    taken.add(exposedName);
    const schema = toInputSchema(tool.inputSchema);
    described.push({
      status: {
        name: tool.name,
        exposedName,
        allowed: isToolAllowed(config, tool.name),
        autoApprove: isToolAutoApproved(config, tool.name),
        skipped: 'skip' in schema ? schema.skip : undefined,
      },
      description: tool.description,
      schema: 'schema' in schema ? schema.schema : undefined,
    });
  }
  return described;
}

function baseStatus(id: string, config: McpServerConfig): Omit<McpServerStatus, 'state'> {
  return {
    id,
    transport: config.transport,
    enabled: config.enabled !== false,
    target: describeTarget(config),
    toolCount: 0,
    tools: [],
  };
}

export async function probeMcpServer(
  id: string,
  config: McpServerConfig,
  timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
): Promise<McpServerStatus> {
  let stderrTail = (): string => '';
  const client = new Client(clientInfo());
  try {
    const created = createTransport(config, resolveSecrets(config));
    stderrTail = created.stderrTail;
    await withTimeout(client.connect(created.transport), timeoutMs, 'connect');
    const { tools } = await withTimeout(client.listTools(), timeoutMs, 'tools/list');
    const statuses = describeTools(id, config, tools).map((d) => d.status);
    return { ...baseStatus(id, config), state: 'connected', toolCount: statuses.length, tools: statuses };
  } catch (err) {
    return {
      ...baseStatus(id, config),
      state: 'failed',
      error: errorMessage(err),
      stderrTail: stderrTail() || undefined,
    };
  } finally {
    await closeQuietly(client);
  }
}

export class McpManager {
  private readonly servers = new Map<string, ServerEntry>();
  private readonly connectTimeoutMs: number;
  private readonly backoff: McpBackoff;
  private closed = false;

  constructor(servers: Record<string, McpServerConfig>, private readonly options: McpManagerOptions) {
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.backoff = { ...DEFAULT_BACKOFF, ...options.backoff };
    for (const [id, config] of Object.entries(servers)) {
      this.servers.set(id, {
        id,
        config,
        state: config.enabled === false ? 'disabled' : 'connecting',
        stderrTail: () => '',
        tools: [],
        attempts: 0,
        generation: 0,
      });
    }
  }

  async connectAll(): Promise<void> {
    const pending = [...this.servers.values()].filter((entry) => entry.state !== 'disabled');
    await Promise.allSettled(pending.map((entry) => this.connect(entry)));
  }

  getTools(): Record<string, Tool> {
    const tools: Record<string, Tool> = {};
    for (const entry of this.servers.values()) {
      if (entry.state !== 'connected' && entry.state !== 'reconnecting') continue;
      for (const tool of entry.tools) {
        if (tool.tool) tools[tool.exposedName] = tool.tool;
      }
    }
    return tools;
  }

  isAutoApproved(exposedName: string): boolean {
    for (const entry of this.servers.values()) {
      const tool = entry.tools.find((t) => t.exposedName === exposedName);
      if (tool) return tool.autoApprove;
    }
    return false;
  }

  status(): McpServerStatus[] {
    return [...this.servers.values()].map((entry) => ({
      ...baseStatus(entry.id, entry.config),
      state: entry.state,
      error: entry.error,
      toolCount: entry.tools.length,
      tools: entry.tools.map((tool) => ({
        name: tool.name,
        exposedName: tool.exposedName,
        allowed: tool.allowed,
        autoApprove: tool.autoApprove,
        skipped: tool.skipped,
      })),
      stderrTail: entry.stderrTail() || undefined,
    }));
  }

  async testServer(id: string): Promise<McpServerStatus | undefined> {
    const entry = this.servers.get(id);
    return entry ? probeMcpServer(id, entry.config, this.connectTimeoutMs) : undefined;
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(
      [...this.servers.values()].map(async (entry) => {
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = undefined;
        entry.generation++;
        const client = entry.client;
        entry.client = undefined;
        entry.tools = [];
        if (entry.state !== 'disabled') {
          entry.state = 'failed';
          entry.error = 'manager closed';
        }
        if (client) await closeQuietly(client);
      }),
    );
  }

  private async connect(entry: ServerEntry): Promise<void> {
    if (this.closed) return;
    entry.timer = undefined;
    const generation = ++entry.generation;
    let created;
    try {
      created = createTransport(entry.config, resolveSecrets(entry.config));
    } catch (err) {
      this.fail(entry, errorMessage(err));
      return;
    }
    entry.stderrTail = created.stderrTail;
    const client = new Client(clientInfo(), {
      listChanged: {
        tools: {
          onChanged: (err, tools) => {
            if (entry.generation !== generation) return;
            if (err) {
              logger.warn({ server: entry.id, err: errorMessage(err) }, 'MCP tool list refresh failed');
              return;
            }
            if (tools) this.applyTools(entry, tools);
          },
        },
      },
    });
    let established = false;
    client.onclose = () => {
      if (established) this.scheduleReconnect(entry, 'connection closed', generation);
    };
    try {
      await withTimeout(client.connect(created.transport), this.connectTimeoutMs, 'connect');
      const { tools } = await withTimeout(client.listTools(), this.connectTimeoutMs, 'tools/list');
      if (entry.generation !== generation || this.closed) {
        await closeQuietly(client);
        return;
      }
      established = true;
      entry.client = client;
      entry.state = 'connected';
      entry.error = undefined;
      entry.connectedAt = Date.now();
      this.applyTools(entry, tools);
      logger.info({ server: entry.id, tools: entry.tools.length }, 'MCP server connected');
    } catch (err) {
      this.scheduleReconnect(entry, errorMessage(err), generation);
      await closeQuietly(client);
    }
  }

  private scheduleReconnect(entry: ServerEntry, reason: string, generation: number): void {
    if (this.closed || entry.generation !== generation) return;
    entry.generation++;
    const client = entry.client;
    entry.client = undefined;
    if (client) void closeQuietly(client);
    entry.error = reason;
    if (entry.connectedAt !== undefined && Date.now() - entry.connectedAt >= this.backoff.stableMs) entry.attempts = 0;
    entry.connectedAt = undefined;
    entry.attempts++;
    if (entry.attempts > this.backoff.maxAttempts) {
      this.fail(entry, `${reason} (gave up after ${this.backoff.maxAttempts} attempts)`);
      return;
    }
    entry.state = 'reconnecting';
    const base = Math.min(this.backoff.maxMs, this.backoff.initialMs * 2 ** (entry.attempts - 1));
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    logger.warn({ server: entry.id, attempt: entry.attempts, delayMs: delay, reason }, 'MCP server unavailable, retrying');
    entry.timer = setTimeout(() => void this.connect(entry), delay);
    entry.timer.unref?.();
  }

  private fail(entry: ServerEntry, reason: string): void {
    entry.state = 'failed';
    entry.error = reason;
    entry.client = undefined;
    logger.warn({ server: entry.id, reason }, 'MCP server failed');
    if (entry.tools.length) {
      entry.tools = [];
      this.options.onToolsChanged?.();
    }
  }

  private applyTools(entry: ServerEntry, tools: McpTool[]): void {
    entry.tools = describeTools(entry.id, entry.config, tools).map(({ status, description, schema }) => {
      if (status.skipped) {
        logger.warn({ server: entry.id, tool: status.name, reason: status.skipped }, 'MCP tool skipped');
      }
      const tool =
        status.allowed && schema
          ? buildMcpTool({
              serverId: entry.id,
              toolName: status.name,
              exposedName: status.exposedName,
              description,
              inputSchema: schema,
              autoApprove: status.autoApprove,
              gate: this.options.gate,
              call: (name, args, signal) => this.call(entry, name, args, signal),
            })
          : undefined;
      return { ...status, tool };
    });
    this.options.onToolsChanged?.();
  }

  private async call(
    entry: ServerEntry,
    toolName: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<McpCallResultLike> {
    const client = entry.client;
    if (!client || entry.state !== 'connected') {
      throw new Error(`server ${entry.id} is ${entry.state}`);
    }
    const generation = entry.generation;
    try {
      return await client.callTool(
        { name: toolName, arguments: args },
        { signal, timeout: entry.config.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS },
      );
    } catch (err) {
      if (isConnectionError(err)) this.scheduleReconnect(entry, errorMessage(err), generation);
      throw err;
    }
  }
}
