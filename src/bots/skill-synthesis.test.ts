import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { synthesizeSkill, MIN_TOOLS_FOR_SYNTHESIS } from './skill-synthesis.js';

// Synthesis calls the provider object directly (BaseProvider.generateText),
// so the stub is scriptable rather than an ai-module mock.
const scriptedResponses: string[] = [];

function stubProvider() {
  return {
    name: 'stub',
    model: 'stub-model',
    generateText: async () => ({
      text: scriptedResponses.shift() ?? '',
      inputTokens: 0, outputTokens: 0, totalTokens: 0, model: 'stub', provider: 'stub',
    }),
    streamText: async function* () { yield { text: '', done: true }; },
    isAvailable: () => true,
    getModelInstance: () => ({}),
    getModel: () => 'stub-model',
  } as any;
}

describe('auto-skill synthesis', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mercury-skill-synthesis-'));
    scriptedResponses.length = 0;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const validModelOutput = `---
name: RSS Market Scan
description: Scan RSS sources and summarize market findings for the publishing pipeline
allowed-tools: fetch_url, read_file, bot_send
draft: true
---

1. Fetch each configured RSS source with fetch_url.
2. Extract items published since the last run.
3. Summarize findings and hand off to the publisher bot.
`;

  it('writes a draft SKILL.md under the bots skill category', async () => {
    scriptedResponses.push(validModelOutput);
    const result = await synthesizeSkill({
      botId: 'researcher',
      botName: 'Research',
      prompt: 'Scan RSS sources',
      output: 'Found 12 items',
      toolsUsed: ['fetch_url', 'read_file', 'bot_send'],
      provider: stubProvider(),
      skillsRoot: root,
    });
    expect(result?.name).toBe('RSS Market Scan');
    const path = result!.path;
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('draft: true');
    expect(content).toContain('RSS source');
    // Nested layout the loader already understands: <root>/bots/<slug>/SKILL.md
    expect(path).toContain(join('bots', 'researcher-rss-market-scan', 'SKILL.md'));
  });

  it('never overwrites an existing skill draft', async () => {
    scriptedResponses.push(validModelOutput);
    const first = await synthesizeSkill({
      botId: 'researcher', botName: 'Research', prompt: 'p', output: 'o',
      toolsUsed: ['a', 'b', 'c'], provider: stubProvider(), skillsRoot: root,
    });
    expect(first).not.toBeNull();
    // Second run with the same procedure → existing draft is kept as-is
    const second = await synthesizeSkill({
      botId: 'researcher', botName: 'Research', prompt: 'p2', output: 'o2',
      toolsUsed: ['a', 'b', 'c'], provider: stubProvider(), skillsRoot: root,
    });
    expect(second).toBeNull();
    const content = readFileSync(first!.path, 'utf-8');
    expect(content).toContain('RSS Market Scan');
  });

  it('returns null for unusable model output (no frontmatter, too short)', async () => {
    scriptedResponses.push('I wrote a thing but not a skill file');
    const result = await synthesizeSkill({
      botId: 'researcher', botName: 'Research', prompt: 'p', output: 'o',
      toolsUsed: ['a', 'b', 'c'], provider: stubProvider(), skillsRoot: root,
    });
    expect(result).toBeNull();
  });

  it('is non-fatal when the provider throws', async () => {
    const throwingProvider = {
      ...stubProvider(),
      generateText: async () => { throw new Error('HTTP 500'); },
    } as any;
    const result = await synthesizeSkill({
      botId: 'researcher', botName: 'Research', prompt: 'p', output: 'o',
      toolsUsed: ['a', 'b', 'c'], provider: throwingProvider, skillsRoot: root,
    });
    expect(result).toBeNull();
  });

  it('threshold: a run must use at least 3 distinct tools to be worth synthesizing', () => {
    expect(MIN_TOOLS_FOR_SYNTHESIS).toBe(3);
  });
});