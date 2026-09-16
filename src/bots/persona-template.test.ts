import { describe, it, expect, beforeEach } from 'vitest';
import { refinePersona } from './persona-template.js';

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

const goodTemplate = `# Research

A focused deep-research specialist.

## Character

Curious but skeptical curator; verifies before recommending.

## Standing instructions

- Verify repos are active before recommending
- Never recommend unverified sources
- Prefer depth over volume

## Output

Lead with a one-line summary, then compact sections.
`;

describe('refinePersona (convert to template)', () => {
  beforeEach(() => {
    scriptedResponses.length = 0;
  });

  it('restructures free-form persona text into the template shape', async () => {
    scriptedResponses.push(goodTemplate);
    const result = await refinePersona(
      'I want a research bot that verifies repos are active before recommending, never recommends unverified stuff, and likes depth over volume. Skeptical tone.',
      'Research',
      stubProvider(),
    );
    expect(result).toContain('# Research');
    expect(result).toContain('## Standing instructions');
    expect(result).toContain('verifies');
    expect(result).toContain('## Output');
  });

  it('returns null for unusable output (missing sections, too short, code fences)', async () => {
    scriptedResponses.push('Sure! Here is your persona.'); // no structure
    expect(await refinePersona('raw', 'R', stubProvider())).toBeNull();
    scriptedResponses.push('# R'); // too short
    expect(await refinePersona('raw', 'R', stubProvider())).toBeNull();
  });

  it('is non-fatal when the provider throws — raw persona is kept instead', async () => {
    const throwing = { ...stubProvider(), generateText: async () => { throw new Error('HTTP 500'); } } as any;
    expect(await refinePersona('raw persona text', 'R', throwing)).toBeNull();
  });
});