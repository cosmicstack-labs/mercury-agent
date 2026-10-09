import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { execFileSync } from 'node:child_process';
import type { PermissionManager } from '../permissions.js';
import { looksLikeGitOption } from './git-path.js';

export function createGitPushTool(permissions: PermissionManager, getCwd: () => string) {
  return tool({
    description: 'Push commits to a remote repository. This modifies a remote and requires approval.',
    inputSchema: zodSchema(z.object({
      remote: z.string().optional().describe('Remote name (default: origin)'),
      branch: z.string().optional().describe('Branch name (default: current branch)'),
    })),
    execute: async ({ remote, branch }) => {
      const remoteName = remote || 'origin';
      // Positional args only: `--receive-pack=…` or `--exec=…` smuggled in as
      // a "remote" or "branch" would run an arbitrary program.
      if (looksLikeGitOption(remoteName) || (branch && looksLikeGitOption(branch))) {
        return 'Error: remote and branch must be names, not git options.';
      }
      const args = ['push', remoteName, ...(branch ? [branch] : [])];
      const cmd = `git ${args.join(' ')}`;
      const check = await permissions.checkShellCommand(cmd);
      if (!check.allowed) {
        return `Error: ${check.reason}`;
      }

      try {
        const result = execFileSync('git', args, { encoding: 'utf-8', timeout: 60000, cwd: getCwd() });
        return result.trim() || 'Pushed successfully.';
      } catch (err: any) {
        return `Error: ${err.stderr?.trim() || err.message}`;
      }
    },
  });
}
