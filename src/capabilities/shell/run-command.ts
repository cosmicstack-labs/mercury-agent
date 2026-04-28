import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { execSync } from 'node:child_process';
import { resolve, isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import type { PermissionManager } from '../permissions.js';
import { logger } from '../../utils/logger.js';

export function createRunCommandTool(permissions: PermissionManager, getCwd: () => string, setCwd: (dir: string) => void) {
  return tool({
    description: `Run a shell command in the current working directory. Use the cd tool to change directories first — cd commands within this tool only affect chained commands (e.g., "cd /path && ls"), not subsequent calls.
Blocked commands (sudo, rm -rf /, etc.) are never executed.
Auto-approved commands (ls, cat, git status, curl, etc.) run without asking.
Other commands prompt the user for approval before execution.`,
    inputSchema: zodSchema(z.object({
      command: z.string().describe('The shell command to execute'),
    })),
    execute: async ({ command }) => {
      const check = await permissions.checkShellCommand(command);
      if (!check.allowed) {
        return `Error: ${check.reason}`;
      }

      const cwd = getCwd();

      try {
        logger.info({ cmd: command, cwd }, 'Executing shell command');
        const result = execSync(command, {
          cwd,
          timeout: 30000,
          maxBuffer: 1024 * 1024,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        const trimmedOutput = result?.trim() || '(no output)';

        detectCd(command, cwd, setCwd);

        return trimmedOutput;
      } catch (err: any) {
        const stderr = err.stderr?.trim();
        const stdout = err.stdout?.trim();

        if (stdout || stderr) {
          detectCd(command, cwd, setCwd);
        }

        let msg = `Command exited with code ${err.status || 'unknown'}`;
        if (stdout) msg += `\nOutput: ${stdout}`;
        if (stderr) msg += `\nError: ${stderr}`;
        return msg;
      }
    },
  });
}

function detectCd(command: string, currentCwd: string, setCwd: (dir: string) => void): void {
  const trimmed = command.trim();

  const cdOnly = trimmed.match(/^cd\s+(.+)$/);
  if (cdOnly) {
    const target = cdOnly[1].replace(/^["']|["']$/g, '').replace(/^~/, homedir());
    const resolved = isAbsolute(target) ? target : resolve(currentCwd, target);
    if (existsSync(resolved)) {
      setCwd(resolved);
    }
    return;
  }

  const cdChain = trimmed.match(/cd\s+(.+?)\s*&&/);
  if (cdChain) {
    const target = cdChain[1].replace(/^["']|["']$/g, '').replace(/^~/, homedir());
    const resolved = isAbsolute(target) ? target : resolve(currentCwd, target);
    if (existsSync(resolved)) {
      setCwd(resolved);
    }
  }
}