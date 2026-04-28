import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import type { TokenBudget } from '../../utils/tokens.js';

export function createBudgetStatusTool(tokenBudget: TokenBudget) {
  return tool({
    description: 'Check the current token budget status — how many tokens have been used today, how many remain, and what percentage is consumed.',
    inputSchema: zodSchema(z.object({})),
    execute: async () => {
      return tokenBudget.getStatusText();
    },
  });
}