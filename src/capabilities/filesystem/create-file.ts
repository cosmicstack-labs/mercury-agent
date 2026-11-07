import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, isAbsolute } from 'node:path';
import type { PermissionManager } from '../permissions.js';
import { verifyCreateParent } from './verified-write.js';

export function createCreateFileTool(permissions: PermissionManager, getCwd: () => string) {
  return tool({
    description: 'Create a new file with the given content. Also creates parent directories if needed. The path must be within a writable scope.',
    inputSchema: zodSchema(z.object({
      path: z.string().describe('Absolute or relative path for the new file'),
      content: z.string().describe('The content of the new file'),
    })),
    execute: async ({ path, content }) => {
      const resolved = isAbsolute(path) ? resolve(path) : resolve(getCwd(), path);
      const check = await permissions.checkFsAccess(resolved, 'write');
      if (!check.allowed) {
        if (check.code === 'hardlink') return `Error: ${check.reason}`;
        const parentDir = resolve(resolved, '..');
        return `Error: Permission denied for write access to ${resolved}. Use the approve_scope tool with path="${parentDir}" and mode="write" to request access from the user.`;
      }

      if (existsSync(resolved)) {
        return `Error: File already exists: ${resolved}. Use write_file to modify existing files.`;
      }

      const parentError = verifyCreateParent(check, resolved);
      if (parentError) return parentError;

      try {
        const target = check.canonical ?? resolved;
        const dir = dirname(target);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        // Exclusive creation refuses a file or symlink planted after approval.
        writeFileSync(target, content, { encoding: 'utf-8', flag: 'wx' });
        return `Successfully created ${resolved} (${content.length} bytes)`;
      } catch (err: any) {
        return `Error creating file: ${err.message}`;
      }
    },
  });
}