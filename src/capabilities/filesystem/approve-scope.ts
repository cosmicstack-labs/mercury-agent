import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { resolve, isAbsolute } from 'node:path';
import type { PermissionManager } from '../permissions.js';

export function createApproveScopeTool(permissions: PermissionManager, getCwd: () => string) {
  return tool({
    description: 'Request user approval to access a directory outside current scopes. Use this when a file tool returns a permission denied error. The user gets an approval prompt (Allow/Always/Deny buttons on Telegram, yes/always/no on CLI). "Allow" grants session-only access. "Always" persists to disk. After approval, retry the original file operation.',
    inputSchema: zodSchema(z.object({
      path: z.string().describe('The directory path to request access to'),
      mode: z.enum(['read', 'write']).describe('The access mode needed'),
    })),
    execute: async ({ path, mode }) => {
      const resolved = isAbsolute(path) ? resolve(path) : resolve(getCwd(), path);
      const result = await permissions.requestScopeExternal(resolved, mode);
      if (result.allowed) {
        return `Access approved for ${mode} access to ${resolved}. You can now retry the file operation.`;
      }
      return `Access denied for ${mode} access to ${resolved}. The user did not approve scope access.`;
    },
  });
}