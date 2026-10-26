import { z } from 'zod';
import { redactSecrets, registerSecretValue } from '../../utils/redact.js';
import type { McpServerConfig } from './types.js';

export const SERVER_ID_PATTERN = /^[a-z][a-z0-9-]{0,23}$/;

const ENV_REF = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

const toolNames = z.array(z.string().min(1)).optional();

const shared = {
  enabled: z.boolean().optional(),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
  tools: z
    .object({ allow: toolNames, deny: toolNames, autoApprove: toolNames })
    .strict()
    .optional(),
};

const stdioServer = z
  .object({
    transport: z.literal('stdio'),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
    cwd: z.string().min(1).optional(),
    ...shared,
  })
  .strict();

const httpServer = z
  .object({
    transport: z.literal('http'),
    url: z
      .string()
      .url()
      .refine((value) => /^https?:\/\//i.test(value), 'url must use http or https'),
    headers: z.record(z.string()).optional(),
    allowPrivate: z.boolean().optional(),
    ...shared,
  })
  .strict();

const serverSchema = z.discriminatedUnion('transport', [stdioServer, httpServer]);

export interface McpConfigValidation {
  servers: Record<string, McpServerConfig>;
  problems: string[];
  warnings: string[];
}

function formatIssue(id: string, issue: z.ZodIssue): string {
  const path = issue.path.length ? `.${issue.path.join('.')}` : '';
  return `mcp.servers.${id}${path}: ${issue.message}`;
}

function literalSecretWarnings(id: string, field: 'env' | 'headers', values: Record<string, string> | undefined): string[] {
  if (!values) return [];
  const warnings: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    const withoutRefs = value.replace(ENV_REF, '');
    if (withoutRefs !== value && !withoutRefs.trim()) continue;
    if (redactSecrets(withoutRefs) !== withoutRefs) {
      warnings.push(`mcp.servers.${id}.${field}.${key} looks like a literal secret; use "\${env:NAME}" and keep the value in .env`);
    }
  }
  return warnings;
}

/**
 * Mercury's own credentials. `${env:NAME}` can read any variable, so a server
 * config naming one of these would hand it to a third-party server: allowed
 * (it may be deliberate), but always called out.
 */
const MERCURY_OWN_SECRETS = new Set([
  'AIMLAPI_API_KEY', 'ANTHROPIC_API_KEY', 'ATLASCLOUD_API_KEY', 'BOTS_WEBHOOK_SECRET', 'DEEPSEEK_API_KEY',
  'DISCORD_BOT_TOKEN', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GROK_API_KEY', 'LITELLM_API_KEY', 'LM_STUDIO_API_KEY',
  'MERCURY_CLOUD_ACCESS_KEY', 'MERCURY_CLOUD_AGENT_API_KEY', 'MERCURY_CLOUD_REFRESH_TOKEN', 'MIMO_API_KEY',
  'MIMO_TOKEN_PLAN_API_KEY', 'OLLAMA_CLOUD_API_KEY', 'OPENAI_API_KEY', 'OPENAI_COMPAT_API_KEY', 'OPENROUTER_API_KEY',
  'SLACK_APP_TOKEN', 'SLACK_BOT_TOKEN', 'SPOTIFY_CLIENT_SECRET', 'TELEGRAM_BOT_TOKEN',
]);

function ownSecretWarnings(id: string, server: McpServerConfig): string[] {
  const values = [...(server.args ?? []), ...Object.values(server.env ?? {}), ...Object.values(server.headers ?? {})];
  const named = new Set<string>();
  for (const value of values) {
    for (const match of value.matchAll(ENV_REF)) if (MERCURY_OWN_SECRETS.has(match[1])) named.add(match[1]);
  }
  return [...named].map((name) => `mcp.servers.${id} is given ${name}, one of Mercury's own keys; the server "${id}" will see it. Use a separate key unless you mean this.`);
}

function hiddenAutoApproveWarnings(id: string, server: McpServerConfig): string[] {
  const allow = server.tools?.allow ?? [];
  const deny = server.tools?.deny ?? [];
  const prefix = `mcp.servers.${id}.tools.autoApprove`;
  return (server.tools?.autoApprove ?? []).flatMap((name) => {
    if (deny.includes(name)) return [`${prefix}: "${name}" is in tools.deny, so the agent can't see it; remove it from tools.deny`];
    if (allow.includes('*') || allow.includes(name)) return [];
    return [`${prefix}: "${name}" is not allowed, so the agent can't see it; add it to tools.allow`];
  });
}

export function validateMcpConfig(raw: unknown): McpConfigValidation {
  const result: McpConfigValidation = { servers: {}, problems: [], warnings: [] };
  if (raw === undefined || raw === null) return result;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    result.problems.push('mcp: expected a mapping with a "servers" key');
    return result;
  }
  const servers = (raw as { servers?: unknown }).servers;
  if (servers === undefined || servers === null) return result;
  if (typeof servers !== 'object' || Array.isArray(servers)) {
    result.problems.push('mcp.servers: expected a mapping of server id to server settings');
    return result;
  }
  for (const [id, value] of Object.entries(servers as Record<string, unknown>)) {
    if (!SERVER_ID_PATTERN.test(id)) {
      result.problems.push(`mcp.servers.${id}: server id must match ${SERVER_ID_PATTERN.source}`);
      continue;
    }
    const parsed = serverSchema.safeParse(value);
    if (!parsed.success) {
      result.problems.push(formatIssue(id, parsed.error.issues[0]!));
      continue;
    }
    const server = parsed.data as McpServerConfig;
    result.servers[id] = server;
    result.warnings.push(
      ...literalSecretWarnings(id, 'env', server.env),
      ...literalSecretWarnings(id, 'headers', server.headers),
      ...hiddenAutoApproveWarnings(id, server),
      ...ownSecretWarnings(id, server),
    );
  }
  return result;
}

export interface ResolvedSecrets {
  args: string[];
  env: Record<string, string>;
  headers: Record<string, string>;
}

function resolveValue(value: string, source: NodeJS.ProcessEnv): string {
  return value.replace(ENV_REF, (_match, name: string) => {
    const resolved = source[name];
    if (resolved === undefined || resolved === '') {
      throw new Error(`env ${name} is not set`);
    }
    registerSecretValue(resolved);
    return resolved;
  });
}

function resolveRecord(values: Record<string, string> | undefined, source: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values ?? {})) {
    out[key] = resolveValue(value, source);
  }
  return out;
}

export function resolveSecrets(server: McpServerConfig, source: NodeJS.ProcessEnv = process.env): ResolvedSecrets {
  return {
    args: (server.args ?? []).map((arg) => resolveValue(arg, source)),
    env: resolveRecord(server.env, source),
    headers: resolveRecord(server.headers, source),
  };
}
