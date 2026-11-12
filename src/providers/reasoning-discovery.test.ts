import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverReasoningCaps, probeReasoningLevels } from './reasoning-discovery.js';
import { withReasoningPref } from './openai-compat.js';
import {
  claimEffortChat, effortFor, effectiveReasoning, reasoningLevelsFor, resetChatEffortCache, resetModelPrefsCache, setChatEffort, setModelPref,
} from '../utils/model-prefs.js';
import { cachedCaps, heuristicLevels, rememberCaps, resetReasoningCapsCache } from '../utils/reasoning-caps.js';
import { runInTurnScope } from '../utils/turn-scope.js';
import type { ProviderConfig } from '../utils/config.js';

/**
 * Effort for OpenAI-compatible servers (#188): what the server says, else
 * the model's name, and a 400 to an effort settles it for good — the
 * request is resent without it instead of failing.
 */
let home: string;
const previousHome = process.env.MERCURY_HOME;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mercury-caps-'));
  process.env.MERCURY_HOME = home;
  resetModelPrefsCache();
  resetChatEffortCache();
  resetReasoningCapsCache();
});
afterEach(() => {
  resetModelPrefsCache();
  resetChatEffortCache();
  resetReasoningCapsCache();
  if (previousHome === undefined) delete process.env.MERCURY_HOME;
  else process.env.MERCURY_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

const pc = (name: string, baseUrl: string, model = 'm'): ProviderConfig => ({ name, baseUrl, model, apiKey: 'k', enabled: true });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('what a server says', () => {
  it('Ollama: only models with the thinking capability, gpt-oss with its own levels', async () => {
    const seen: string[] = [];
    const fake = (async (url: string, init?: RequestInit) => {
      seen.push(String(url));
      const model = JSON.parse(String(init?.body)).model as string;
      return json({ capabilities: model === 'llama3.2' ? ['completion', 'tools'] : ['completion', 'tools', 'thinking'] });
    }) as unknown as typeof fetch;
    const ollama = pc('ollamaLocal', 'http://localhost:11434/v1');
    expect(await probeReasoningLevels(ollama, 'qwen3:8b', fake)).toEqual(['off', 'high']);
    expect(await probeReasoningLevels(ollama, 'gpt-oss:20b', fake)).toEqual(['low', 'medium', 'high']);
    expect(await probeReasoningLevels(ollama, 'llama3.2', fake)).toEqual([]);
    expect(seen[0]).toBe('http://localhost:11434/api/show');
  });

  it('LiteLLM: supports_reasoning per model', async () => {
    const fake = (async () => json({ data: [
      { model_name: 'claude', model_info: { supports_reasoning: true } },
      { model_name: 'gpt-4o', model_info: { supports_reasoning: false } },
    ] })) as unknown as typeof fetch;
    const litellm = pc('litellm', 'http://proxy:4000/v1');
    expect(await probeReasoningLevels(litellm, 'claude', fake)).toEqual(['low', 'medium', 'high']);
    expect(await probeReasoningLevels(litellm, 'gpt-4o', fake)).toEqual([]);
    expect(await probeReasoningLevels(litellm, 'unknown', fake)).toBeUndefined();
  });

  it('OpenRouter: supported_parameters', async () => {
    const fake = (async () => json({ data: [
      { id: 'deepseek/deepseek-r1', supported_parameters: ['reasoning', 'tools'] },
      { id: 'mistral/small', supported_parameters: ['tools'] },
    ] })) as unknown as typeof fetch;
    const or = pc('openaiCompat', 'https://openrouter.ai/api/v1');
    expect(await probeReasoningLevels(or, 'deepseek/deepseek-r1', fake)).toEqual(['low', 'medium', 'high']);
    expect(await probeReasoningLevels(or, 'mistral/small', fake)).toEqual([]);
  });

  it('a server that cannot say (or is down) leaves the guess in place', async () => {
    const down = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    expect(await probeReasoningLevels(pc('ollamaLocal', 'http://x/v1'), 'qwen3', down)).toBeUndefined();
    expect(await probeReasoningLevels(pc('lmStudio', 'http://x/v1'), 'gpt-oss-20b', down)).toBeUndefined();
    expect(reasoningLevelsFor('lmStudio', 'gpt-oss-20b')).toEqual(['low', 'medium', 'high']);
  });

  it('a discovered answer replaces the guess', async () => {
    expect(reasoningLevelsFor('ollamaLocal', 'llama3.2')).toEqual(['off', 'low', 'medium', 'high']);
    const fake = (async () => json({ capabilities: ['completion'] })) as unknown as typeof fetch;
    await discoverReasoningCaps(pc('ollamaLocal', 'http://localhost:11434/v1', 'llama3.2'), 'llama3.2', fake);
    expect(reasoningLevelsFor('ollamaLocal', 'llama3.2')).toEqual([]);
  });
});

describe('names, when nothing else is known', () => {
  it.each([
    ['gpt-5.2', ['low', 'medium', 'high']],
    ['openai/o4-mini', ['low', 'medium', 'high']],
    ['gpt-oss-120b', ['low', 'medium', 'high']],
    ['gemini-2.5-pro', ['low', 'medium', 'high']],
    ['anthropic/claude-sonnet-4-6', ['low', 'medium', 'high']],
    ['grok-3-mini', ['low', 'high']],
    ['llama-3.3-70b', []],
    ['gpt-4o', []],
    ['claude-3-5-sonnet', []],
  ])('%s', (model, levels) => {
    expect(heuristicLevels(model)).toEqual(levels);
  });
});

describe('a server that rejects the effort', () => {
  it('gets the request again without it, and never again for that model', async () => {
    setModelPref('openaiCompat', 'gpt-5-mini', { reasoning: 'high' });
    const bodies: Array<Record<string, unknown>> = [];
    const fake = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      return 'reasoning_effort' in body ? json({ error: { message: 'Unrecognized request argument supplied: reasoning_effort' } }, 400) : json({ ok: true });
    }) as unknown as typeof fetch;
    const f = withReasoningPref('openaiCompat', 'http://vllm:8000/v1', fake);
    const res = await f('http://vllm:8000/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'gpt-5-mini', messages: [] }) });
    expect(res.status).toBe(200);
    expect(bodies.map((b) => 'reasoning_effort' in b)).toEqual([true, false]);
    expect(cachedCaps('openaiCompat', 'gpt-5-mini')?.source).toBe('rejected');
    expect(reasoningLevelsFor('openaiCompat', 'gpt-5-mini')).toEqual([]);
    await f('http://vllm:8000/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'gpt-5-mini', messages: [] }) });
    expect(bodies.at(-1)).not.toHaveProperty('reasoning_effort');
  });

  it('an unrelated 400 is passed through untouched', async () => {
    setModelPref('openaiCompat', 'gpt-5-mini', { reasoning: 'high' });
    let calls = 0;
    const fake = (async () => { calls++; return json({ error: { message: 'context length exceeded' } }, 400); }) as unknown as typeof fetch;
    const res = await withReasoningPref('openaiCompat', undefined, fake)('u', { method: 'POST', body: JSON.stringify({ model: 'gpt-5-mini', messages: [] }) });
    expect(res.status).toBe(400);
    expect(calls).toBe(1);
  });

  it('OpenRouter gets its own reasoning field', async () => {
    setModelPref('openaiCompat', 'openai/o4-mini', { reasoning: 'low' });
    let sent: Record<string, unknown> = {};
    const fake = (async (_u: unknown, init?: RequestInit) => { sent = JSON.parse(String(init?.body)); return json({}); }) as unknown as typeof fetch;
    await withReasoningPref('openaiCompat', 'https://openrouter.ai/api/v1', fake)('u', { method: 'POST', body: JSON.stringify({ model: 'openai/o4-mini', messages: [] }) });
    expect(sent.reasoning).toEqual({ effort: 'low' });
    expect(sent).not.toHaveProperty('reasoning_effort');
  });

  it('a later discovery does not overrule a rejection', () => {
    rememberCaps('litellm', 'x', [], 'rejected');
    rememberCaps('litellm', 'x', ['low', 'medium', 'high'], 'discovered');
    expect(reasoningLevelsFor('litellm', 'x')).toEqual([]);
  });
});

describe('per-chat effort (#188)', () => {
  it("a chat's override wins over the model default, only inside that chat's turn", () => {
    setModelPref('anthropic', 'claude-opus-5-5', { reasoning: 'medium' });
    setChatEffort('thread-a', 'max');
    expect(effectiveReasoning('anthropic', 'claude-opus-5-5')).toBe('medium');
    runInTurnScope(() => {
      claimEffortChat('thread-a');
      expect(effectiveReasoning('anthropic', 'claude-opus-5-5')).toBe('max');
    });
    runInTurnScope(() => {
      claimEffortChat('thread-b');
      expect(effectiveReasoning('anthropic', 'claude-opus-5-5')).toBe('medium');
    });
  });

  it('"auto" in a chat sends nothing even with a default; clearing goes back to the default', () => {
    setModelPref('anthropic', 'claude-opus-5-5', { reasoning: 'high' });
    setChatEffort('t', 'auto');
    expect(effortFor('anthropic', 'claude-opus-5-5', 't')).toMatchObject({ effective: undefined, source: 'chat', modelDefault: 'high' });
    setChatEffort('t', null);
    expect(effortFor('anthropic', 'claude-opus-5-5', 't')).toMatchObject({ effective: 'high', source: 'model' });
  });

  it('a pick the current model cannot take falls back to its default, and says so', () => {
    setChatEffort('t', 'xhigh');
    expect(effortFor('anthropic', 'claude-opus-4-6', 't')).toMatchObject({ effective: undefined, chatUnsupported: true });
    expect(effortFor('anthropic', 'claude-opus-5-5', 't')).toMatchObject({ effective: 'xhigh', source: 'chat' });
  });

  it('survives a restart', () => {
    setChatEffort('t', 'low');
    resetChatEffortCache();
    expect(effortFor('anthropic', 'claude-opus-5-5', 't').effective).toBe('low');
  });
});
