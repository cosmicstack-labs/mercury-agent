/**
 * Claude via the user's own Claude Pro/Max subscription, through the official
 * Claude Agent SDK (which drives the locally installed Claude Code CLI).
 *
 * The CLI runs its own agent loop and never sees AI SDK `execute` functions,
 * so Mercury's tools are bridged in explicitly: every model call gets an
 * in-process MCP server exposing exactly the tools that call declared, backed
 * by the caller's real tool implementations. Tools therefore run inside
 * Mercury with Mercury's permission checks, approvals and scopes. Claude
 * Code's own built-in tools are disabled, its user/project settings are not
 * loaded, and sessions are not persisted, so the CLI acts purely as the model.
 *
 * Callers mark their tool set with `scopeClaudeTools(tools)` (see
 * claude-tool-scope.ts) because the model layer only receives declarations.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { generateText, streamText, asSchema } from 'ai';
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
} from '@ai-sdk/provider';
import { createClaudeCode, type ClaudeCodeSettings } from 'ai-sdk-provider-claude-code';
import { query, type ModelInfo } from '@anthropic-ai/claude-agent-sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { BaseProvider, type LLMResponse, type LLMStreamChunk } from './base.js';
import type { ProviderConfig } from '../utils/config.js';
import { effectiveReasoning, type CatalogEntry } from '../utils/model-prefs.js';
import { logger } from '../utils/logger.js';
import { currentClaudeToolScope, type ClaudeToolScope } from './claude-tool-scope.js';

export { scopeClaudeTools } from './claude-tool-scope.js';

const MCP_SERVER = 'mercury';
const MCP_PREFIX = `mcp__${MCP_SERVER}__`;
/** Approval prompts can wait on a human; don't let the CLI time the call out. */
const TOOL_TIMEOUT_MS = 30 * 60 * 1000;

/** Model aliases the Agent SDK resolves to the latest model of each family. */
export const CLAUDE_CODE_MODELS = ['opus', 'sonnet', 'haiku'] as const;

const CATALOG_TIMEOUT_MS = 20_000;

/** A never-yielding prompt stream: lets the CLI initialise without sending a turn. */
function idlePrompt(signal: AbortSignal): AsyncIterable<never> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<never>>((resolve) =>
        signal.addEventListener('abort', () => resolve({ done: true, value: undefined }), { once: true })),
    }),
  };
}

/**
 * Turn the CLI's model list into picker ids and catalog entries. Rows that
 * resolve to the same model (the "default" alias duplicates one of the
 * others) are listed once, preferring the explicit row. Names come from the
 * description's first segment, which carries the version:
 * "Opus 5.5 with 1M context · Best for…" → "Opus 5.5 (1M context)".
 */
export function toClaudeCatalog(models: ModelInfo[]): { ids: string[]; entries: Record<string, CatalogEntry> } {
  const ids: string[] = [];
  const entries: Record<string, CatalogEntry> = {};
  const seen = new Set<string>();
  const ordered = [...models.filter((m) => m.value !== 'default'), ...models.filter((m) => m.value === 'default')];
  for (const m of ordered) {
    const resolved = m.resolvedModel ?? m.value;
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    const [head, ...rest] = (m.description ?? '').split(' · ');
    entries[m.value] = {
      label: head?.trim() ? head.trim().replace(/ with (.+)$/, ' ($1)') : m.displayName,
      ...(rest.length ? { hint: rest.join(' · ') } : {}),
      supportsEffort: m.supportsEffort === true,
    };
    ids.push(m.value);
  }
  return { ids, entries };
}

/**
 * The models the signed-in account offers, as the CLI reports them (ids,
 * display names, effort support). Starts the CLI but sends no prompt, so it
 * costs nothing. Throws if the CLI is missing, signed out, or slow.
 */
