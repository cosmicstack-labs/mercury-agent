import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { githubRequest } from '../../utils/github.js';

export function createCreateIssueTool() {
  return tool({
    description: 'Create a new GitHub issue in a repository. Requires GITHUB_TOKEN.',
    inputSchema: zodSchema(z.object({
      owner: z.string().describe('Repository owner (username or org)'),
      repo: z.string().describe('Repository name'),
      title: z.string().describe('Issue title'),
      body: z.string().describe('Issue description (markdown supported)').default(''),
      labels: z.array(z.string()).describe('Label names to apply').optional(),
    })),
    execute: async ({ owner, repo, title, body, labels }) => {
      try {
        const payload: any = { title, body };
        if (labels && labels.length > 0) payload.labels = labels;

        const result = await githubRequest(`/repos/${owner}/${repo}/issues`, {
          method: 'POST',
          body: payload,
        });

        return `Issue created: ${result.html_url}\n#${result.number}: ${result.title}`;
      } catch (err: any) {
        return `Error creating issue: ${err.message}`;
      }
    },
  });
}