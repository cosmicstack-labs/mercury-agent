import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { PermissionManager } from '../permissions.js';

const CO_AUTHOR = 'Mercury <mercury@cosmicstack.org>';

export function createGitCommitTool(permissions: PermissionManager, getCwd: () => string) {
  return tool({
    description: 'Record changes to the repository. Creates a new commit with staged changes. Automatically includes a Co-authored-by trailer for attribution.',
    inputSchema: zodSchema(z.object({
      message: z.string().describe('Commit message'),
    })),
    execute: async ({ message }) => {
      try {
        const permission = await permissions.checkShellCommand(`git commit -m ${JSON.stringify(message)}`);
        if (!permission.allowed) return `Permission denied: ${permission.reason || 'git commit requires approval'}`;
        const fullMessage = `${message}\n\nCo-authored-by: ${CO_AUTHOR}`;
        const cwd = getCwd();
        const msgFilePath = join(cwd, '.git', 'MERCU_MSG');
        writeFileSync(msgFilePath, fullMessage, 'utf-8');
        const result = execFileSync('git', ['commit', '-F', msgFilePath], {
          encoding: 'utf-8',
          timeout: 20000,
          cwd,
        });
        try { unlinkSync(msgFilePath); } catch {}
        return result.trim() || 'Committed successfully.';
      } catch (err: any) {
        try { unlinkSync(join(getCwd(), '.git', 'MERCU_MSG')); } catch {}
        const stderr = err.stderr?.trim() || '';
        if (stderr.includes('nothing to commit')) {
          return 'Nothing to commit \u2014 no staged changes.';
        }
        return `Error: ${stderr || err.message}`;
      }
    },
  });
}