export async function listClaudeModels(configuredPath?: string): Promise<ModelInfo[]> {
  const executable = resolveClaudeExecutable(configuredPath);
  if (!executable) throw new Error('Claude Code CLI not found');
  const abortController = new AbortController();
  const q = query({
    prompt: idlePrompt(abortController.signal),
    options: {
      pathToClaudeCodeExecutable: executable,
      abortController,
      settingSources: [],
      persistSession: false,
      tools: [],
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      q.supportedModels(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out listing Claude models')), CATALOG_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    abortController.abort();
    q.close();
  }
}

// ─── MCP bridge ──────────────────────────────────────────────────────────────

function toolResultText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result === undefined) return '';
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

/** In-process MCP server exposing `names` from `scope.tools`, executed by Mercury. */
async function buildToolServer(names: string[], scope: ClaudeToolScope): Promise<McpServer> {
  const listed = await Promise.all(names.map(async (name) => {
    const tool = scope.tools[name]!;
    const schema = asSchema(tool.inputSchema);
    const jsonSchema = (await schema.jsonSchema) as Record<string, unknown>;
    return {
      name,
      description: tool.description ?? '',
      inputSchema: { type: 'object', properties: {}, ...jsonSchema },
      schema,
    };
  }));
  const byName = new Map(listed.map((t) => [t.name, t]));

  const server = new McpServer({ name: MCP_SERVER, version: '1.0.0' });
  server.server.registerCapabilities({ tools: {} });
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listed.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));
  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args = {} } = request.params;
    const entry = byName.get(name);
    const execute = scope.tools[name]?.execute;
    if (!entry || !execute) {
      return { isError: true, content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }] };
    }
    try {
      const validated = entry.schema.validate ? await entry.schema.validate(args) : { success: true as const, value: args };
      if (!validated.success) {
        return { isError: true, content: [{ type: 'text' as const, text: `Invalid arguments for ${name}: ${validated.error.message}` }] };
      }
      const result = await scope.runInCallerContext(() => execute(validated.value, {
        toolCallId: String(extra.requestId),
        messages: [],
        abortSignal: extra.signal,
      }));
      return { content: [{ type: 'text' as const, text: toolResultText(await result) }] };
    } catch (err) {
      return { isError: true, content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }] };
    }
  });
  return server;
}

// ─── Model ───────────────────────────────────────────────────────────────────

