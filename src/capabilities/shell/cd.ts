import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { resolve, isAbsolute } from 'node:path';
import { existsSync, statSync } from 'node:fs';

export function createCdTool(getCwd: () => string, setCwd: (dir: string) => void) {
  return tool({
    description: 'Change the current working directory. All subsequent file operations, shell commands, and git operations will use this directory. Use this before running commands in a specific project folder.',
    inputSchema: zodSchema(z.object({
      path: z.string().describe('The directory to change to. Can be absolute or relative to the current directory.'),
    })),
    execute: async ({ path }) => {
      const cwd = getCwd();
      const resolved = isAbsolute(path) ? resolve(path) : resolve(cwd, path);

      if (!existsSync(resolved)) {
        return `Error: Directory not found: ${resolved}`;
      }

      try {
        const stat = statSync(resolved);
        if (!stat.isDirectory()) {
          return `Error: Not a directory: ${resolved}`;
        }
      } catch {
        return `Error: Cannot access: ${resolved}`;
      }

      setCwd(resolved);
      return `Changed directory to ${resolved}`;
    },
  });
}