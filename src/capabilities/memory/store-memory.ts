import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import type { UserMemoryStore } from '../../memory/user-memory.js';
import type { SharedMemoryStore } from '../../memory/shared-memory-store.js';

const VALID_TYPES = [
  'identity', 'preference', 'goal', 'project', 'habit',
  'decision', 'constraint', 'relationship', 'episode',
] as const;

export function createStoreMemoryTool(
  getUserMemory: () => UserMemoryStore | null,
  getSharedMemory: () => SharedMemoryStore | null,
) {
  return tool({
    description:
      'Store a fact about the user in long-term memory. Use this when the user explicitly asks you to remember something. ' +
      'The memory is stored in Second Brain (personal) and Shared Memory (if enabled and not paused) independently. ' +
      'Do NOT fabricate a confirmation — the tool returns what was actually stored.',
    inputSchema: zodSchema(
      z.object({
        type: z.enum(VALID_TYPES).describe(
          'The memory type: identity (who they are), preference (likes/dislikes), goal (aspirations), ' +
          'project (current work), habit (routines), decision (choices made), constraint (limitations), ' +
          'relationship (connections to people), episode (notable events)',
        ),
        summary: z
          .string()
          .min(12)
          .max(220)
          .describe('Concise factual statement, 12-220 characters. Write in third person (e.g. "User is joining as CTO at Cosmic Stack").'),
        detail: z
          .string()
          .optional()
          .describe('Optional longer explanation or context.'),
        category: z
          .string()
          .optional()
          .describe('Domain category for shared memory (e.g. personal, professional, health, technical). Defaults to "general".'),
      }),
    ),
    execute: async ({ type, summary, detail, category }) => {
      const userMemory = getUserMemory();
      const sharedMemory = getSharedMemory();
      const results: string[] = [];

      const candidate = {
        type: type as typeof VALID_TYPES[number],
        summary: summary.trim(),
        detail: detail?.trim(),
        evidenceKind: 'direct' as const,
        confidence: 0.95,
        importance: 0.85,
        durability: 0.9,
      };

      // Store in Second Brain (personal memory)
      if (userMemory) {
        if (userMemory.isLearningPaused()) {
          results.push('Second Brain: skipped (learning paused)');
        } else {
          const remembered = userMemory.remember([candidate], 'conversation');
          if (remembered.length > 0) {
            results.push(`Second Brain: stored [${remembered[0].type}] "${remembered[0].summary}"`);
          } else {
            results.push('Second Brain: merged with existing memory or filtered by quality check');
          }
        }
      } else {
        results.push('Second Brain: not available');
      }

      // Store in Shared Memory
      if (sharedMemory) {
        if (sharedMemory.isLearningPaused()) {
          results.push('Shared Memory: skipped (learning paused)');
        } else {
          const sharedCandidate = {
            ...candidate,
            category: category || 'general',
          };
          const remembered = sharedMemory.remember([sharedCandidate]);
          if (remembered.length > 0) {
            results.push(`Shared Memory: stored [${remembered[0].type}] in category "${remembered[0].category}"`);
          } else {
            results.push('Shared Memory: merged with existing memory or filtered by quality check');
          }
        }
      } else {
        results.push('Shared Memory: not available');
      }

      return results.join('\n');
    },
  });
}
