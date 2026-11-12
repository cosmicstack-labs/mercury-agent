import { describe, expect, it } from 'vitest';
import { SubAgentSupervisor } from './supervisor.js';
import type { SubAgentConfig } from '../types/agent.js';

/** ADR-038: a halted sub-agent is never started again (step-budget resume, wait queue). */
describe('sub-agent halt is final', () => {
  function bare() {
    const sup = Object.create(SubAgentSupervisor.prototype) as SubAgentSupervisor;
    Object.assign(sup, {
      haltedIds: new Set<string>(),
      stepResumeCounts: new Map(),
      agentConfigs: new Map(),
      activeAgents: new Map(),
      waitQueue: [],
      taskBoard: { update: () => {} },
    });
    const internals = sup as unknown as {
      startAgentInBackground(c: SubAgentConfig): void;
      agentConfigs: Map<string, SubAgentConfig>;
      waitQueue: SubAgentConfig[];
    };
    return { sup, internals };
  }

  it('a halted id is refused by the starter', async () => {
    const { sup, internals } = bare();
    const config = { id: 'agent-1', task: 't', sourceChannelId: 'chat-a', sourceChannelType: 'web' } as SubAgentConfig;
    internals.waitQueue.push(config);
    expect(await sup.haltForChannel('chat-a')).toEqual(['agent-1']);
    expect(sup.wasHalted('agent-1')).toBe(true);
    internals.startAgentInBackground(config);
    expect(internals.agentConfigs.has('agent-1')).toBe(false);
  });

  it("halting one chat leaves another chat's agents alone", async () => {
    const { sup, internals } = bare();
    internals.waitQueue.push({ id: 'a', task: 't', sourceChannelId: 'chat-a' } as SubAgentConfig, { id: 'b', task: 't', sourceChannelId: 'chat-b' } as SubAgentConfig);
    await sup.haltForChannel('chat-a');
    expect(internals.waitQueue.map((c) => c.id)).toEqual(['b']);
    expect(sup.wasHalted('b')).toBe(false);
  });
});
