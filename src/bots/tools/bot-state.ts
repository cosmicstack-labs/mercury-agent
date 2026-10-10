import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import type { BotStore } from '../store.js';

/** Working state is a note, not a ledger: bounded, replaced, never appended. */
export const BOT_STATE_MAX_CHARS = 1500;

/**
 * bot_state — the one place a bot keeps "what I'm in the middle of": a
 * short note Mercury shows it at the start of every turn (ADR-021). It
 * replaces the records-about-records habit: there is no reason to write a
 * status file when the next turn already sees this, the recent-runs digest
 * and its delegated tasks.
 */
export function createBotStateTool(store: BotStore, botId: string) {
  return tool({
    description:
      'Set your working state — a short note (≤1500 chars) you will see at the start of your next turn: what you are ' +
      'working on, what is pending, decisions taken. It REPLACES the previous note. Use it instead of writing status files.',
    inputSchema: zodSchema(z.object({
      state: z.string().max(BOT_STATE_MAX_CHARS).describe('The new note (empty string clears it)'),
    })),
    execute: async ({ state }: { state: string }) => {
      store.writeState(botId, state.trim());
      return state.trim() ? `Working state saved (${state.trim().length} chars). You will see it next turn.` : 'Working state cleared.';
    },
  });
}
