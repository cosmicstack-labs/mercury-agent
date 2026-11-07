import { describe, it, expect } from 'vitest';
import { proposeCrew } from './fleet-onboarding.js';

function providerReturning(text: string) {
  return {
    name: 'stub', model: 'stub',
    generateText: async () => ({ text, inputTokens: 0, outputTokens: 0, totalTokens: 0, model: 'stub', provider: 'stub' }),
    streamText: async function* () { yield { text: '', done: true }; },
    isAvailable: () => true, getModelInstance: () => ({}), getModel: () => 'stub',
  } as any;
}

const validCrew = JSON.stringify([
  { id: 'market-research', name: 'Market Researcher', description: 'Research', persona: 'A rigorous market researcher who verifies every claim and reports with sources.' },
  { id: 'copywriter', name: 'Copywriter', persona: 'A punchy copywriter who drafts launch angles with concrete evidence and never invents numbers.' },
]);

describe('proposeCrew (fleet auto-onboarding)', () => {
  it('parses a valid crew proposal and caps it at maxCrew', async () => {
    const proposals = await proposeCrew('CEO', 'Runs the company', '# CEO persona', providerReturning(validCrew), 1);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].id).toBe('market-research');
  });

  it('strips code fences and surrounding prose', async () => {
    const wrapped = 'Sure! Here is the crew:\n```json\n' + validCrew + '\n```';
    const proposals = await proposeCrew('CEO', '', '', providerReturning(wrapped));
    expect(proposals).toHaveLength(2);
  });

  it('rejects malformed entries (bad ids, tiny personas, duplicates) and unusable output', async () => {
    const bad = JSON.stringify([
      { id: 'Bad Id', name: 'X', persona: 'ok persona that is long enough to pass the length gate here' },
      { id: 'ok-id', name: 'Y', persona: 'valid persona long enough to pass the length gate' },
      { id: 'ok-id', name: 'Dup', persona: 'duplicate id should be dropped from the proposal list here.' },
    ]);
    expect(await proposeCrew('CEO', '', '', providerReturning(bad)).then(p => p.map(x => x.id))).toEqual(['ok-id']);
    expect(await proposeCrew('CEO', '', '', providerReturning('no json here at all'))).toHaveLength(0);
    const throwing = { ...providerReturning('[]'), generateText: async () => { throw new Error('500'); } } as any;
    expect(await proposeCrew('CEO', '', '', throwing)).toHaveLength(0);
  });
});
describe('planBotShape — "let Mercury decide"', () => {
  const answer = (text: string) => ({ generateText: async () => ({ text }) }) as never;
  const input = { name: 'Newsroom', description: 'Researches, writes and checks articles', persona: 'Find stories, write them, check facts.' };

  it('a fleet comes back with its crew, ids cleaned and capped', async () => {
    const { planBotShape } = await import('./fleet-onboarding.js');
    const crew = Array.from({ length: 7 }, (_, i) => ({ id: `Bad Id ${i}`, name: `Specialist ${i}`, description: 'x', persona: 'A focused specialist who reports back to the lead clearly.' }));
    const plan = await planBotShape(input, answer(JSON.stringify({ shape: 'fleet', reason: 'Three separate stages.', crew })));
    expect(plan.shape).toBe('fleet');
    expect(plan.reason).toBe('Three separate stages.');
    expect(plan.crew).toHaveLength(5);
    for (const c of plan.crew) expect(c.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });

  it('solo when the model says so, when a "fleet" has fewer than two crew, or when the answer is unusable', async () => {
    const { planBotShape } = await import('./fleet-onboarding.js');
    expect((await planBotShape(input, answer('{"shape":"solo","reason":"One focused job.","crew":[]}')))).toEqual({ shape: 'solo', reason: 'One focused job.', crew: [] });
    const one = await planBotShape(input, answer(JSON.stringify({ shape: 'fleet', reason: 'x', crew: [{ id: 'a', name: 'A', description: '', persona: 'A specialist with a long enough persona.' }] })));
    expect(one.shape).toBe('solo');
    expect((await planBotShape(input, answer('I think a fleet would be lovely'))).shape).toBe('solo');
    const failing = { generateText: async () => { throw new Error('no provider'); } } as never;
    expect((await planBotShape(input, failing)).shape).toBe('solo');
  });
});
