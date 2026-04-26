import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { githubRequest } from '../../utils/github.js';

const CO_AUTHOR_NAME = 'Mercury';
const CO_AUTHOR_EMAIL = 'mercury@cosmicstack.org';
const CO_AUTHOR_TRAILER = `Co-authored-by: ${CO_AUTHOR_NAME} <${CO_AUTHOR_EMAIL}>`;

function isContentCreatePath(path: string): boolean {
  return /^\/repos\/[^/]+\/[^/]+\/contents\//.test(path);
}

function injectCoAuthor(body: any): any {
  const result = { ...body };

  if (typeof result.message === 'string' && !result.message.includes(CO_AUTHOR_TRAILER)) {
    result.message += `\n\n${CO_AUTHOR_TRAILER}`;
  }

  if (!result.committer || typeof result.committer !== 'object') {
    result.committer = { name: CO_AUTHOR_NAME, email: CO_AUTHOR_EMAIL };
  }

  if (!result.author || typeof result.author !== 'object') {
    result.author = { name: CO_AUTHOR_NAME, email: CO_AUTHOR_EMAIL };
  }

  return result;
}

export function createGithubApiTool() {
  return tool({
    description: `Make a raw request to the GitHub API. GET requests (read-only) are always allowed. Write operations (POST, PUT, PATCH, DELETE) may require user approval.

Common operations you can perform:
- Push a file: PUT /repos/{owner}/{repo}/contents/{path} — body must include "message" (commit message) and "content" (base64-encoded file). For updates, also include "sha" from the current file. Co-authored-by Mercury is automatically included.
- Delete a file: DELETE /repos/{owner}/{repo}/contents/{path} — body must include "message" and "sha".
- List branches: GET /repos/{owner}/{repo}/branches
- Get file contents: GET /repos/{owner}/{repo}/contents/{path}
- Search code: GET /search/code?q={query}
- Any other GitHub API v3 endpoint.

IMPORTANT: When the user wants to push code or files to GitHub and git push fails (auth issues, no SSH key, etc.), use PUT /repos/{owner}/{repo}/contents/{path} to create or update files directly through the API. This bypasses local git and creates a commit with Mercury as co-author.`,
    inputSchema: zodSchema(z.object({
      path: z.string().describe('Full API path (e.g., /repos/owner/repo/issues or /repos/owner/repo/contents/path/to/file)'),
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).describe('HTTP method').default('GET'),
      body: z.string().describe('JSON body for write requests (as a JSON string)').optional(),
    })),
    execute: async ({ path, method, body }) => {
      try {
        let parsedBody: any;
        if (body) {
          try {
            parsedBody = JSON.parse(body);
          } catch {
            return 'Error: body must be valid JSON.';
          }
        }

        if (parsedBody && isContentCreatePath(path) && (method === 'PUT' || method === 'POST' || method === 'PATCH')) {
          parsedBody = injectCoAuthor(parsedBody);
        }

        const result = await githubRequest(path, {
          method,
          body: parsedBody,
        });

        if (result === null) return 'Request completed (204 No Content).';

        if (typeof result === 'string') return result;

        return JSON.stringify(result, null, 2);
      } catch (err: any) {
        return `Error: ${err.message}`;
      }
    },
  });
}