import { afterAll, describe, expect, it } from 'vitest';
import { EvalHarness } from '../runner.js';
import { call, textStep, toolStep } from '../fixture.js';
import { promptText } from '../script-player.js';

describe('eval · retrieve a different persisted conversation', () => {
  afterAll(async () => (await import('../env.js')).removeEvalRoot());

  it.each(['web', 'desktop'] as const)('%s can read a past session without Second Brain extraction', async (type) => {
    const harness = await EvalHarness.create({ name: `past-session-${type}`, channel: { type, style: 'plain', streaming: type === 'web' }, turns: [] });
    try {
      const old = harness.sessions.create({ title: 'Launch planning' });
      const source = harness.sessions.appendMessage(old.id, { role: 'user', content: 'The launch-code is cobalt-otter-739. Keep it in the planning transcript.' });
      expect(harness.agent.userMemory).toBeNull();
      expect(harness.capabilities.getTools()).toHaveProperty('search_sessions');
      expect(harness.capabilities.getPlanTools()).toHaveProperty('read_session');

      const result = await harness.runTurn({
        message: 'Look up our launch planning conversation and tell me the launch-code we chose.',
        steps: [
          toolStep([call('search_sessions', { query: 'launch-code' })]),
          toolStep([call('read_session', { session_id: old.id })]),
          textStep(`We chose cobalt-otter-739 (Launch planning, message ${source.sequence}).`),
        ],
        expect: { finalTextIncludes: ['cobalt-otter-739'], toolsUsed: ['search_sessions', 'read_session'] },
      });
      expect(result.failures).toEqual([]);
      expect(result.toolCalls.map((entry) => entry.recorded)).toEqual([false, false]);
      expect(promptText(result.providerCalls[0].prompt)).not.toContain('cobalt-otter-739');
      expect(promptText(result.providerCalls[2].prompt)).toContain('cobalt-otter-739');
      expect(promptText(result.providerCalls[2].prompt)).toContain(source.id);
      expect(harness.sessions.get(old.id).messages).toHaveLength(1);
    } finally {
      await harness.dispose();
    }
  });
});
