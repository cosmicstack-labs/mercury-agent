import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import type { UserMemoryStore } from '../../memory/user-memory.js';
import { findBeliefByText } from '../../core/commands/memory-commands.js';

/**
 * confirm_belief — the owner said "yes, that's right" about something Mercury
 * believes (ADR-026). A confirmed belief is owner-stated: it stops decaying and
 * wins any contest on the same dimension.
 */
export function createConfirmBeliefTool(userMemory: UserMemoryStore) {
  return tool({
    description:
      'Confirm something you believe about the user when they say it is right ("yes, exactly", "that\'s correct, I do prefer X"). Finds the best-matching belief and marks it confirmed by the owner so it no longer fades. Reply with what was confirmed.',
    inputSchema: zodSchema(z.object({
      query: z.string().min(2).max(200).describe('The belief to confirm, in a few words'),
    })),
    execute: async ({ query }: { query: string }) => {
      const belief = findBeliefByText(userMemory.beliefs, query);
      if (!belief) return `Nothing I believe matches "${query.trim()}". If this is new, use save_memory instead.`;
      const confirmed = userMemory.beliefs.confirm(belief.id);
      if (!confirmed) return `"${belief.statement}" is no longer held, so there is nothing to confirm.`;
      return `Confirmed: "${confirmed.statement}"`;
    },
  });
}
