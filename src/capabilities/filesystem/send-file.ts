import { checkVideo } from '../../media/blank-check.js';
import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { existsSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import type { PermissionManager } from '../permissions.js';
import { readDenialMessage } from './verified-read.js';
import { resolveToolPath, type CwdSource } from './resolve-path.js';

export function createSendFileTool(
  permissions: PermissionManager,
  getCwd: CwdSource,
  sendFile: (filePath: string, channel?: string) => Promise<void>,
) {
  return tool({
    description:
      'Send a file to the user. Use the channel parameter to send via a specific channel (signal, telegram). If omitted, sends via the current channel or the best available channel.',
    inputSchema: zodSchema(z.object({
      path: z.string().describe('Absolute or relative path to the file to send'),
      channel: z.enum(['signal', 'telegram']).optional().describe('The channel to send the file via. Use this when the user explicitly requests a specific channel, e.g. "send via Signal" or "send to Telegram".'),
    })),
    execute: async ({ path, channel }) => {
      const resolved = resolveToolPath(path, getCwd);
      const check = await permissions.checkFsAccess(resolved, 'read');
      if (!check.allowed) {
        return readDenialMessage(resolved, check);
      }

      // Send the canonical target the check authorised, never the lexical path.
      const target = check.canonical ?? resolved;
      if (!existsSync(target)) {
        return `Error: File not found: ${resolved}`;
      }

      const stat = statSync(target);
      if (stat.isDirectory()) {
        return `Error: ${resolved} is a directory, not a file. Use list_dir to show its contents.`;
      }

      if (stat.size > 50 * 1024 * 1024) {
        return `Error: File too large (${Math.round(stat.size / (1024 * 1024))}MB). Maximum is 50MB.`;
      }

      // A video that never rendered (all black, or one still frame) isn't sent as if it worked.
      const blank = await checkVideo(target).catch(() => null);
      if (blank) {
        return `Not sent: ${basename(resolved)} isn't a real video — ${blank.problem}. Fix the render (check that the composition actually draws and animates when captured), or tell the user plainly what went wrong. Don't send it or describe it as finished.`;
      }

      try {
        await sendFile(target, channel);
        const filename = basename(resolved);
        const sizeStr =
          stat.size > 1024 * 1024
            ? `${(stat.size / (1024 * 1024)).toFixed(1)}MB`
            : `${Math.round(stat.size / 1024)}KB`;
        return `File sent: ${filename} (${sizeStr})`;
      } catch (err: any) {
        return `Error sending file: ${err.message}`;
      }
    },
  });
}
