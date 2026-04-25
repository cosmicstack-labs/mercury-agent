import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { githubRequest } from '../../utils/github.js';

export function createListIssuesTool() {
  return tool({
    description: 'List GitHub issues for a repository. Requires GITHUB_TOKEN.',
    inputSchema: zodSchema(z.object({
      owner: z.string().describe('Repository owner (username or org)'),
      repo: z.string().describe('Repository name'),
      state: z.enum(['open', 'closed', 'all']).describe('Filter by issue state').default('open'),
      labels: z.string().describe('Comma-separated label names to filter by (optional)').optional(),
      limit: z.number().describe('Maximum number of issues to return').default(10),
    })),
    execute: async ({ owner, repo, state, labels, limit }) => {
      try {
        const params = new URLSearchParams();
        params.set('state', state);
        params.set('per_page', String(Math.min(limit, 100)));
        params.set('sort', 'updated');
        params.set('direction', 'desc');
        if (labels) params.set('labels', labels);

        const issues = await githubRequest(`/repos/${owner}/${repo}/issues?${params}`);

        if (!Array.isArray(issues) || issues.length === 0) {
          return `No ${state} issues found in ${owner}/${repo}.`;
        }

        const lines = issues.map((issue: any) => {
          const labelStr = issue.labels?.map((l: any) => `[${l.name}]`).join(' ') || '';
          return `#${issue.number} ${issue.title} ${labelStr} (${issue.state}, by ${issue.user?.login})`;
        });

        return `Issues in ${owner}/${repo} (${state}):\n${lines.join('\n')}`;
      } catch (err: any) {
        return `Error listing issues: ${err.message}`;
      }
    },
  });
}