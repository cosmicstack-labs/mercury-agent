import { tool, zodSchema } from 'ai';
import { z } from 'zod';

export function createSendMessageTool(
  sendMessage: (content: string) => Promise<void>,
  activeChannels?: string[],
) {
  const channelList = activeChannels && activeChannels.length > 0
    ? activeChannels.join(', ')
    : 'the configured outbound channel';

  return tool({
    description:
      `Send a message through ${channelList}. This sends to all approved recipients on connected messaging channels (Telegram, Signal, etc.). Use this when the user explicitly asks you to send something to their messaging channels or when scheduled results need to be delivered.`,
    inputSchema: zodSchema(z.object({
      content: z.string().describe('The message content to send to approved recipients'),
    })),
    execute: async ({ content }) => {
      const trimmed = content.trim();
      if (!trimmed) {
        return 'Error: Message content cannot be empty.';
      }

      try {
        await sendMessage(trimmed);
        return `Message sent to approved recipients via ${channelList}.`;
      } catch (err: any) {
        return `Error sending message: ${err.message}`;
      }
    },
  });
}
