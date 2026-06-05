import { tool, zodSchema } from 'ai';
import { z } from 'zod';

export function createSendMessageTool(
  sendMessage: (content: string, channel?: string) => Promise<void>,
  activeChannels?: string[],
) {
  const channelList = activeChannels && activeChannels.length > 0
    ? activeChannels.join(', ')
    : 'the configured outbound channel';

  return tool({
    description:
      `Send a message through ${channelList}. Use this when the user explicitly asks you to send something to their messaging channels or when scheduled results need to be delivered. If a specific channel is mentioned (e.g. "send to Slack", "forward to Telegram"), use the channel parameter. Otherwise omit it to send to all connected channels.`,
    inputSchema: zodSchema(z.object({
      content: z.string().describe('The message content to send to approved recipients'),
      channel: z.string().optional().describe(`Specific channel to send to: ${channelList}. Omit to send to all channels.`),
    })),
    execute: async ({ content, channel }) => {
      const trimmed = content.trim();
      if (!trimmed) {
        return 'Error: Message content cannot be empty.';
      }

      try {
        await sendMessage(trimmed, channel);
        const target = channel ? channel : channelList;
        return `Message sent to approved recipients via ${target}.`;
      } catch (err: any) {
        return `Error sending message: ${err.message}`;
      }
    },
  });
}
