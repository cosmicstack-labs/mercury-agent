import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import type { PermissionManager } from '../permissions.js';

export function createApproveCommandTool(permissions: PermissionManager) {
  return tool({
    description: 'Permanently approve a command type so it runs without asking in the future. Use this when the user says "always" or "always approve" for a command. For example, if the user says "always approve curl", call this with command="curl".',
    inputSchema: zodSchema(z.object({
      command: z.string().describe('The base command to permanently approve (e.g. "curl", "docker", "npm")'),
    })),
    execute: async ({ command }) => {
      const baseCmd = command.trim().split(/\s+/)[0];
      permissions.addApprovedCommand(baseCmd);
      return `Command "${baseCmd}" has been permanently approved. Future calls to "${baseCmd} ..." will run without asking.`;
    },
  });
}