import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { execSync } from 'node:child_process';
import type { PermissionManager } from '../permissions.js';

export function createGitPushTool(permissions: PermissionManager, getCwd: () => string) {
  return tool({
    description: 'Push commits to a remote repository. This modifies a remote and requires approval.',
    inputSchema: zodSchema(z.object({
      remote: z.string().optional().describe('Remote name (default: origin)'),
      branch: z.string().optional().describe('Branch name (default: current branch)'),
    })),
    execute: async ({ remote, branch }) => {
      const cmd = `git push ${remote || 'origin'} ${branch || ''}`.trim();
      const check = await permissions.checkShellCommand(cmd);
      if (!check.allowed) {
        return `Error: ${check.reason}`;
      }

      try {
        const result = execSync(cmd, { encoding: 'utf-8', timeout: 60000, cwd: getCwd() });
        return result.trim() || 'Pushed successfully.';
      } catch (err: any) {
        return `Error: ${err.stderr?.trim() || err.message}`;
      }
    },
  });
}