/** Locate the installed Claude Code CLI (the compiled Mercury binary can't carry one). */
export function resolveClaudeExecutable(configured?: string): string | undefined {
  if (configured && existsSync(configured)) return configured;
  const candidates = process.platform === 'win32'
    ? [join(homedir(), '.local', 'bin', 'claude.exe'), join(process.env.APPDATA ?? '', 'npm', 'claude.cmd')]
    : [join(homedir(), '.local', 'bin', 'claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude'];
  return candidates.find((p) => p && existsSync(p));
}

/** Pull system messages out of the prompt: they become Claude's real system prompt. */
function splitSystem(prompt: LanguageModelV3Prompt): { system: string; rest: LanguageModelV3Prompt } {
  const system: string[] = [];
  const rest: LanguageModelV3Prompt = [];
  for (const message of prompt) {
    if (message.role === 'system') system.push(message.content);
    else rest.push(message);
  }
  return { system: system.join('\n\n'), rest };
}

function stripPrefix(name: string): string {
  return name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name;
}

/** Show bridged tool calls under Mercury's own tool names. */
function renameToolParts(): TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart> {
  return new TransformStream({
    transform(part, controller) {
      if ('toolName' in part && typeof part.toolName === 'string') {
        controller.enqueue({ ...part, toolName: stripPrefix(part.toolName) } as LanguageModelV3StreamPart);
      } else {
        controller.enqueue(part);
      }
    },
  });
}

class MercuryClaudeModel implements LanguageModelV3 {
  readonly specificationVersion = 'v3' as const;
  readonly provider = 'claude-code';
  readonly supportedUrls = {};

  constructor(
    readonly modelId: string,
    private readonly providerName: string,
    private readonly executable: string | undefined,
  ) {}

  private async prepare(options: LanguageModelV3CallOptions) {
    const scope = currentClaudeToolScope();
    const declared = (options.tools ?? []).filter((t) => t.type === 'function').map((t) => t.name);
    const bridged = scope ? declared.filter((name) => typeof scope.tools[name]?.execute === 'function') : [];
    if (declared.length && !scope) {
      logger.warn({ declared: declared.length }, 'Claude (subscription): tools declared without scopeClaudeTools(); running without tools');
    }

    const { system, rest } = splitSystem(options.prompt);
    const reasoning = effectiveReasoning(this.providerName, this.modelId);
    const settings: ClaudeCodeSettings = {
      pathToClaudeCodeExecutable: this.executable,
      // Act purely as the model: no built-in tools, no user/project settings,
      // no session files in the user's Claude Code history.
      tools: [],
      settingSources: [],
      persistSession: false,
      permissionMode: 'dontAsk',
      allowedTools: bridged.map((name) => MCP_PREFIX + name),
      ...(system ? { systemPrompt: system } : {}),
      ...(bridged.length && scope
        ? { mcpServers: { [MCP_SERVER]: { type: 'sdk', name: MCP_SERVER, timeout: TOOL_TIMEOUT_MS, instance: await buildToolServer(bridged, scope) } } }
        : {}),
      ...(reasoning === 'off' ? { thinking: { type: 'disabled' } } : reasoning ? { effort: reasoning } : {}),
    } as ClaudeCodeSettings;

    const model = createClaudeCode().languageModel(this.modelId, settings);
    // The CLI executes the tools itself; declarations are passed via MCP.
    const callOptions: LanguageModelV3CallOptions = { ...options, prompt: rest, tools: undefined, toolChoice: undefined };
    return { model, callOptions };
  }

  async doGenerate(options: LanguageModelV3CallOptions) {
    const { model, callOptions } = await this.prepare(options);
    const result = await model.doGenerate(callOptions);
    return {
      ...result,
      content: result.content.map((part) =>
        'toolName' in part && typeof part.toolName === 'string' ? { ...part, toolName: stripPrefix(part.toolName) } : part),
    } as typeof result;
  }

  async doStream(options: LanguageModelV3CallOptions) {
    const { model, callOptions } = await this.prepare(options);
    const result = await model.doStream(callOptions);
    return { ...result, stream: result.stream.pipeThrough(renameToolParts()) };
  }
}

// ─── Provider ────────────────────────────────────────────────────────────────

export class ClaudeCodeProvider extends BaseProvider {
  readonly name: string;
  readonly model: string;
  private readonly modelInstance: MercuryClaudeModel;
  private readonly executable: string | undefined;

  constructor(config: ProviderConfig) {
    super(config);
    this.name = config.name;
    this.model = config.model;
    // baseUrl holds an optional explicit path to the Claude Code CLI.
    this.executable = resolveClaudeExecutable(config.baseUrl || undefined);
    this.modelInstance = new MercuryClaudeModel(config.model, config.name, this.executable);
  }

  async generateText(prompt: string, systemPrompt: string): Promise<LLMResponse> {
    const result = await generateText({ model: this.modelInstance, system: systemPrompt, prompt });
    return {
      text: result.text,
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
      totalTokens: (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
      model: this.model,
      provider: this.name,
    };
  }

  async *streamText(prompt: string, systemPrompt: string): AsyncIterable<LLMStreamChunk> {
    const result = streamText({ model: this.modelInstance, system: systemPrompt, prompt });
    for await (const text of result.textStream) yield { text, done: false };
    yield { text: '', done: true };
  }

  isAvailable(): boolean {
    return this.config.enabled && this.config.model.length > 0 && this.executable !== undefined;
  }

  getModelInstance(): LanguageModelV3 {
    return this.modelInstance;
  }

  /** The CLI does not accept an output-token cap. */
  getMaxOutputTokens(): number | undefined {
    return undefined;
  }
}
