import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { existsSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PermissionManager } from '../permissions.js';
import { resolveToolPath, type CwdSource } from './resolve-path.js';

export function createDeleteFileTool(permissions: PermissionManager, getCwd: CwdSource) {
  return tool({
    description: 'Delete a file. This action cannot be undone. The path must be within a writable scope. Always asks for confirmation.',
    inputSchema: zodSchema(z.object({
      path: z.string().describe('Absolute or relative path to the file to delete'),
    })),
    execute: async ({ path }) => {
      const resolved = resolveToolPath(path, getCwd);
      const check = await permissions.checkFsAccess(resolved, 'write');
      if (!check.allowed) {
        const parentDir = resolve(resolved, '..');
        return `Error: Permission denied for write access to ${resolved}. Use the approve_scope tool with path="${parentDir}" and mode="write" to request access from the user.`;
      }

      if (!existsSync(resolved)) {
        return `Error: File not found: ${resolved}`;
      }

      try {
        const stat = await import('node:fs').then(m => m.statSync(resolved));
        if (stat.isDirectory()) {
          return `Error: ${resolved} is a directory. Cannot delete directories for safety.`;
        }
        unlinkSync(resolved);
        return `Successfully deleted ${resolved}`;
      } catch (err: any) {
        return `Error deleting file: ${err.message}`;
      }
    },
  });
}