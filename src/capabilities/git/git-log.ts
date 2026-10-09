import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { execFileSync } from 'node:child_process';
import type { PermissionManager } from '../permissions.js';
import { checkGitReadPath } from './git-path.js';

export function createGitLogTool(permissions: PermissionManager, getCwd: () => string) {
  return tool({
    description: 'Show commit logs. Returns recent commit history with hash, author, date, and message.',
    inputSchema: zodSchema(z.object({
      count: z.number().optional().describe('Number of commits to show (default 10)'),
      path: z.string().optional().describe('File or directory to show log for'),
    })),
    execute: async ({ count, path }) => {
      const n = Math.max(1, Math.floor(count ?? 10));
      const args = ['log', '--oneline', '--decorate', `-${n}`];
      if (path) {
        // Model-chosen path: read-scope check first, then a single argv
        // element after `--` so it can never be parsed as an option.
        const check = await checkGitReadPath(permissions, getCwd, path);
        if (check.error) return check.error;
        args.push('--', path);
      }
      try {
        const result = execFileSync('git', args, { encoding: 'utf-8', timeout: 20000, cwd: getCwd() });
        if (!result.trim()) return 'No commits found.';
        return result.trim();
      } catch (err: any) {
        return `Error: ${err.stderr?.trim() || err.message}`;
      }
    },
  });
}
