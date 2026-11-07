import '../env.js';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { EvalHarness, runScenario } from '../runner.js';
import { call, textStep, toolStep } from '../fixture.js';
import { publishTool, resetToolBridge } from '../../plugins/tool-bridge.js';
import { buildMcpTool } from '../../capabilities/mcp/tool.js';
import type { McpManager } from '../../capabilities/mcp/manager.js';
import { jsonSchema } from 'ai';
import { ToolDiscovery } from '../../core/tool-discovery.js';

function publish(readOnly = true) {
  const invoke = vi.fn(async () => 'Team meeting at 09:00. Source: https://example.test/calendar/event/42');
  publishTool({ pluginId: 'calendar', pluginName: 'Calendar', name: 'events', description: 'Find upcoming appointments',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
    readOnly, timeoutMs: 1000, invoke });
  return invoke;
}

afterEach(() => { resetToolBridge(); vi.unstubAllEnvs(); });
afterAll(async () => { (await import('../env.js')).removeEvalRoot(); });

describe('eval · on-demand tool schemas in the real agent loop', () => {
  it.each([true, false])('loads and executes a discovered plugin through the SDK and bridge (streaming=%s)', async (streaming) => {
    vi.stubEnv('MERCURY_TOOL_DISCOVERY', 'true');
    const invoke = publish();
    const result = await runScenario({ name: `discovery-${streaming}`, channel: { streaming }, turns: [
      { message: 'Find my appointments.', steps: [
        toolStep([call('discover_tools', { query: 'appointments' })]),
        toolStep([call('calendar__events', { query: 'today' })]),
        textStep('Your team meeting is at 09:00.'),
      ], expect: { deliveredCount: 1, providerCalls: 3, finalTextIncludes: ['09:00'] } },
      { message: 'Thanks.', steps: [textStep('You are welcome.')] },
    ] });
    expect(result.failures).toEqual([]);
    const calls = result.turns[0].providerCalls;
    expect(calls[0].toolNames).toContain('discover_tools');
    expect(calls[0].toolNames).not.toContain('calendar__events');
    expect(calls[1].toolNames).toContain('calendar__events');
    expect(JSON.stringify(calls[2].prompt)).toContain('https://example.test/calendar/event/42');
    expect(result.turns[1].providerCalls[0].toolNames).not.toContain('calendar__events');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed discovery input and refuses the still-unloaded tool', async () => {
    vi.stubEnv('MERCURY_TOOL_DISCOVERY', 'true');
    const invoke = publish();
    const result = await runScenario({ name: 'discovery-validation', turns: [{ message: 'Find appointments.', steps: [
      toolStep([call('discover_tools', { query: 42 })]),
      toolStep([call('calendar__events', { query: 'today' })]),
      textStep('The calendar arguments were invalid.'),
    ] }] });
    expect(invoke).not.toHaveBeenCalled();
    expect(JSON.stringify(result.turns[0].providerCalls[2].prompt)).toContain('Invalid input');
  });

  it('keeps schema discovery inside role, channel, plan, and scheduled grant boundaries', async () => {
    publish(false);
    const harness = await EvalHarness.create({ name: 'discovery-boundaries', turns: [] });
    const caps = harness.capabilities;
    const execute = (tool: import('ai').Tool, input: unknown) => tool.execute!(input, { toolCallId: 'boundary', messages: [] });
    try {
      const request = new ToolDiscovery(() => caps.getTools(), true).request();
      await execute(request.tools.discover_tools, { query: 'calendar' });
      caps.permissions.setCurrentSenderRole('member');
      expect(new ToolDiscovery(() => caps.getTools(), true).request().tools.discover_tools).toBeUndefined();
      expect(await execute(request.tools.calendar__events, { query: 'today' })).toMatch(/^Error:/);
      caps.permissions.setCurrentSenderRole('admin');
      caps.setToolsDisabled(true);
      expect(new ToolDiscovery(() => caps.getTools(), true).request().tools).toEqual({});
      expect(await execute(request.tools.calendar__events, { query: 'today' })).toMatch(/^Error:/);
      caps.setToolsDisabled(false);
      expect(new ToolDiscovery(() => caps.getPlanTools(), true).request().tools.calendar__events).toBeUndefined();
      caps.permissions.setCurrentContext('internal', 'schedule');
      caps.permissions.setAutoApproveAll(false);
      expect(await execute(request.tools.calendar__events, { query: 'today' })).toContain('was not approved');
      caps.permissions.setTurnPluginGrants(['calendar__events']);
      expect(await execute(request.tools.calendar__events, { query: 'today' })).toContain('09:00');
      caps.permissions.setTurnPluginGrants([]);
      expect(await execute(request.tools.calendar__events, { query: 'today' })).toContain('was not approved');
    } finally { await harness.dispose(); }
  });

  it('keeps eager exposure by default', async () => {
    vi.stubEnv('MERCURY_TOOL_DISCOVERY', 'false');
    const invoke = publish();
    const result = await runScenario({ name: 'discovery-off', turns: [{ message: 'Find appointments.', steps: [
      toolStep([call('calendar__events', { query: 'today' })]), textStep('Team meeting at 09:00.'),
    ] }] });
    expect(result.turns[0].providerCalls[0].toolNames).toContain('calendar__events');
    expect(result.turns[0].providerCalls[0].toolNames).not.toContain('discover_tools');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('preserves plugin approval and denial after discovery', async () => {
    vi.stubEnv('MERCURY_TOOL_DISCOVERY', 'true');
    const invoke = publish(false);
    const harness = await EvalHarness.create({ name: 'discovery-denial', turns: [] });
    const ask = vi.fn(async () => 'no');
    harness.capabilities.permissions.setAutoApproveAll(false);
    harness.capabilities.permissions.onAsk(ask);
    try {
      const result = await harness.runTurn({ message: 'Update my calendar.', steps: [
        toolStep([call('discover_tools', { query: 'calendar' })]),
        toolStep([call('calendar__events', { query: 'change meeting' })]),
        textStep('The calendar action was not approved.'),
      ] });
      expect(ask).toHaveBeenCalledTimes(1);
      expect(invoke).not.toHaveBeenCalled();
      expect(JSON.stringify(result.providerCalls[2].prompt)).toContain('was not approved');
    } finally { await harness.dispose(); }
  });

  it('preserves MCP permission gates even under Allow All', async () => {
    vi.stubEnv('MERCURY_TOOL_DISCOVERY', 'true');
    const harness = await EvalHarness.create({ name: 'discovery-mcp-denial', turns: [] });
    const ask = vi.fn(async () => 'no');
    harness.capabilities.permissions.onAsk(ask);
    const invoke = vi.fn(async () => ({ content: [{ type: 'text', text: 'done' }] }));
    const mcpTool = buildMcpTool({ serverId: 'docs', toolName: 'search', exposedName: 'mcp__docs__search', description: 'Search documents',
      inputSchema: jsonSchema({ type: 'object', properties: {}, additionalProperties: false }), autoApprove: false,
      gate: (request) => harness.capabilities.permissions.checkMcpTool(request), call: invoke });
    harness.capabilities.attachMcp({ getTools: () => ({ mcp__docs__search: mcpTool }) } as unknown as McpManager);
    try {
      const result = await harness.runTurn({ message: 'Search the documents.', steps: [
        toolStep([call('discover_tools', { query: 'documents' })]),
        toolStep([call('mcp__docs__search', {})]),
        textStep('The document search was denied.'),
      ] });
      expect(ask).toHaveBeenCalledTimes(1);
      expect(invoke).not.toHaveBeenCalled();
      expect(JSON.stringify(result.providerCalls[2].prompt)).toContain('User denied MCP tool');
    } finally { await harness.dispose(); }
  });

  it('does not expose mutating plugins in plan mode', async () => {
    vi.stubEnv('MERCURY_TOOL_DISCOVERY', 'true');
    publish(false);
    const result = await runScenario({ name: 'discovery-plan', programmingMode: 'plan', turns: [{ message: 'Plan a calendar update.', steps: [textStep('I will plan the update.')] }] });
    expect(result.turns[0].providerCalls[0].toolNames).not.toContain('calendar__events');
    expect(result.turns[0].providerCalls[0].toolNames).not.toContain('discover_tools');
  });
});
