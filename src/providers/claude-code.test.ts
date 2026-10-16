import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LanguageModelV3CallOptions } from '@ai-sdk/provider';

// Capture what the wrapper hands the underlying Claude Code model.
type CapturedSettings = Record<string, unknown> & { mcpServers?: Record<string, { type: string }> };
const created: { modelId: string; settings: CapturedSettings; callOptions?: LanguageModelV3CallOptions }[] = [];
vi.mock('ai-sdk-provider-claude-code', () => ({
  createClaudeCode: () => ({
    languageModel: (modelId: string, settings: CapturedSettings) => {
      const entry: (typeof created)[number] = { modelId, settings };
      created.push(entry);
      return {
        doGenerate: async (callOptions: LanguageModelV3CallOptions) => {
          entry.callOptions = callOptions;
          return { content: [{ type: 'tool-call', toolCallId: 't1', toolName: 'mcp__mercury__lookup', input: '{}', providerExecuted: true }], finishReason: 'stop', usage: {}, warnings: [] };
        },
      };
    },
  }),
}));

import { ClaudeCodeProvider } from './claude-code.js';
import { scopeClaudeTools } from './claude-tool-scope.js';
import { resetModelPrefsCache, setModelPref } from '../utils/model-prefs.js';

const tools = {
  lookup: tool({
    description: 'Look something up',
    inputSchema: zodSchema(z.object({ key: z.string() })),
    execute: async ({ key }) => `value for ${key}`,
  }),
  other: tool({
    description: 'Not declared in this call',
    inputSchema: zodSchema(z.object({})),
    execute: async () => 'nope',
  }),
};

function callOptions(declared: string[]): LanguageModelV3CallOptions {
  return {
    prompt: [
      { role: 'system', content: 'You are Vega.' },
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ],
    tools: declared.map((name) => ({ type: 'function' as const, name, inputSchema: { type: 'object', properties: {} } })),
  } as LanguageModelV3CallOptions;
}

describe('ClaudeCodeProvider', () => {
  let home: string;
  const previousHome = process.env.MERCURY_HOME;

  beforeEach(() => {
    created.length = 0;
    home = mkdtempSync(join(tmpdir(), 'mercury-claude-'));
    process.env.MERCURY_HOME = home;
    resetModelPrefsCache();
  });

  afterEach(() => {
    resetModelPrefsCache();
    if (previousHome === undefined) delete process.env.MERCURY_HOME;
    else process.env.MERCURY_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  function model() {
    return new ClaudeCodeProvider({ name: 'claudeCode', apiKey: '', baseUrl: '', model: 'sonnet', enabled: true }).getModelInstance();
  }

  it('runs the CLI as a bare model: no built-ins, no user settings, no saved sessions', async () => {
    scopeClaudeTools(tools);
    await model().doGenerate(callOptions(['lookup']));
    const { settings } = created[0]!;
    expect(settings.tools).toEqual([]);
    expect(settings.settingSources).toEqual([]);
    expect(settings.persistSession).toBe(false);
    expect(settings.permissionMode).toBe('dontAsk');
  });

  it('bridges exactly the declared tools and allows only those', async () => {
    scopeClaudeTools(tools);
    await model().doGenerate(callOptions(['lookup']));
    const { settings, callOptions: passed } = created[0]!;
    expect(settings.allowedTools).toEqual(['mcp__mercury__lookup']);
    expect(settings.mcpServers?.mercury?.type).toBe('sdk');
    // The CLI gets the tools over MCP, not as AI SDK declarations.
    expect(passed?.tools).toBeUndefined();
  });

  it('makes system messages the real system prompt', async () => {
    scopeClaudeTools(tools);
    await model().doGenerate(callOptions([]));
    const { settings, callOptions: passed } = created[0]!;
    expect(settings.systemPrompt).toBe('You are Vega.');
    expect(passed?.prompt.some((m) => m.role === 'system')).toBe(false);
  });

  it('reports bridged tool calls under Mercury tool names', async () => {
    scopeClaudeTools(tools);
    const result = await model().doGenerate(callOptions(['lookup']));
    expect(result.content[0]).toMatchObject({ type: 'tool-call', toolName: 'lookup' });
  });

  it.each([
    ['off', { thinking: { type: 'disabled' } }],
    ['low', { effort: 'low' }],
    ['high', { effort: 'high' }],
  ] as const)('maps reasoning %s to the Agent SDK settings', async (level, expected) => {
    setModelPref('claudeCode', 'sonnet', { reasoning: level });
    scopeClaudeTools(tools);
    await model().doGenerate(callOptions([]));
    expect(created[0]!.settings).toMatchObject(expected);
  });

  it('sends no reasoning settings on auto', async () => {
    scopeClaudeTools(tools);
    await model().doGenerate(callOptions([]));
    expect(created[0]!.settings).not.toHaveProperty('effort');
    expect(created[0]!.settings).not.toHaveProperty('thinking');
  });
});
