import { tool } from 'ai';
import { z } from 'zod';
import type { UserMemoryStore } from '../../memory/user-memory.js';

export function createSaveMemoryTool(userMemory: UserMemoryStore) {
  return tool({
    description:
      'Explicitly save a fact, preference, goal, or other durable knowledge to your Second Brain (SQLite-backed long-term memory). Use this when the user directly asks you to remember/save/note something, or when you decide a specific piece of information is important enough to persist. Do NOT ask the user for confirmation — just save it.',
    parameters: z.object({
      summary: z.string().min(12).max(220).describe('Concise fact to remember, 12-220 characters'),
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
      ]).describe('Memory type'),
      detail: z.string().optional().describe('Optional longer explanation or context'),
      importance: z.number().min(0).max(1).default(0.8).describe('How important this fact is, 0.0-1.0'),
    }),
    execute: async ({ summary, type, detail, importance }) => {
      if (userMemory.isLearningPaused()) {
        return 'Learning is currently paused. Resume with /memory learn to enable saving.';
      }

      const candidates = [
        {
          type,
          summary: summary.trim(),
          detail: detail?.trim(),
          evidenceKind: 'direct' as const,
          confidence: 0.9,
          importance,
          durability: 0.85,
        },
      ];

      const remembered = userMemory.remember(candidates, 'conversation');

      if (remembered.length > 0) {
        const r = remembered[0];
        return `Saved to Second Brain: [${r.type}] ${r.summary}`;
      }

      return 'Not stored — may have been merged with an existing memory or below confidence threshold.';
    },
  });
}