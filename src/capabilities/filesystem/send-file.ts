import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { existsSync, statSync } from 'node:fs';
import { resolve, basename, isAbsolute } from 'node:path';
import type { PermissionManager } from '../permissions.js';

export function createSendFileTool(
  permissions: PermissionManager,
  getCwd: () => string,
  sendFile: (filePath: string) => Promise<void>,
) {
  return tool({
    description:
      'Send a file to the user. On Telegram the file is uploaded as an attachment to the relevant approved recipients. On CLI the file path and size are displayed. The path must be within an allowed read scope.',
    inputSchema: zodSchema(z.object({
      path: z.string().describe('Absolute or relative path to the file to send'),
    })),
    execute: async ({ path }) => {
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
        await sendFile(resolved);
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
