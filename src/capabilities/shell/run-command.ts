import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { spawn } from 'node:child_process';
import { resolve, isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import type { PermissionManager } from '../permissions.js';
import { logger } from '../../utils/logger.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 1024 * 1024;
const SIGTERM_GRACE_MS = 5_000;

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

function executeCommand(command: string, cwd: string, timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let sigkillHandle: ReturnType<typeof setTimeout> | undefined;

    const child = spawn(command, [], {
      cwd,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const finish = (exitCode: number | null, timedOut: boolean) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (sigkillHandle) clearTimeout(sigkillHandle);
      resolve({ stdout, stderr, exitCode, timedOut });
    };

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_BUFFER) {
        stdout += chunk.toString();
        if (stdout.length > MAX_BUFFER) {
          stdout = stdout.slice(stdout.length - MAX_BUFFER);
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_BUFFER) {
        stderr += chunk.toString();
        if (stderr.length > MAX_BUFFER) {
          stderr = stderr.slice(stderr.length - MAX_BUFFER);
        }
      }
    });

    child.on('error', (err) => {
      stderr += `\nProcess error: ${err.message}`;
      finish(null, false);
    });

    child.on('exit', (code) => {
      finish(code, false);
    });

    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        if (!settled) {
          child.kill('SIGTERM');
          sigkillHandle = setTimeout(() => {
            if (!settled) {
              child.kill('SIGKILL');
            }
          }, SIGTERM_GRACE_MS);
          finish(null, true);
        }
      }, timeoutMs);
    }
  });
}

export function createRunCommandTool(permissions: PermissionManager, getCwd: () => string, setCwd: (dir: string) => void) {
  return tool({
    description: `Run a shell command in the current working directory. Use the cd tool to change directories first — cd commands within this tool only affect chained commands (e.g., "cd /path && ls"), not subsequent calls.
Blocked commands (sudo, rm -rf /, etc.) are never executed.
Auto-approved commands (ls, cat, git status, curl, etc.) run without asking.
Other commands prompt the user for approval before execution.
The optional timeout parameter sets how long (in seconds) the command can run before being killed (default 120, max 600). For very long builds or test suites, set a higher timeout or use /bg to run the command in the background.`,
    inputSchema: zodSchema(z.object({
      command: z.string().describe('The shell command to execute'),
      timeout: z.number().min(10).max(600).default(120).optional().describe('Timeout in seconds (default 120, max 600). Increase for long-running commands like builds or test suites.'),
    })),
    execute: async ({ command, timeout }) => {
      const check = await permissions.checkShellCommand(command);
      if (!check.allowed) {
        return `Error: ${check.reason}`;
      }

      const cwd = getCwd();
      const timeoutMs = (timeout ?? 120) * 1000;

      try {
        logger.info({ cmd: command, cwd, timeoutMs }, 'Executing shell command');
        const result = await executeCommand(command, cwd, timeoutMs);

        if (result.stdout || result.stderr) {
          detectCd(command, cwd, setCwd);
        }

        if (result.timedOut) {
          const partial = result.stdout?.trim();
          let msg = `⏱ Command timed out after ${timeoutMs / 1000}s.`;
          if (partial) {
            const lines = partial.split('\n');
            const preview = lines.length > 30 ? lines.slice(-30).join('\n') : partial;
            msg += `\nPartial output:\n${preview}`;
          }
          msg += '\n\nTo run long commands in the background, use /bg <command>.';
          return msg;
        }

        const trimmedOutput = result.stdout?.trim() || '(no output)';
        if (result.exitCode !== 0 && result.exitCode !== null) {
          let msg = `Command exited with code ${result.exitCode}`;
          if (trimmedOutput && trimmedOutput !== '(no output)') msg += `\nOutput: ${trimmedOutput}`;
          if (result.stderr?.trim()) msg += `\nError: ${result.stderr.trim()}`;
          return msg;
        }

        detectCd(command, cwd, setCwd);
        return trimmedOutput;
      } catch (err: any) {
        let msg = `Command failed: ${err.message || String(err)}`;
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