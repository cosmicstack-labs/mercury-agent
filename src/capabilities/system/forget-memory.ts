import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import type { UserMemoryStore } from '../../memory/user-memory.js';
import { findBeliefByText } from '../../core/commands/memory-commands.js';

/**
 * forget_memory — the owner asked Mercury to forget something it believes
 * about them (ADR-026). Forgets the best-matching live belief; it leaves every
 * prompt and list for good (the row is kept, marked forgotten, never deleted).
 */
export function createForgetMemoryTool(userMemory: UserMemoryStore) {
  return tool({
    description:
      'Forget something you believe about the user. Use when they say "forget that", "stop assuming X" or "don\'t remember Y". Finds the best-matching belief and forgets it for good; reply with what was forgotten. Do not ask for confirmation first.',
    inputSchema: zodSchema(z.object({
      query: z.string().min(2).max(200).describe('What to forget, in a few words (e.g. "prefers dark mode", "works at Cosmic Stack")'),
    })),
    execute: async ({ query }: { query: string }) => {
      const belief = findBeliefByText(userMemory.beliefs, query);
      if (!belief) return `Nothing I believe matches "${query.trim()}". Nothing was forgotten.`;
      userMemory.beliefs.forget(belief.id);
      return `Forgotten: "${belief.statement}"`;
    },
  });
}
