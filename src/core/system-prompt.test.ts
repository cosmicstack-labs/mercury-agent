import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, environmentSection, type SystemPromptInputs } from './system-prompt.js';

const base: SystemPromptInputs = {
  identityPrompt: 'You are Mercury.',
  skillContext: '',
  botSection: '',
  programmingSuffix: '',
  researchSuffix: '',
  budgetStatus: 'Token budget: 1,000 / 100,000 used today.',
  budgetUsagePercentage: 1,
  saverSuffix: '',
  cwd: '/repo',
  now: new Date('2026-10-09T18:42:00Z'),
  platform: 'darwin',
  timezone: 'UTC',
  memorySummary: null,
  toolNames: ['read_file', 'run_command'],
  github: {},
};

describe('system prompt assembly', () => {
  it('starts with the identity and keeps the stable section order', () => {
    const p = buildSystemPrompt(base);
    expect(p.startsWith('You are Mercury.')).toBe(true);
    const order = ['Token budget', 'Environment:', 'Tool Usage Guidelines', 'Second Brain is DISABLED'].map((s) => p.indexOf(s));
    expect(order.every((v, i) => v > -1 && (i === 0 || v > order[i - 1]))).toBe(true);
  });

  it('renders the clock at hour resolution so the prefix stays cacheable', () => {
    const a = environmentSection(new Date('2026-10-09T18:42:00Z'), 'UTC', 'linux', '/w');
    const b = environmentSection(new Date('2026-10-09T18:57:00Z'), 'UTC', 'linux', '/w');
    expect(a).toBe(b);
    expect(a).toContain('about 6 PM');
    expect(a).toContain('Working directory: /w');
  });

  it('adds the concision hint above 70% budget and the saver suffix when given', () => {
    const p = buildSystemPrompt({ ...base, budgetUsagePercentage: 80, saverSuffix: '\n\nSAVER' });
    expect(p).toContain('Be concise to conserve tokens.');
    expect(p).toContain('SAVER');
    expect(buildSystemPrompt(base)).not.toContain('Be concise');
  });

  it('describes Second Brain when enabled, including the paused state', () => {
    const on = buildSystemPrompt({ ...base, memorySummary: { total: 276, learningPaused: false } });
    expect(on).toContain('You have 276 persistent memories');
    expect(on).not.toContain('PAUSED');
    const paused = buildSystemPrompt({ ...base, memorySummary: { total: 1, learningPaused: true } });
    expect(paused).toContain('Learning is currently PAUSED');
  });

  it('includes the GitHub section only when GitHub tools are registered', () => {
    expect(buildSystemPrompt(base)).not.toContain('GitHub companion');
    const p = buildSystemPrompt({
      ...base,
      toolNames: ['read_file', 'github_api'],
      github: { defaultOwner: 'cosmicstack-labs', defaultRepo: 'mercury-agent', username: 'hotheadhacker' },
    });
    expect(p).toContain('GitHub companion is active. Default repo: cosmicstack-labs/mercury-agent.');
    expect(p).toContain("The user's GitHub username is hotheadhacker.");
  });

  it('includes skills, bots and mode suffixes verbatim', () => {
    const p = buildSystemPrompt({ ...base, skillContext: 'SKILLS: tweet-notifier', botSection: '\n\nBOTS', programmingSuffix: '\n\nCODE', researchSuffix: '\n\nRESEARCH' });
    for (const s of ['SKILLS: tweet-notifier', 'BOTS', 'CODE', 'RESEARCH', 'Tweet Notification System Available']) expect(p).toContain(s);
  });
});
