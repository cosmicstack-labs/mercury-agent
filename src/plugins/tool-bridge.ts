/**
 * The bridge between running plugins and Mercury's tool loop.
 *
 * Runtimes (in-process and out-of-process) publish their tools here; every
 * CapabilityRegistry (the main agent's, sub-agents', and each bot's) reads
 * them on every turn through `getPluginTools()`. Each call is wrapped:
 *   approval → timeout + cancellation → error capture → result size cap,
 * and the outcome is reported to the plugin manager's circuit breaker.
 *
 * Tool names are namespaced as `<plugin-id>__<tool>`. Built-in tools never
 * contain "__", so the name alone identifies a plugin tool.
 */
import { jsonSchema, tool, type Tool } from 'ai';
import { isMcpToolName } from '../capabilities/mcp/naming.js';
import type { PermissionManager } from '../capabilities/permissions.js';
import { logger } from '../utils/logger.js';

export interface LiveTool {
  pluginId: string;
  pluginName: string;
  /** Name declared in the manifest (without namespace). */
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  timeoutMs: number;
  invoke(args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}

export interface PluginCommandHandler {
  pluginId: string;
  pluginName: string;
  name: string;
  description: string;
  run(args: string, io: { reply(text: string): Promise<void>; signal: AbortSignal }): Promise<void>;
}

const MAX_RESULT_CHARS = 100_000;

/** Image types a plugin tool may return (plugin API 1.2), e.g. screenshots. */
export const PLUGIN_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
/** Images per result, and base64 characters per image (~6 MB decoded). */
const MAX_IMAGES = 4;
const MAX_IMAGE_CHARS = 8_000_000;

export interface PluginImage {
  data: string;
  mimeType: string;
}

const CONTENT = Symbol('mercury.pluginToolContent');

/** A tool result with images for the model, besides its text. */
export interface PluginToolContent {
  [CONTENT]: true;
  text: string;
  images: PluginImage[];
}

export function toolContent(text: string, images: PluginImage[]): PluginToolContent {
  return { [CONTENT]: true, text, images };
}

function isToolContent(v: unknown): v is PluginToolContent {
  return !!v && typeof v === 'object' && (v as Record<symbol, unknown>)[CONTENT] === true;
}

/**
 * Images waiting to be attached to their tool result, by tool call id.
 * execute() returns text only (so logs, history and learning never carry
 * base64); toModelOutput() adds the images when the result goes to the model.
 * Bounded: a result the SDK never converts can't leak memory.
 */
const pendingImages = new Map<string, PluginImage[]>();
/** Whether the model in use can take images (set by the agent before each provider call). */
let imagesAllowed = true;

export function setPluginImagesAllowed(allowed: boolean): void {
  imagesAllowed = allowed;
}
const MAX_PENDING = 32;

function holdImages(callId: string, images: PluginImage[]): void {
  pendingImages.set(callId, images);
  while (pendingImages.size > MAX_PENDING) pendingImages.delete(pendingImages.keys().next().value as string);
}
const TOOL_NAME_RE = /^([a-z][a-z0-9-]{1,30}[a-z0-9])__([a-z][a-z0-9_]{0,29})$/;

const liveTools = new Map<string, LiveTool>();
const liveCommands = new Map<string, PluginCommandHandler>();

type OutcomeSink = (pluginId: string, outcome: { ok: true } | { ok: false; error: string; timeout: boolean }) => void;
let outcomeSink: OutcomeSink = () => {};

export function setToolOutcomeSink(sink: OutcomeSink): void {
  outcomeSink = sink;
}

export function pluginToolName(pluginId: string, name: string): string {
  return `${pluginId}__${name}`;
}

/** True for any name shaped like a plugin tool, live or not. */
export function isPluginToolName(name: string): boolean {
  // `mcp__<server>__<tool>` has the same shape but is an MCP tool (ADR-029).
  return !isMcpToolName(name) && TOOL_NAME_RE.test(name);
}

/** A bot may use a plugin tool only when its allow list names it, or the whole plugin ("<id>__*"). */
export function pluginToolAllowed(name: string, allow: readonly string[]): boolean {
  const m = TOOL_NAME_RE.exec(name);
  if (!m || isMcpToolName(name)) return false;
  return allow.includes(name) || allow.includes(`${m[1]}__*`);
}

/** Publish a tool; returns its removal. A later registration with the same name replaces it. */
export function publishTool(t: LiveTool): () => void {
  const full = pluginToolName(t.pluginId, t.name);
  liveTools.set(full, t);
  return () => {
    if (liveTools.get(full) === t) liveTools.delete(full);
  };
}

export function publishCommand(c: PluginCommandHandler): () => void {
  liveCommands.set(c.name, c);
  return () => {
    if (liveCommands.get(c.name) === c) liveCommands.delete(c.name);
  };
}

/** Remove everything a plugin published (used when it stops, however it stops). */
export function unpublishPlugin(pluginId: string): void {
  for (const [name, t] of liveTools) if (t.pluginId === pluginId) liveTools.delete(name);
  for (const [name, c] of liveCommands) if (c.pluginId === pluginId) liveCommands.delete(name);
}

export function listLiveTools(): LiveTool[] {
  return [...liveTools.values()];
}

export function getPluginCommand(name: string): PluginCommandHandler | undefined {
  return liveCommands.get(name);
}

export function listPluginCommands(): PluginCommandHandler[] {
  return [...liveCommands.values()];
}

function stringifyResult(value: unknown): string {
  let text: string;
  if (typeof value === 'string') text = value;
  else if (value === undefined || value === null) text = 'Done.';
  else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n[…truncated ${text.length - MAX_RESULT_CHARS} characters]` : text;
}

function describeArgs(args: Record<string, unknown>): string {
  let s: string;
  try {
    s = JSON.stringify(args);
  } catch {
    s = '[unserialisable arguments]';
  }
  return s.length > 400 ? `${s.slice(0, 400)}…` : s;
}

/**
 * Wrap a live tool for the AI SDK. The returned tool never throws: errors,
 * timeouts and denials come back as text the model can act on.
 */
function wrap(t: LiveTool, permissions: PermissionManager): Tool {
  const full = pluginToolName(t.pluginId, t.name);
  return tool<Record<string, unknown>, string>({
    description: `[Plugin: ${t.pluginName}] ${t.description}`,
    inputSchema: jsonSchema<Record<string, unknown>>(t.inputSchema as Parameters<typeof jsonSchema>[0]),
    toModelOutput: ({ toolCallId, output }) => {
      const text = typeof output === 'string' ? output : stringifyResult(output);
      const images = pendingImages.get(toolCallId);
      if (!images?.length) return { type: 'text', value: text };
      if (!imagesAllowed) return { type: 'text', value: `${text}\n(The current model can't view images, so the attached image was left out. Say so if it matters.)` };
      return {
        type: 'content',
        value: [{ type: 'text', text }, ...images.map((i) => ({ type: 'image-data' as const, data: i.data, mediaType: i.mimeType }))],
      };
    },
    execute: async (input, options) => {
      const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
      if (!t.readOnly) {
        const approved = await permissions.approvePluginTool(full, `Run plugin tool ${t.pluginName} → ${t.name} with ${describeArgs(args)}`);
        if (!approved) return `Not run: the plugin tool ${full} was not approved.`;
      }
      const ac = new AbortController();
      const onOuterAbort = () => ac.abort(new Error('cancelled'));
      options?.abortSignal?.addEventListener('abort', onOuterAbort, { once: true });
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          ac.abort(new Error('timeout'));
          reject(new Error(`timed out after ${Math.round(t.timeoutMs / 1000)}s`));
        }, t.timeoutMs);
      });
      try {
        const result = await Promise.race([Promise.resolve().then(() => t.invoke(args, ac.signal)), timeout]);
        outcomeSink(t.pluginId, { ok: true });
        if (isToolContent(result)) {
          const images = result.images.filter((i) => PLUGIN_IMAGE_TYPES.has(i.mimeType) && i.data.length <= MAX_IMAGE_CHARS).slice(0, MAX_IMAGES);
          if (images.length && options?.toolCallId) holdImages(options.toolCallId, images);
          const note = images.length ? `\n[${images.length} image${images.length > 1 ? 's' : ''} attached]` : '';
          return stringifyResult(`${result.text || 'Done.'}${note}`);
        }
        return stringifyResult(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!options?.abortSignal?.aborted) outcomeSink(t.pluginId, { ok: false, error: message, timeout: timedOut });
        logger.warn({ plugin: t.pluginId, tool: t.name, err: message, timedOut }, 'Plugin tool failed');
        return `Error from plugin tool ${full}: ${message}`;
      } finally {
        if (timer) clearTimeout(timer);
        options?.abortSignal?.removeEventListener('abort', onOuterAbort);
      }
    },
  });
}

/** Live plugin tools as AI SDK tools, wired to this registry's permission manager. */
export function getPluginTools(permissions: PermissionManager, opts: { readOnlyOnly?: boolean } = {}): Record<string, Tool> {
  const out: Record<string, Tool> = {};
  for (const [full, t] of liveTools) {
    if (opts.readOnlyOnly && !t.readOnly) continue;
    try {
      out[full] = wrap(t, permissions);
    } catch (err) {
      logger.warn({ plugin: t.pluginId, tool: t.name, err }, 'Plugin tool has an unusable input schema; skipped');
    }
  }
  return out;
}

/** Test hook. */
export function resetToolBridge(): void {
  pendingImages.clear();
  liveTools.clear();
  liveCommands.clear();
  outcomeSink = () => {};
}
