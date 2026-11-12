import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyReasoningToBody,
  displayModelName,
  effectiveReasoning,
  getModelPref,
  isValidModelRef,
  humanizeModelName,
  modelGroupLabel,
  reasoningLevelsFor,
  resetModelPrefsCache,
  setModelPref,
} from './model-prefs.js';

describe('humanizeModelName', () => {
  it.each([
    ['qwen3.8:27b-nvfp4-5090', 'Qwen 3.8 27B (NVFP4 · 5090)'],
    ['gpt-6-sol', 'GPT-6 Sol'],
    ['gpt-5.6-sol', 'GPT-5.6 Sol'],
    ['gpt-oss:120b-cloud', 'GPT OSS 120B'],
    ['kimi-k2.7-code:cloud', 'Kimi K2.7 Code'],
    ['gemma4:12b', 'Gemma 4 12B'],
    ['deepseek-v4-pro:0813-cloud', 'DeepSeek V4 Pro (0813)'],
    ['orcarouter/Qwen3.8-27B-Uncensored:q6_K', 'Qwen 3.8 27B Uncensored (Q6_K)'],
    ['hf.co/mradermacher/qwen3.5-9b-nsfw-captioning-v5-GGUF:Q8_0', 'Qwen 3.5 9B NSFW Captioning V5 (Q8_0)'],
    ['mistral-small-24b-huihui-ablit-q4ks:latest', 'Mistral Small 24B Huihui Abliterated (Q4KS)'],
    ['codex-auto-review', 'Codex Auto Review'],
    ['claude-haiku-4-5-20251001', 'Claude Haiku 4.5'],
    ['claude-opus-5-5', 'Claude Opus 5.5'],
    ['claude-sonnet-4-20250514', 'Claude Sonnet 4'],
    ['llama-3-1-8b-instruct', 'Llama 3.1 8B Instruct'],
    ['hf.co/BennyDaBall/Qwopus3.8-27B-Flash-NVFP4:NVFP4', 'Qwopus 3.8 27B Flash (NVFP4)'],
  ])('%s → %s', (raw, expected) => {
    expect(humanizeModelName(raw)).toBe(expected);
  });

  it('never returns an empty name', () => {
    expect(humanizeModelName(':latest')).not.toBe('');
  });
});

describe('isValidModelRef', () => {
  it.each([
    ['qwen3.8:27b', true],
    ['hf.co/user/Model-GGUF:Q4_K_M', true],
    ['', false],
    ['x'.repeat(257), false],
    ['tab	here', false],
    [42, false],
    [null, false],
  ])('%j → %s', (value, ok) => {
    expect(isValidModelRef(value)).toBe(ok);
  });
});

describe('modelGroupLabel', () => {
  it('separates Ollama cloud models served through the local daemon', () => {
    expect(modelGroupLabel('ollamaLocal', 'glm-5.3:cloud')).toBe('Ollama Cloud · via this PC');
    expect(modelGroupLabel('ollamaLocal', 'gpt-oss:20b-cloud')).toBe('Ollama Cloud · via this PC');
    expect(modelGroupLabel('ollamaLocal', 'gemma4:12b')).toBe('Ollama · this PC');
    expect(modelGroupLabel('chatgptWeb', 'gpt-6-sol')).toBe('ChatGPT');
  });
});

describe('reasoning', () => {
  it('offers Off only where it is known to work', () => {
    expect(reasoningLevelsFor('ollamaLocal')).toContain('off');
    expect(reasoningLevelsFor('chatgptWeb')).toEqual(['low', 'medium', 'high']);
    expect(reasoningLevelsFor('deepseek')).toEqual([]);
  });

  it('offers OpenAI API levels only for reasoning models', () => {
    // gpt-4o / gpt-4.1 answer 400 "Unsupported parameter" to an effort.
    expect(reasoningLevelsFor('openai', 'gpt-4o')).toEqual([]);
    expect(reasoningLevelsFor('openai', 'gpt-4.1-mini')).toEqual([]);
    expect(reasoningLevelsFor('openai', 'o3-mini')).toEqual(['low', 'medium', 'high']);
    expect(reasoningLevelsFor('openai', 'gpt-5.2')).toEqual(['low', 'medium', 'high']);
  });

  it('sets reasoning.effort on Responses API bodies, keeping other reasoning fields', () => {
    const body: Record<string, unknown> = { input: [], reasoning: { summary: 'auto' } };
    applyReasoningToBody(body, 'high');
    expect(body.reasoning).toEqual({ summary: 'auto', effort: 'high' });
  });

  it('sets reasoning_effort on Chat Completions bodies, mapping off to none', () => {
    const body: Record<string, unknown> = { messages: [] };
    applyReasoningToBody(body, 'off');
    expect(body.reasoning_effort).toBe('none');
  });

  it('asks the Responses API for a reasoning summary where wanted, never with Off', () => {
    const body: Record<string, unknown> = { input: [] };
    applyReasoningToBody(body, undefined, { summary: true });
    expect(body.reasoning).toEqual({ summary: 'auto' });
    const withLevel: Record<string, unknown> = { input: [], reasoning: { summary: 'detailed' } };
    applyReasoningToBody(withLevel, 'low', { summary: true });
    expect(withLevel.reasoning).toEqual({ summary: 'detailed', effort: 'low' });
    const off: Record<string, unknown> = { input: [] };
    applyReasoningToBody(off, 'off', { summary: true });
    expect(off.reasoning).toEqual({ effort: 'none' });
    const chat: Record<string, unknown> = { messages: [] };
    applyReasoningToBody(chat, undefined, { summary: true });
    expect(chat).toEqual({ messages: [] });
  });

  it('leaves the body alone on auto', () => {
    const body: Record<string, unknown> = { messages: [] };
    applyReasoningToBody(body, undefined);
    expect(body).toEqual({ messages: [] });
  });
});

