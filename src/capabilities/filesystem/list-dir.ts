import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, isAbsolute, join } from 'node:path';
import type { PermissionManager } from '../permissions.js';
import { readDenialMessage } from './verified-read.js';

export function createListDirTool(permissions: PermissionManager, getCwd: () => string) {
  return tool({
    description: 'List the contents of a directory. Shows file names, types, and sizes.',
    inputSchema: zodSchema(z.object({
      path: z.string().describe('Absolute or relative path to the directory'),
    })),
    execute: async ({ path }) => {
      const resolved = isAbsolute(path) ? resolve(path) : resolve(getCwd(), path);
      const check = await permissions.checkFsAccess(resolved, 'read');
      if (!check.allowed) {
        if (check.code === undefined || check.code === 'denied') {
          return `Error: Permission denied for read access to ${resolved}. Use the approve_scope tool with path="${resolved}" and mode="read" to request access from the user.`;
        }
        return readDenialMessage(resolved, check);
      }

      // List the canonical directory the check authorised, not the lexical path.
      const target = check.canonical ?? resolved;
      if (!existsSync(target)) {
        return `Error: Directory not found: ${resolved}`;
      }

      try {
        const stat = statSync(target);
        if (!stat.isDirectory()) {
          return `Error: ${resolved} is a file, not a directory. Use read_file instead.`;
        }

        const entries = readdirSync(target, { withFileTypes: true });
        const lines = entries.map(entry => {
          const isDir = entry.isDirectory();
          const fullPath = join(target, entry.name);
          let size = '';
          try {
            if (!isDir) {
              size = ` (${formatSize(statSync(fullPath).size)})`;
            }
          } catch {}
          return `${isDir ? '📁' : '📄'} ${entry.name}${size}`;
        });

        if (lines.length === 0) {
          return `Directory ${resolved} is empty`;
        }

        return `Contents of ${resolved} (${entries.length} items):\n${lines.join('\n')}`;
      } catch (err: any) {
        return `Error listing directory: ${err.message}`;
      }
    },
  });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}