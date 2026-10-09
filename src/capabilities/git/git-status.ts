import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { execFileSync } from 'node:child_process';
import type { PermissionManager } from '../permissions.js';
import { checkGitReadPath } from './git-path.js';

export function createGitStatusTool(permissions: PermissionManager, getCwd: () => string) {
  return tool({
    description: 'Show the working tree status. Returns staged, unstaged, and untracked files.',
    inputSchema: zodSchema(z.object({
      path: z.string().optional().describe('Path to check (defaults to current directory)'),
    })),
    execute: async ({ path }) => {
      // The path is model-chosen: it must pass the read-scope check and reach
      // git as a single argv element, never interpolated into a shell string.
      const args = ['status', '--porcelain'];
      if (path) {
        const check = await checkGitReadPath(permissions, getCwd, path);
        if (check.error) return check.error;
        args.unshift('-C', check.resolved);
      }
      try {
        const result = execFileSync('git', args, { encoding: 'utf-8', timeout: 20000, cwd: getCwd() });
        if (!result.trim()) return 'Working tree clean — no changes.';
        return result.trim();
      } catch (err: any) {
        return `Error: ${err.stderr?.trim() || err.message}`;
      }
    },
  });
}
