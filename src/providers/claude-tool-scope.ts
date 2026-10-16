/**
 * Tool scope for the Claude (subscription) provider. Kept separate from
 * claude-code.ts so agent call sites can mark tools without loading the
 * Agent SDK.
 *
 * The model layer only receives tool declarations, but the Claude Code CLI
 * must be handed runnable tools (via an in-process MCP server). Call sites
 * therefore mark the tool set they pass to the model; the provider reads it
 * from async context. The scope also snapshots the caller's async context so
 * tool calls arriving over the MCP transport run with the same permission
 * context as an ordinary tool step.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ToolSet } from 'ai';

export interface ClaudeToolScope {
  tools: ToolSet;
  /** Re-enters the caller's async context (permission context etc.). */
  runInCallerContext: <T>(fn: () => T) => T;
}

const store = new AsyncLocalStorage<ClaudeToolScope>();

/**
 * Mark the tool set for the model call about to be made from this async
 * context, and return it unchanged: `tools: scopeClaudeTools(x)`. Harmless
 * for every provider other than Claude (subscription).
 */
export function scopeClaudeTools<T extends ToolSet>(tools: T): T {
  const snapshot = (AsyncLocalStorage as unknown as { snapshot?: () => <R>(fn: () => R) => R }).snapshot?.();
  store.enterWith({ tools, runInCallerContext: snapshot ?? ((fn) => fn()) });
  return tools;
}

export function currentClaudeToolScope(): ClaudeToolScope | undefined {
  return store.getStore();
}
