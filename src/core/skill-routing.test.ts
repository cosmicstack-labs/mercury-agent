import { describe, expect, it } from 'vitest';
import type { ChannelMessage } from '../types/channel.js';
import { routingTextOf } from './agent.js';
import { IntentRouter } from '../skills/intent-router.js';

/** ADR-039: skills are routed on the owner's own words, whole words only, and only ever suggested. */

const msg = (content: string, metadata: Record<string, unknown> = {}): ChannelMessage =>
  ({ id: 'm', channelId: 'c', channelType: 'web', senderId: 'u', content, timestamp: 0, metadata });

describe('routing text', () => {
  it("uses the channel's own record of what the owner said", () => {
    expect(routingTextOf(msg('[Voice …web_search for anything current…]\nwhat is running?', { routingText: 'what is running?' }))).toBe('what is running?');
  });

  it('drops a leading [channel note] line, never the owner text', () => {
    expect(routingTextOf(msg('[Voice, on the owner\'s computer: use web_search, skills…]\nWhat containers are up?'))).toBe('What containers are up?');
    expect(routingTextOf(msg('search for [brackets] in my notes'))).toBe('search for [brackets] in my notes');
    expect(routingTextOf(msg('  hi  '))).toBe('hi');
  });
});

describe('intent matching', () => {
  const router = new IntentRouter();
  router.buildIndex([{ name: 'web-search', description: 'Search the web' }, { name: 'history', description: 'Browser history' }] as never);
  router.registerSkillMeta({ name: 'web-search', description: 'Search the web', intents: ['search for', 'look this up'] } as never);
  router.registerSkillMeta({ name: 'history', description: 'Browser history', intents: ['show this history'] } as never);

  it('a greeting matches nothing (it used to match inside "this" and "history")', () => {
    expect(router.match('hi')).toEqual([]);
    expect(router.analyzeMatch('Hi').clearWinner).toBe(false);
  });

  it('real requests still match on whole words', () => {
    expect(router.match('search for flights to Lisbon')[0]?.name).toBe('web-search');
    expect(router.match('please look this up')[0]?.name).toBe('web-search');
    expect(router.match('research for my thesis').some((m) => m.name === 'web-search' && m.confidence >= 0.95)).toBe(false);
  });
});
