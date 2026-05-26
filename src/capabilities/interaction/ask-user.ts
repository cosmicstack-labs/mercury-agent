import { tool } from 'ai';
import { z } from 'zod';
import { zodSchema } from 'ai';

type AskUserCallback = (question: string, choices: string[], channelId: string, channelType: string) => Promise<string>;

let askUserHandler: AskUserCallback | null = null;

export function setAskUserHandler(handler: AskUserCallback): void {
  askUserHandler = handler;
}

export function createAskUserTool(getContext: () => { channelId: string; channelType: string }) {
  return tool({
    description: 'Ask the user a question with multiple choice options. Use this when there are multiple viable approaches and you need the user to decide. Also use for confirmation before proceeding with important actions. The user selects from the choices you provide.',
    inputSchema: zodSchema(z.object({
      question: z.string().describe('The question to ask the user'),
      choices: z.array(z.string()).min(2).describe('List of choices for the user to pick from (minimum 2). Each choice should be a short, clear option label.'),
    })),
    execute: async ({ question, choices }) => {
      if (!askUserHandler) {
        return 'Unable to ask user: no handler available. Proceed with your best judgment.';
      }
      try {
        const ctx = getContext();
        const answer = await askUserHandler(question, choices, ctx.channelId, ctx.channelType);
        return answer;
      } catch (err: any) {
        return `User did not respond: ${err.message}. Proceed with your best judgment.`;
      }
    },
  });
}