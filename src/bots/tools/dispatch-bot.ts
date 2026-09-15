import { tool, zodSchema } from 'ai';
import { z } from 'zod';

export interface BotDispatchResult {
  accepted: boolean;
  jobId?: string;
  reasonCode?: string;
}

/**
 * dispatch_bot — lets the MAIN agent hand a task to a Mercury bot
 * mid-conversation. The bot runs outside the main loop; its output is
 * delivered to the invoking channel when it finishes.
 */
export function createDispatchBotTool(handler: (botId: string, message: string, ctx: { channelType: string; channelId: string }) => BotDispatchResult | null, channelCtx: () => { channelType: string; channelId: string }) {
  return tool({
    description:
      'Hand a task to one of the user\'s Mercury bots (persistent specialist agents with their own persona and tools). ' +
      'Use this when a request matches a bot\'s specialty and the work is delegable (research, publishing, monitoring) — ' +
      'the bot runs outside this conversation and its result is delivered here when done.',
    inputSchema: zodSchema(z.object({
      bot: z.string().describe('Bot id or name'),
      message: z.string().min(1).max(20000).describe('The task for the bot — self-contained and concrete'),
    })),
    execute: async ({ bot, message }: { bot: string; message: string }) => {
      const result = handler(bot, message, channelCtx());
      if (!result) {
        return 'Bots are not available on this instance.';
      }
      if (!result.accepted) {
        return `Dispatch rejected: [reason: ${result.reasonCode}] — check /bots for the roster and states.`;
      }
      return `Dispatched to ${bot} (job ${result.jobId}). The bot runs outside this conversation; its reply will be delivered to this chat when it finishes. Continue helping the user in the meantime.`;
    },
  });
}