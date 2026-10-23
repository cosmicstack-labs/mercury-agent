import { tool, type Schema, type Tool } from 'ai';
import { redactSecrets } from '../../utils/redact.js';
import { callResultToText, type McpCallResultLike } from './result.js';
import type { McpGate } from './types.js';

export const MAX_DESCRIPTION_CHARS = 1024;

export type McpToolCaller = (
  toolName: string,
  args: Record<string, unknown>,
  signal: AbortSignal | undefined,
) => Promise<McpCallResultLike>;

export interface BuildMcpToolOptions {
  serverId: string;
  toolName: string;
  exposedName: string;
  description: string | undefined;
  inputSchema: Schema<Record<string, unknown>>;
  autoApprove: boolean;
  gate: McpGate;
  call: McpToolCaller;
}

export function describeMcpTool(serverId: string, description: string | undefined): string {
  const text = `[MCP: ${serverId}] ${(description ?? '').trim()}`.trim();
  return text.length > MAX_DESCRIPTION_CHARS ? `${text.slice(0, MAX_DESCRIPTION_CHARS - 1)}…` : text;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function buildMcpTool(options: BuildMcpToolOptions): Tool {
  const { serverId, toolName, exposedName, autoApprove, gate, call } = options;
  return tool({
    description: describeMcpTool(serverId, options.description),
    inputSchema: options.inputSchema,
    execute: async (args: Record<string, unknown>, { abortSignal }): Promise<string> => {
      let verdict;
      try {
        verdict = await gate({ serverId, toolName, exposedName, args, autoApprove });
      } catch (err) {
        return `Error: permission check for MCP ${serverId}/${toolName} failed: ${redactSecrets(errorMessage(err))}`;
      }
      if (!verdict.allowed) {
        return `Error: ${verdict.reason ?? `MCP ${serverId}/${toolName} is not permitted`}`;
      }
      try {
        return callResultToText(await call(toolName, args ?? {}, abortSignal));
      } catch (err) {
        return `Error: MCP ${serverId}/${toolName} failed: ${redactSecrets(errorMessage(err))}`;
      }
    },
  });
}
