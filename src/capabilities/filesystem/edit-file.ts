import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import type { PermissionManager } from '../permissions.js';

export function createEditFileTool(permissions: PermissionManager, getCwd: () => string) {
  return tool({
    description: 'Edit a file by replacing an exact string match with new content. Use this instead of write_file when you only need to change part of a file. The old_string must match exactly (including whitespace and indentation). Fails if old_string is not found or found multiple times.',
    inputSchema: zodSchema(z.object({
      path: z.string().describe('Absolute or relative path to the file'),
      old_string: z.string().describe('The exact text to find in the file (must match exactly)'),
      new_string: z.string().describe('The text to replace it with'),
    })),
    execute: async ({ path, old_string, new_string }) => {
      const resolved = isAbsolute(path) ? resolve(path) : resolve(getCwd(), path);

      const fsCheck = await permissions.checkFsAccess(resolved, 'write');
      if (!fsCheck.allowed) {
        const parentDir = resolve(resolved, '..');
        return `Error: Permission denied for write access to ${resolved}. Use the approve_scope tool with path="${parentDir}" and mode="write" to request access from the user.`;
      }

      try {
        const content = readFileSync(resolved, 'utf-8');

        const count = content.split(old_string).length - 1;
        if (count === 0) {
          return `Error: old_string not found in ${path}. Make sure the text matches exactly, including whitespace and indentation.`;
        }
        if (count > 1) {
          return `Error: old_string found ${count} times in ${path}. Provide more surrounding context to make the match unique.`;
        }

        const newContent = content.replace(old_string, new_string);
        writeFileSync(resolved, newContent, 'utf-8');

        const linesAdded = new_string.split('\n').length;
        const linesRemoved = old_string.split('\n').length;
        return `Edited ${path}: replaced ${linesRemoved} line(s) with ${linesAdded} line(s)`;
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          return `Error: File not found: ${path}. Use create_file to create new files.`;
        }
        return `Error editing file: ${err.message}`;
      }
    },
  });
}