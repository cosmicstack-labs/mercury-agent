/** Optional per-turn schema discovery for owner-installed plugin and MCP tools. */
import { tool, zodSchema, type Tool } from 'ai';
import { z } from 'zod';

export const DISCOVER_TOOLS = 'discover_tools';
const DESCRIPTION_CHARS = 240;
const MAX_RESULTS = 10;

/** Built-ins have no namespace; keep their existing exposure and behavior. */
function optionalTool(name: string): boolean {
  return name.includes('__');
}

interface RequestOptions {
  forceFirstTool?: boolean;
  firstStepTools?: string[];
}

/** Create one instance for a user turn; retain it through fallback and continuation. */
export class ToolDiscovery {
  private loaded = new Set<string>();

  constructor(
    private readonly getTools: () => Record<string, Tool>,
    private readonly enabled: boolean,
  ) {}

  request(activeTools?: string[], options: RequestOptions = {}) {
    const source = this.getTools();
    const deferred = Object.keys(source).filter(optionalTool);
    const discover = this.enabled && deferred.length > 0;
    const tools = { ...source };
    const allowed = activeTools ? new Set(activeTools) : undefined;
    // Never enumerate a tool that wasn't in this SDK request or is no longer
    // available in the current role/mode/channel (including disconnected plugins).
    const available = () => {
      const current = this.getTools();
      return deferred.filter((name) => Object.hasOwn(current, name) && (!allowed || allowed.has(name)));
    };
    const active = () => {
      const current = this.getTools();
      return Object.keys(tools).filter((name) => {
        if (name === DISCOVER_TOOLS && discover) return available().length > 0;
        return Object.hasOwn(current, name) && (!allowed || allowed.has(name))
          && (!discover || !optionalTool(name) || this.loaded.has(name));
      });
    };

    if (discover) {
      // activeTools controls schemas, not authorization. Reject guessed calls to
      // unloaded tools and re-resolve live wrappers so discovery grants nothing.
      for (const name of deferred) {
        const original = source[name];
        tools[name] = {
          ...original,
          execute: async (input, execution) => {
            if (!this.loaded.has(name) || !available().includes(name)) {
              return `Error: Tool ${name} is not available. Use ${DISCOVER_TOOLS} to find available tools.`;
            }
            const live = this.getTools()[name];
            if (!live?.execute) return `Error: Tool ${name} is no longer available.`;
            return live.execute(input, execution);
          },
        };
      }
      const services = [...new Set(deferred.map((name) => name.startsWith('mcp__')
        ? `MCP ${name.split('__')[1]}` : name.split('__')[0]))].sort().join(', ').slice(0, 1000);
      tools[DISCOVER_TOOLS] = tool({
        description: 'Search optional integrations by service, tool name, or task keywords before using them. '
          + 'Matching tools are loaded with their full input schemas on the NEXT model step. '
          + 'This only discovers tools; calling them still requires the usual permissions. '
          + 'Use an empty query and offset to browse, or names to load exact names from earlier results. '
          + `Connected integrations: ${services}.`,
        inputSchema: zodSchema(z.object({
          query: z.string().max(200).optional().describe('Task or service keywords; empty lists available tools'),
          names: z.array(z.string().max(200)).max(MAX_RESULTS).optional().describe('Exact tool names to load'),
          limit: z.number().int().min(1).max(MAX_RESULTS).default(5),
          offset: z.number().int().min(0).max(100_000).default(0),
        })),
        execute: async ({ query = '', names, limit = 5, offset = 0 }) => {
          const current = this.getTools();
          const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])];
          const ranked = available().map((name) => {
            const title = name.toLowerCase();
            const description = (current[name].description ?? '').toLowerCase();
            const score = terms.reduce((sum, term) => sum + (title.includes(term) ? 3 : description.includes(term) ? 1 : 0), 0);
            return { name, score };
          }).filter(({ name, score }) => names ? names.includes(name) : terms.length === 0 || score > 0)
            .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
          const selected = ranked.slice(offset, offset + limit);
          for (const { name } of selected) this.loaded.add(name);
          return JSON.stringify({
            tools: selected.map(({ name }) => ({ name, description: (current[name].description ?? '').slice(0, DESCRIPTION_CHARS) })),
            total: ranked.length,
            nextOffset: offset + selected.length < ranked.length ? offset + selected.length : null,
            ...(names ? { unavailable: names.filter((name) => !available().includes(name)) } : {}),
            note: selected.length ? 'These tool schemas are available on the next step. Discovery does not grant permission to execute them.'
              : 'No matching tools. Try a service name, fewer keywords, or an empty query to browse.',
          });
        },
      });
    }

    return {
      tools,
      ...(activeTools ? { activeTools } : {}),
      prepareStep: discover || options.forceFirstTool
        ? ({ stepNumber }: { stepNumber: number }) => ({
          ...(discover ? { activeTools: active() } : {}),
          ...(options.forceFirstTool && stepNumber === 0 ? {
            toolChoice: 'required' as const,
            ...(options.firstStepTools ? { activeTools: options.firstStepTools.filter((name) => active().includes(name)) } : {}),
          } : {}),
        })
        : undefined,
    };
  }
}
