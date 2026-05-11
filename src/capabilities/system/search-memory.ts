import { tool } from 'ai';
import { z } from 'zod';
import type { UserMemoryStore } from '../../memory/user-memory.js';

export function createSearchMemoryTool(userMemory: UserMemoryStore) {
  return tool({
    description:
      'Search your Second Brain (SQLite-backed long-term memory) for facts, preferences, goals, or relationships about the user. Use this when you need to actively recall something that was not auto-injected into context — for example, when the user asks "do you remember..." or "what do you know about..." or you need to check if prior knowledge exists before answering.',
    parameters: z.object({
      query: z.string().describe('Search terms to look up in the Second Brain'),
      type: z.enum([
        'identity',
        'preference',
        'goal',
        'project',
        'habit',
        'decision',
        'constraint',
        'relationship',
        'episode',
      ]).optional().describe('Optional: filter to a specific memory type'),
      limit: z.number().min(1).max(20).default(5).describe('Maximum number of results'),
    }),
    execute: async ({ query, type, limit }) => {
      let results;

      if (type) {
        const all = userMemory.getByType(type);
        const lowerQuery = query.toLowerCase();
        const terms = lowerQuery.split(/\s+/).filter(t => t.length > 1);
        results = all.filter(r => {
          const text = `${r.summary} ${r.detail ?? ''}`.toLowerCase();
          return terms.some(t => text.includes(t));
        }).slice(0, limit);
      } else {
        results = userMemory.search(query, limit);
      }

      if (results.length === 0) {
        return `No memories found for "${query}".`;
      }

      const lines = results.map(
        r => `- [${r.type}] ${r.summary}${r.detail ? ` — ${r.detail.slice(0, 120)}` : ''}`,
      );
      return `Found ${results.length} memory${results.length > 1 ? 'ies' : 'y'}:\n${lines.join('\n')}`;
    },
  });
}