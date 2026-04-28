import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { githubRequest } from '../../utils/github.js';

export function createCreatePrTool() {
  return tool({
    description: 'Create a pull request on GitHub. Requires GITHUB_TOKEN to be configured.',
    inputSchema: zodSchema(z.object({
      owner: z.string().describe('Repository owner (username or org)'),
      repo: z.string().describe('Repository name'),
      title: z.string().describe('PR title'),
      body: z.string().describe('PR description (markdown supported)').default(''),
      head: z.string().describe('The branch containing the changes'),
      base: z.string().describe('The branch to merge into').default('main'),
      draft: z.boolean().describe('Create as draft PR').default(false),
    })),
    execute: async ({ owner, repo, title, body, head, base, draft }) => {
      try {
        const result = await githubRequest(`/repos/${owner}/${repo}/pulls`, {
          method: 'POST',
          body: { title, body, head, base, draft },
        });

        return `PR created: ${result.html_url}\n#${result.number}: ${result.title}\n${draft ? '(draft)' : ''} ${result.state}`;
      } catch (err: any) {
        return `Error creating PR: ${err.message}`;
      }
    },
  });
}