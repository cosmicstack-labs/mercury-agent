import { describe, expect, it } from 'vitest';
import { fallbackSessionTitle, isThinOpening, normalizeGeneratedSessionTitle, titlePrompt } from './title.js';

describe('normalizeGeneratedSessionTitle', () => {
  it('removes wrappers and keeps a short single-line title', () => {
    expect(normalizeGeneratedSessionTitle('  Title: “Canonical Session Sync”\nExtra explanation')).toBe('Canonical Session Sync');
    expect(normalizeGeneratedSessionTitle('**Hyperframes Skill Install.**')).toBe('Hyperframes Skill Install');
    expect(normalizeGeneratedSessionTitle('Budgets')).toBe('Budgets');
  });

  it('keeps titles to a few words and a sidebar width', () => {
    const title = normalizeGeneratedSessionTitle('Extraordinary Synchronization Architecture Handles Canonical Histories');
    expect(title!.split(' ').length).toBeLessThanOrEqual(5);
    expect(title!.length).toBeLessThanOrEqual(40);
  });

  // Real titles the old prompt produced: replies and refusals, not titles.
  it.each([
    'I appreciate you sharing that GitHub link,',
    'I appreciate your request, but I need',
    "I'd be happy to help! However, I",
    "I don't have access to your personal",
    'A concise 3-7 word title for this',
    'Sure! Here is a title: Budget Review',
    'This is a conversation where the user asks Mercury to install a skill from GitHub and it explains',
  ])('rejects a reply posing as a title: %s', (raw) => {
    expect(normalizeGeneratedSessionTitle(raw)).toBeNull();
  });
});

describe('fallbackSessionTitle', () => {
  it('drops greetings, asks and links', () => {
    expect(fallbackSessionTitle('Install this skill https://github.com/heygen-com/hyperframes/tree/main/.claude/skills')).toBe('Install this skill');
    expect(fallbackSessionTitle('hey can you find best videos and their scripts for us to make a video')).toBe('Find best videos and their');
    expect(fallbackSessionTitle('Okay, I want you to check the budget tracker. It is off.')).toBe('Check the budget tracker');
  });

  it('skips the note a voice question carries, and markdown', () => {
    expect(fallbackSessionTitle("[Voice, on the owner's own computer: they asked this out loud.] What's the weather in Lahore?")).toBe("What's the weather in Lahore");
    expect(fallbackSessionTitle('# COSMIC LEADER - Official Campaign Video')).toBe('COSMIC LEADER - Official Campaign');
  });

  it('never comes back empty', () => {
    expect(fallbackSessionTitle('hi')).toBe('New chat');
    expect(fallbackSessionTitle('https://example.com')).toBe('New chat');
  });
});

describe('isThinOpening', () => {
  it('spots a greeting with nothing to name yet', () => {
    expect(isThinOpening('hi')).toBe(true);
    expect(isThinOpening('Hey Mercury!')).toBe(true);
    expect(isThinOpening('install this skill')).toBe(false);
  });
});

describe('titlePrompt', () => {
  it('fences the exchange so the model titles it instead of joining it', () => {
    const prompt = titlePrompt('[Voice, a note.] Book a flight to Lisbon', 'Done.');
    expect(prompt).toContain('<user>\nBook a flight to Lisbon\n</user>');
    expect(prompt).not.toMatch(/^User:/m);
  });
});
