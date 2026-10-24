import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import type { UserMemoryStore } from '../../memory/user-memory.js';
import { findBeliefByText } from '../../core/commands/memory-commands.js';

/**
 * correct_belief — the owner corrected something Mercury believes (ADR-026):
 * the old belief is retired (kept, with the correction as evidence) and the
 * replacement is held as owner-stated.
 */
export function createCorrectBeliefTool(userMemory: UserMemoryStore) {
  return tool({
    description:
      'Correct something you believe about the user when they say it is wrong ("no, I actually prefer Y", "that changed, now it\'s Z"). Finds the best-matching belief, retires it and holds the correction as what the owner stated. Reply with the old and new statements.',
    inputSchema: zodSchema(z.object({
      query: z.string().min(2).max(200).describe('The belief that is wrong, in a few words'),
      correction: z.string().min(3).max(220).describe('What is actually true, as one short statement about the user'),
    })),
    execute: async ({ query, correction }: { query: string; correction: string }) => {
      const belief = findBeliefByText(userMemory.beliefs, query);
      if (!belief) return `Nothing I believe matches "${query.trim()}". Use save_memory to record "${correction.trim()}" as new.`;
      const result = userMemory.beliefs.apply({ op: 'correction', beliefId: belief.id, statement: correction.trim(), excerpt: correction.trim(), evidenceKind: 'owner' });
      if (!result) return `Could not correct "${belief.statement}".`;
      return `Corrected: "${belief.statement}" → "${result.belief.statement}"`;
    },
  });
}
