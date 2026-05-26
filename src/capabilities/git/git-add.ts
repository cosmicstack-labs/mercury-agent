import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { execSync } from 'node:child_process';

export function createGitAddTool(getCwd: () => string) {
  return tool({
    description: 'Add file contents to the index (staging area). Prepares files for commit.',
    inputSchema: zodSchema(z.object({
      paths: z.array(z.string()).describe('File paths to stage'),
    })),
    execute: async ({ paths }) => {
      try {
        const fileArgs = paths.map(p => `"${p}"`).join(' ');
        const result = execSync(`git add ${fileArgs}`, { encoding: 'utf-8', timeout: 20000, cwd: getCwd() });
        return `Staged ${paths.length} file(s): ${paths.join(', ')}`;
      } catch (err: any) {
        return `Error: ${err.stderr?.trim() || err.message}`;
      }
    },
  });
}