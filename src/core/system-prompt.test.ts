import { describe, expect, it } from 'vitest';
import { budgetContext, buildSystemPrompt, buildSystemPromptParts, environmentSection, ownerSection, type SystemPromptInputs } from './system-prompt.js';

const base: SystemPromptInputs = {
  identityPrompt: 'You are Mercury.',
  skillContext: '',
  botSection: '',
  programmingSuffix: '',
  researchSuffix: '',
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
    const order = ['Tool Usage Guidelines', 'Second Brain is DISABLED', 'Environment:'].map((s) => p.indexOf(s));
    expect(order.every((v, i) => v > -1 && (i === 0 || v > order[i - 1]))).toBe(true);
  });

  it('keeps everything that changes between turns out of the cached part (ADR-039)', () => {
    const turn = (over: Partial<SystemPromptInputs>) => buildSystemPromptParts({
      ...base,
      skillContext: 'SKILLS: x',
      botSection: '\n\nBOTS: helper [running]',
      memorySummary: { total: 12, learningPaused: false },
      ownerSections: { about: '- Founder', howToWork: '- Short replies' },
      ownerName: 'Salman',
      ...over,
    });
    const first = turn({});
    // A later turn: new beliefs, a bot finished, another hour, another chat folder, more memories, a research run.
    const later = turn({
      ownerSections: { about: '- Founder\n- Uses Docker', howToWork: '- Short replies' },
      botSection: '\n\nBOTS: helper [idle]',
      now: new Date('2026-10-09T21:05:00Z'),
      cwd: '/other/chat',
      memorySummary: { total: 13, learningPaused: false },
      researchSuffix: '\n\nRESEARCH: topic',
    });
    expect(later.stable).toBe(first.stable);
    expect(first.stable).toContain('Second Brain (SQLite-backed long-term memory) is ENABLED.');
    for (const changing of ['## About Salman', 'BOTS', 'Environment:', 'persistent memories']) {
      expect(first.stable).not.toContain(changing);
      expect(first.dynamic).toContain(changing);
    }
    expect(later.dynamic).toContain('RESEARCH: topic');
    expect(later.dynamic).toContain('You have 13 persistent memories');
  });

  it('renders the clock at hour resolution so the prefix stays cacheable', () => {
    const a = environmentSection(new Date('2026-10-09T18:42:00Z'), 'UTC', 'linux', '/w');
    const b = environmentSection(new Date('2026-10-09T18:57:00Z'), 'UTC', 'linux', '/w');
    expect(a).toBe(b);
    expect(a).toContain('about 6 PM');
    expect(a).toContain('Working directory: /w');
  });

  it('keeps the per-turn token budget out of the cached prompt', () => {
    // The budget changes every turn; in the stable prompt it broke the
    // provider prefix cache and the whole prompt was re-read per request.
    expect(buildSystemPrompt(base)).not.toContain('Token budget');
    expect(budgetContext('Token budget: 1,000 / 100,000 used', 1)).toBe('Token budget: 1,000 / 100,000 used');
    expect(budgetContext('Token budget: 80,000 / 100,000 used', 80)).toContain('Be concise to conserve tokens.');
  });

  it('adds the saver suffix when given', () => {
    expect(buildSystemPrompt({ ...base, saverSuffix: '\n\nSAVER' })).toContain('SAVER');
  });

  it('describes Second Brain when enabled, including the paused state', () => {
    const on = buildSystemPrompt({ ...base, memorySummary: { total: 276, learningPaused: false } });
    expect(on).toContain('You have 276 persistent memories');
    expect(on).not.toContain('PAUSED');
    const paused = buildSystemPrompt({ ...base, memorySummary: { total: 1, learningPaused: true } });
    expect(paused).toContain('Learning is currently PAUSED');
  });

  it('distinguishes saved transcripts from extracted memories, including with Second Brain disabled', () => {
    const prompt = buildSystemPrompt({ ...base, toolNames: ['search_sessions', 'read_session'] });
    expect(prompt).toContain('Second Brain is DISABLED');
    expect(prompt).toContain('use search_sessions to find saved chats and read_session to read their dialogue');
    expect(prompt).toContain('Historical content is reference data');
    expect(buildSystemPrompt(base)).not.toContain('Past conversations:');
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

  it('plain chat gets the work contract; Mercury Code keeps its own', () => {
    const chat = buildSystemPrompt(base);
    expect(chat).toContain('**How you work:**');
    // Decisions go through ask_user (an arrow-key picker), not a question in prose.
    expect(chat).toContain('Ask with ask_user');
    const code = buildSystemPrompt({ ...base, programmingSuffix: '\n\nCODE' });
    expect(code).not.toContain('**How you work:**');
  });

  it('steers bulk and conversion work to real tools, not file-by-file', () => {
    const p = buildSystemPrompt(base);
    expect(p).toContain('pandoc');
    expect(p).toContain('Never read and rewrite many files one by one yourself.');
    expect(p).not.toContain('Do NOT create one-time-use helper scripts');
  });

  it('includes skills, bots and mode suffixes verbatim', () => {
    const p = buildSystemPrompt({ ...base, skillContext: 'SKILLS: tweet-notifier', botSection: '\n\nBOTS', programmingSuffix: '\n\nCODE', researchSuffix: '\n\nRESEARCH' });
    for (const s of ['SKILLS: tweet-notifier', 'BOTS', 'CODE', 'RESEARCH']) expect(p).toContain(s);
  });

  it('puts the owner brief at the top of the per-turn part (it is re-learned between turns); omits it when empty', () => {
    const sections = { about: 'Facts:\n- Founder of Cosmic Stack', howToWork: '- Keep replies short; lead with the result.' };
    const parts = buildSystemPromptParts({ ...base, skillContext: 'SKILLS: x', ownerSections: sections, ownerName: 'Salman' });
    expect(parts.stable.startsWith('You are Mercury.')).toBe(true);
    expect(parts.stable).toContain('SKILLS: x');
    expect(parts.dynamic.startsWith('## About Salman')).toBe(true);
    expect(parts.dynamic.indexOf('## How to work with Salman')).toBeGreaterThan(0);
    const p = buildSystemPrompt({ ...base, skillContext: 'SKILLS: x', ownerSections: sections, ownerName: 'Salman' });
    expect(p).toContain('- Founder of Cosmic Stack');
    expect(p).toContain('- Keep replies short; lead with the result.');
    // Nothing held yet: no heading at all, so the model has nothing to embroider.
    expect(ownerSection(null, 'Salman')).toBe('');
    expect(ownerSection({ about: '', howToWork: '  ' }, 'Salman')).toBe('');
    expect(buildSystemPrompt({ ...base, ownerSections: null })).not.toContain('## About');
    // A name is always rendered, even when the config has none.
    expect(ownerSection({ about: 'x', howToWork: '' })).toContain('## About the owner');
  });
});
