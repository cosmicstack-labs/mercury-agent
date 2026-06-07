import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { existsSync, statSync } from 'node:fs';
import { resolve, basename, isAbsolute } from 'node:path';
import type { PermissionManager } from '../permissions.js';

export function createSendFileTool(
  permissions: PermissionManager,
  getCwd: () => string,
  sendFile: (filePath: string, channel?: string) => Promise<void>,
  activeChannels?: string[],
) {
  const channelList = activeChannels && activeChannels.length > 0
    ? activeChannels.join(', ')
    : 'the configured channel';

  return tool({
    description:
      `Send a file to the user via ${channelList}. The file is uploaded as an attachment. The path must be within an allowed read scope. If a specific channel is mentioned (e.g. "send to Slack", "forward to Discord"), use the channel parameter.`,
    inputSchema: zodSchema(z.object({
      path: z.string().describe('Absolute or relative path to the file to send'),
      channel: z.string().optional().describe(`Specific channel to send to: ${channelList}. Omit to send to the current channel or all channels.`),
    })),
    execute: async ({ path, channel }) => {
      const resolved = isAbsolute(path) ? resolve(path) : resolve(getCwd(), path);
      const check = await permissions.checkFsAccess(resolved, 'read');
      if (!check.allowed) {
        const parentDir = resolve(resolved, '..');
        return `Error: Permission denied for read access to ${resolved}. Use the approve_scope tool with path="${parentDir}" and mode="read" to request access from the user.`;
      }

      if (!existsSync(resolved)) {
        return `Error: File not found: ${resolved}`;
      }

      const stat = statSync(resolved);
      if (stat.isDirectory()) {
        return `Error: ${resolved} is a directory, not a file. Use list_dir to show its contents.`;
      }

      if (stat.size > 50 * 1024 * 1024) {
        return `Error: File too large (${Math.round(stat.size / (1024 * 1024))}MB). Maximum is 50MB.`;
      }

      try {
        await sendFile(resolved, channel);
        const filename = basename(resolved);
        const sizeStr =
          stat.size > 1024 * 1024
            ? `${(stat.size / (1024 * 1024)).toFixed(1)}MB`
            : `${Math.round(stat.size / 1024)}KB`;
        const target = channel ? channel : 'the current channel';
        return `File sent to ${target}: ${filename} (${sizeStr})`;
      } catch (err: any) {
        return `Error sending file: ${err.message}`;
      }
    },
  });
}
