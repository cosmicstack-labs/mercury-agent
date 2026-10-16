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

import { ClaudeCodeProvider, toClaudeCatalog } from './claude-code.js';
import { scopeClaudeTools } from './claude-tool-scope.js';
import { autoModelLabel, reasoningLevelsFor, resetModelPrefsCache, setModelPref, setProviderCatalog } from '../utils/model-prefs.js';

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

describe('toClaudeCatalog', () => {
  // Shape of a real supportedModels() answer (Team plan, Oct 2026).
  const models = [
    { value: 'default', resolvedModel: 'claude-opus-5-5[1m]', displayName: 'Default (recommended)', description: 'Opus 5.5 with 1M context · Best for everyday, complex tasks', supportsEffort: true },
    { value: 'opus[1m]', resolvedModel: 'claude-opus-5-5[1m]', displayName: 'Opus (1M context)', description: 'Opus 5.5 with 1M context · Best for everyday, complex tasks', supportsEffort: true },
    { value: 'claude-fable-5-1[1m]', resolvedModel: 'claude-fable-5-1', displayName: 'Fable', description: 'Fable 5.1 · Most capable for your hardest and longest-running tasks · Requires usage credits', supportsEffort: true },
    { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: 'Sonnet 5 · Efficient for routine tasks', supportsEffort: true },
    { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku', description: 'Haiku 4.5 · Fastest for quick answers' },
  ];

  it('lists each underlying model once, preferring explicit rows over the default alias', () => {
    expect(toClaudeCatalog(models).ids).toEqual(['opus[1m]', 'claude-fable-5-1[1m]', 'sonnet', 'haiku']);
  });

  it('builds versioned names and keeps the rest of the description as a hint', () => {
    const { entries } = toClaudeCatalog(models);
    expect(entries['opus[1m]']).toEqual({ label: 'Opus 5.5 (1M context)', hint: 'Best for everyday, complex tasks', supportsEffort: true });
    expect(entries['claude-fable-5-1[1m]']!.hint).toContain('Requires usage credits');
    expect(entries.haiku).toEqual({ label: 'Haiku 4.5', hint: 'Fastest for quick answers', supportsEffort: false });
  });

  it('drives picker names and reasoning levels once registered', () => {
    setProviderCatalog('claudeCode', toClaudeCatalog(models).entries);
    expect(autoModelLabel('claudeCode', 'opus[1m]')).toBe('Claude Opus 5.5 (1M context)');
    expect(autoModelLabel('claudeCode', 'sonnet')).toBe('Claude Sonnet 5');
    // Haiku takes no effort level, so it gets no reasoning picker.
    expect(reasoningLevelsFor('claudeCode', 'haiku')).toEqual([]);
    expect(reasoningLevelsFor('claudeCode', 'sonnet')).toEqual(['off', 'low', 'medium', 'high']);
    // Unknown ids (catalog not loaded yet) keep the full set.
    expect(reasoningLevelsFor('claudeCode', 'opus')).toEqual(['off', 'low', 'medium', 'high']);
  });
});
