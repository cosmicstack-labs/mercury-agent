import { describe, expect, it } from 'vitest';
import { IntentRouter } from '../skills/intent-router.js';

/** ADR-039/040: skill intents match exactly — whole phrases and whole words, never a fuzzy guess. */
describe('intent matching', () => {
  const router = new IntentRouter();
  router.buildIndex([{ name: 'web-search', description: 'Search the web for current news' }, { name: 'history', description: 'Browser history' }] as never);
  router.registerSkillMeta({ name: 'web-search', description: 'Search the web for current news', intents: ['search for', 'look this up'], tags: ['websearch'] } as never);
  router.registerSkillMeta({ name: 'history', description: 'Browser history', intents: ['show this history'] } as never);

  it('a greeting matches nothing (it used to match inside "this" and "history")', () => {
    expect(router.match('hi')).toEqual([]);
    expect(router.analyzeMatch('Hi').clearWinner).toBe(false);
  });

  it('real requests still match on whole phrases and tags', () => {
    expect(router.match('search for flights to Lisbon')[0]?.name).toBe('web-search');
    expect(router.match('please look this up')[0]?.name).toBe('web-search');
    expect(router.match('use websearch please')[0]?.name).toBe('web-search');
  });

  it('no fuzzy matches: a shared word, a similar word or a description word is not a match', () => {
    expect(router.match('research for my thesis')).toEqual([]);
    expect(router.match('what is the current status of my history homework')).toEqual([]);
    expect(router.match('searching news for things')).toEqual([]);
  });
});
