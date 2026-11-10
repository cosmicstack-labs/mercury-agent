import { describe, expect, it, vi } from 'vitest';
import { asSchema, tool, zodSchema, type Tool } from 'ai';
import { z } from 'zod';
import { DISCOVER_TOOLS, ToolDiscovery } from './tool-discovery.js';

function capability(description: string, execute = vi.fn(async () => 'ok')): Tool {
  return tool({ description, inputSchema: zodSchema(z.object({ query: z.string() })), execute });
}
const execute = async (t: Tool, input: unknown) => t.execute!(input, { toolCallId: 'test', messages: [] });
const active = (request: ReturnType<ToolDiscovery['request']>) => request.prepareStep!({ stepNumber: 0 }).activeTools!;
const search = (request: ReturnType<ToolDiscovery['request']>, input: Record<string, unknown>) => execute(request.tools[DISCOVER_TOOLS], input);

function schemaBytes(tools: Record<string, Tool>, names = Object.keys(tools)): number {
  return Buffer.byteLength(JSON.stringify(names.map((name) => ({ name, description: tools[name].description, inputSchema: asSchema(tools[name].inputSchema).jsonSchema }))));
}

describe('optional tool discovery', () => {
  it('leaves exposure and tool identity unchanged when off, or no integrations exist', () => {
    const tools = { read_file: capability('Read files'), demo__search: capability('Search docs') };
    const off = new ToolDiscovery(() => tools, false).request(['read_file']);
    expect(off.tools).toEqual(tools);
    expect(off.tools.demo__search).toBe(tools.demo__search);
    expect(off.activeTools).toEqual(['read_file']);
    // The step hook only applies the payload policy then: nothing to change, nothing overridden.
    expect(off.prepareStep!({ stepNumber: 0 })).toEqual({});
    expect(new ToolDiscovery(() => ({ read_file: tools.read_file }), true).request().prepareStep!({ stepNumber: 1 })).toEqual({});
  });

  it('searches names and descriptions, loads exact schemas next step, and retains built-ins', async () => {
    const tools = { read_file: capability('Read files'), calendar__events: capability('Find appointments'), mail__search: capability('Search inbox messages') };
    const discovery = new ToolDiscovery(() => tools, true);
    const request = discovery.request();
    expect(active(request)).toEqual(['read_file', DISCOVER_TOOLS]);
    expect(JSON.parse(await search(request, { query: 'appointments' }) as string).tools[0].name).toBe('calendar__events');
    expect(active(request)).toEqual(['read_file', 'calendar__events', DISCOVER_TOOLS]);
    expect(request.tools.calendar__events.inputSchema).toBe(tools.calendar__events.inputSchema);
    expect(active(discovery.request())).toContain('calendar__events'); // fallback/continuation
    expect(active(new ToolDiscovery(() => tools, true).request())).not.toContain('calendar__events'); // next turn
  });

  it('supports bounded browsing, exact names, unknown names and no-match recovery', async () => {
    const tools = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`docs__tool_${String(i).padStart(2, '0')}`, capability('Read docs')])) as Record<string, Tool>;
    const request = new ToolDiscovery(() => tools, true).request();
    const first = JSON.parse(await search(request, {}) as string);
    expect(first.tools).toHaveLength(5);
    expect(first.nextOffset).toBe(5);
    const second = JSON.parse(await search(request, { offset: 5 }) as string);
    expect(second.tools[0].name).toBe('docs__tool_05');
    expect(JSON.parse(await search(request, { query: 'unfindable' }) as string).tools).toEqual([]);
    const exact = JSON.parse(await search(request, { names: ['docs__tool_11', 'unknown__tool'] }) as string);
    expect(exact.tools.map((t: { name: string }) => t.name)).toEqual(['docs__tool_11']);
    expect(exact.unavailable).toEqual(['unknown__tool']);
  });

  it('refuses guessed calls before discovery and tools removed or forbidden after discovery', async () => {
    const run = vi.fn(async () => 'ok');
    let tools: Record<string, Tool> = { demo__search: capability('Search docs', run) };
    const request = new ToolDiscovery(() => tools, true).request();
    expect(await execute(request.tools.demo__search, { query: 'x' })).toMatch(/^Error: Tool .* is not available/);
    expect(run).not.toHaveBeenCalled();
    await search(request, { query: 'docs' });
    expect(await execute(request.tools.demo__search, { query: 'x' })).toBe('ok');
    tools = {}; // role downgrade, general access, plan restriction, or plugin disabled
    expect(active(request)).toEqual([]);
    expect(await execute(request.tools.demo__search, { query: 'x' })).toMatch(/^Error:/);
    expect(JSON.parse(await search(request, {}) as string).tools).toEqual([]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('cannot widen an existing active-tool restriction and composes forced action rounds', async () => {
    const tools = { read_file: capability('Read files'), demo__search: capability('Search docs'), denied__write: capability('Write docs') };
    const discovery = new ToolDiscovery(() => tools, true);
    const request = discovery.request(['read_file', 'demo__search'], { forceFirstTool: true, firstStepTools: ['read_file', 'denied__write'] });
    expect(request.prepareStep!({ stepNumber: 0 })).toEqual({ activeTools: ['read_file'], toolChoice: 'required' });
    expect(JSON.parse(await search(request, { names: ['denied__write'] }) as string).tools).toEqual([]);
    await search(request, { names: ['demo__search'] });
    expect(request.prepareStep!({ stepNumber: 1 })).toEqual({ activeTools: ['read_file', 'demo__search', DISCOVER_TOOLS] });
  });

  it('measures schema bytes for 100 optional tools before and after loading five', async () => {
    const tools: Record<string, Tool> = { read_file: capability('Read a file') };
    for (let i = 0; i < 100; i++) {
      tools[`docs__tool_${String(i).padStart(3, '0')}`] = tool({
        description: `Search documents in collection ${i}. ` + 'Returns matching documents with their source links. '.repeat(3),
        inputSchema: zodSchema(z.object(Object.fromEntries(Array.from({ length: 10 }, (_, n) => [`filter_${n}`, z.string().optional().describe(`Optional document filter ${n}`)])))),
        execute: async () => 'ok',
      });
    }
    const request = new ToolDiscovery(() => tools, true).request();
    const eagerBytes = schemaBytes(tools);
    const initialBytes = schemaBytes(request.tools, active(request));
    await search(request, { query: 'documents' });
    const loadedBytes = schemaBytes(request.tools, active(request));
    expect(initialBytes / eagerBytes).toBeLessThan(0.05);
    expect(loadedBytes / eagerBytes).toBeLessThan(0.10);
    console.info(`Discovery schema benchmark: eager=${eagerBytes} B; initial=${initialBytes} B; five loaded=${loadedBytes} B (synthetic JSON bytes, not model tokens or task success).`);
  });
});
