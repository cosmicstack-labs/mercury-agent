import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, dirname, isAbsolute } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { PermissionManager } from '../permissions.js';

export function createWriteFileTool(permissions: PermissionManager, getCwd: () => string) {
  return tool({
    description: 'Write content to an existing file. The path must be within a writable scope.',
    inputSchema: zodSchema(z.object({
      path: z.string().describe('Absolute or relative path to the file'),
      content: z.string().describe('The content to write to the file'),
    })),
    execute: async ({ path, content }) => {
      const resolved = isAbsolute(path) ? resolve(path) : resolve(getCwd(), path);
      const check = await permissions.checkFsAccess(resolved, 'write');
      if (!check.allowed) {
        const parentDir = resolve(resolved, '..');
        return `Error: Permission denied for write access to ${resolved}. Use the approve_scope tool with path="${parentDir}" and mode="write" to request access from the user.`;
      }

      if (!existsSync(resolved)) {
        return `Error: File not found: ${resolved}. Use create_file to create new files.`;
      }

      try {
        writeFileSync(resolved, content, 'utf-8');
        return `Successfully wrote ${content.length} bytes to ${resolved}`;
      } catch (err: any) {
        return `Error writing file: ${err.message}`;
      }
    },
  });
}