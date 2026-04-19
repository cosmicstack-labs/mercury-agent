import { tool } from 'ai';
import { z } from 'zod';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { PermissionManager } from '../permissions.js';
import { logger } from '../../utils/logger.js';

export function createRunCommandTool(permissions: PermissionManager) {
  return tool({
    description: `Run a shell command. Commands run in the current working directory unless an absolute path is given.
Blocked commands (sudo, rm -rf /, etc.) are never executed.
Auto-approved commands (ls, cat, git status, etc.) run without asking.
Other commands require user approval (y/n/always). "always" saves the approval for future use.`,
    parameters: z.object({
      command: z.string().describe('The shell command to execute'),
    }),
    execute: async ({ command }) => {
      const check = await permissions.checkShellCommand(command);
      if (!check.allowed) {
        if (check.needsApproval) {
          const response = await askApproval(command, permissions);
          if (!response) {
            return `Command "${command}" was not approved by user.`;
          }
        } else {
          return `Error: ${check.reason}`;
        }
      }

      try {
        logger.info({ cmd: command }, 'Executing shell command');
        const result = execSync(command, {
          cwd: process.cwd(),
          timeout: 30000,
          maxBuffer: 1024 * 1024,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        const output = result?.trim() || '(no output)';
        return output;
      } catch (err: any) {
        const stderr = err.stderr?.trim();
        const stdout = err.stdout?.trim();
        let msg = `Command exited with code ${err.status || 'unknown'}`;
        if (stdout) msg += `\nOutput: ${stdout}`;
        if (stderr) msg += `\nError: ${stderr}`;
        return msg;
      }
    },
  });
}

async function askApproval(command: string, permissions: PermissionManager): Promise<boolean> {
  const handler = (permissions as any).askHandler;
  if (!handler) {
    return false;
  }

  const response = await handler(
    `Mercury wants to run: ${command}\nAllow? (y/n/always): `
  );

  const normalized = response.toLowerCase().trim();

  if (normalized === 'always') {
    permissions.addApprovedCommand(command);
    return true;
  }

  if (normalized === 'y' || normalized === 'yes') {
    return true;
  }

  return false;
}