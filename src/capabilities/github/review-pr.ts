import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { githubRequest } from '../../utils/github.js';

export function createReviewPrTool() {
  return tool({
    description: 'Get details of a pull request including the diff. Reviews the PR and returns the title, body, changed files, and diff. Optionally post a review comment.',
    inputSchema: zodSchema(z.object({
      owner: z.string().describe('Repository owner (username or org)'),
      repo: z.string().describe('Repository name'),
      number: z.number().describe('PR number'),
      comment: z.string().describe('Review comment to post on the PR (optional)').optional(),
    })),
    execute: async ({ owner, repo, number, comment }) => {
      try {
        const pr = await githubRequest(`/repos/${owner}/${repo}/pulls/${number}`);
        if (!pr) return `Error: PR #${number} not found.`;

        let summary = `PR #${pr.number}: ${pr.title}\n`;
        summary += `Author: ${pr.user?.login}\n`;
        summary += `State: ${pr.state} (${pr.merged ? 'merged' : pr.mergeable_state || 'unknown'})\n`;
        summary += `Branch: ${pr.head.ref} → ${pr.base.ref}\n`;
        summary += `Changed files: ${pr.changed_files} | Additions: +${pr.additions} | Deletions: -${pr.deletions}\n\n`;

        if (pr.body) {
          summary += `Description:\n${pr.body.slice(0, 2000)}\n\n`;
        }

        try {
          const diff = await githubRequest(`/repos/${owner}/${repo}/pulls/${number}`, {
            headers: { 'Accept': 'application/vnd.github.v3.diff' },
          });

          if (typeof diff === 'string') {
            const diffLines = diff.split('\n');
            const maxDiffLines = 200;
            summary += `Diff (first ${Math.min(diffLines.length, maxDiffLines)} of ${diffLines.length} lines):\n`;
            summary += diffLines.slice(0, maxDiffLines).join('\n');
            if (diffLines.length > maxDiffLines) {
              summary += `\n\n... (${diffLines.length - maxDiffLines} more lines)`;
            }
          }
        } catch {
          summary += `(Diff not available)`;
        }

        if (comment) {
          try {
            await githubRequest(`/repos/${owner}/${repo}/pulls/${number}/reviews`, {
              method: 'POST',
              body: { body: comment, event: 'COMMENT' },
            });
            summary += `\n\nReview comment posted.`;
          } catch (err: any) {
            summary += `\n\nFailed to post review comment: ${err.message}`;
          }
        }

        return summary;
      } catch (err: any) {
        return `Error reviewing PR: ${err.message}`;
      }
    },
  });
}