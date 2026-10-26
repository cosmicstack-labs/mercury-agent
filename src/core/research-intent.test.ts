import { describe, expect, it } from 'vitest';
import { RESEARCH_INTENT_SYSTEM, classifyResearchIntent, parseResearchIntent } from './research-intent.js';

describe('research intent', () => {
  it('only a clear RESEARCH verdict counts', () => {
    expect(parseResearchIntent('RESEARCH')).toBe('research');
    expect(parseResearchIntent('research.')).toBe('research');
    expect(parseResearchIntent('  Research\nbecause they asked for a report')).toBe('research');
    expect(parseResearchIntent('NORMAL')).toBe('normal');
    expect(parseResearchIntent('It could be research')).toBe('normal');
    expect(parseResearchIntent('')).toBe('normal');
  });

  it('asks the model with the intent prompt and the message', async () => {
    const seen: string[] = [];
    const verdict = await classifyResearchIntent('Write me an in-depth report on the history of solar power', async (system, user) => {
      seen.push(system, user);
      return 'RESEARCH';
    });
    expect(verdict).toBe('research');
    expect(seen[0]).toBe(RESEARCH_INTENT_SYSTEM);
    expect(seen[1]).toBe('Write me an in-depth report on the history of solar power');
  });

  it('a failing or slow model never triggers the prompt', async () => {
    expect(await classifyResearchIntent('x', async () => { throw new Error('rate limited'); })).toBe('normal');
    expect(await classifyResearchIntent('x', () => new Promise((r) => setTimeout(() => r('RESEARCH'), 200)), 20)).toBe('normal');
  });

  it('the prompt tells the model that instructions and quick questions are NORMAL', () => {
    expect(RESEARCH_INTENT_SYSTEM).toMatch(/instructions to do something/);
    expect(RESEARCH_INTENT_SYSTEM).toMatch(/today's news/);
    expect(RESEARCH_INTENT_SYSTEM).toMatch(/exactly one word: RESEARCH or NORMAL/);
  });
});