describe('model prefs store', () => {
  let home: string;
  const previousHome = process.env.MERCURY_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mercury-prefs-'));
    process.env.MERCURY_HOME = home;
    resetModelPrefsCache();
  });

  afterEach(() => {
    resetModelPrefsCache();
    if (previousHome === undefined) delete process.env.MERCURY_HOME;
    else process.env.MERCURY_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('stores a label and reasoning level and persists them to disk', () => {
    setModelPref('ollamaLocal', 'qwen3.8:27b', { label: '  My Qwen  ', reasoning: 'off' });
    expect(getModelPref('ollamaLocal', 'qwen3.8:27b')).toEqual({ label: 'My Qwen', reasoning: 'off' });
    expect(displayModelName('ollamaLocal', 'qwen3.8:27b')).toBe('My Qwen');

    resetModelPrefsCache();
    const onDisk = JSON.parse(readFileSync(join(home, 'model-prefs.json'), 'utf-8'));
    expect(onDisk['ollamaLocal::qwen3.8:27b']).toEqual({ label: 'My Qwen', reasoning: 'off' });
  });

  it('clears fields with an empty label or auto, and drops empty entries', () => {
    setModelPref('chatgptWeb', 'gpt-6-sol', { label: 'Sol', reasoning: 'high' });
    setModelPref('chatgptWeb', 'gpt-6-sol', { label: '' });
    expect(getModelPref('chatgptWeb', 'gpt-6-sol')).toEqual({ reasoning: 'high' });
    setModelPref('chatgptWeb', 'gpt-6-sol', { reasoning: 'auto' });
    expect(getModelPref('chatgptWeb', 'gpt-6-sol')).toEqual({});
    expect(displayModelName('chatgptWeb', 'gpt-6-sol')).toBe('GPT-6 Sol');
  });

  it('only treats a saved level as effective while the model supports it', () => {
    setModelPref('openai', 'gpt-4o', { reasoning: 'high' });
    expect(effectiveReasoning('openai', 'gpt-4o')).toBeUndefined();
    setModelPref('openai', 'o3', { reasoning: 'high' });
    expect(effectiveReasoning('openai', 'o3')).toBe('high');
  });

  it('keeps only well-formed entries from a hand-edited file', () => {
    writeFileSync(join(home, 'model-prefs.json'), JSON.stringify({
      'ollamaLocal::good': { label: '  Good  ', reasoning: 'off' },
      'ollamaLocal::bad-fields': { label: 42, reasoning: 'turbo' },
      'ollamaLocal::mixed': { label: 'Kept', reasoning: { effort: 'high' } },
      'no-separator': { label: 'x' },
      '::no-provider': { label: 'x' },
      'ollamaLocal::array': ['x'],
    }));
    resetModelPrefsCache();
    expect(getModelPref('ollamaLocal', 'good')).toEqual({ label: 'Good', reasoning: 'off' });
    expect(getModelPref('ollamaLocal', 'bad-fields')).toEqual({});
    expect(getModelPref('ollamaLocal', 'mixed')).toEqual({ label: 'Kept' });
    expect(getModelPref('ollamaLocal', 'array')).toEqual({});
  });

  it('survives a corrupt prefs file', () => {
    writeFileSync(join(home, 'model-prefs.json'), '{not json');
    resetModelPrefsCache();
    expect(getModelPref('ollamaLocal', 'm')).toEqual({});
  });

  it('ignores unknown reasoning values', () => {
    setModelPref('ollamaLocal', 'm', { reasoning: 'turbo' as never });
    expect(getModelPref('ollamaLocal', 'm')).toEqual({});
  });
});
