import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { resolve, isAbsolute } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import type { PermissionManager } from '../permissions.js';
import { redactSecrets } from '../../utils/redact.js';
import { logger } from '../../utils/logger.js';
import { pulseProgress, TOOL_PULSE_INTERVAL_MS } from '../../core/progress-pulse.js';
import { planArgvExecution, minimalEnv, type ArgvPlan } from './argv-lane.js';

const MAX_BUFFER = 1024 * 1024;
/** Bound echoed stdout so per-step conversation clones stay small. */
const MAX_OUTPUT_CHARS = 64 * 1024;
const SIGTERM_GRACE_MS = 5_000;

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  /** The agent loop was aborted (user interrupt, watchdog) while the command ran. */
  aborted: boolean;
}

interface ExecOptions {
  /** Abort from the agent loop; the child is terminated when it fires. */
  signal?: AbortSignal;
  /** Called on output and periodically while the child is alive. */
  onActivity?: () => void;
}

/**
 * Approval-lane executor: runs the exact string the user approved through
 * the platform shell.
 */
export function executeCommand(command: string, cwd: string, timeoutMs: number, options: ExecOptions = {}): Promise<ExecResult> {
  return superviseChild(() => spawn(command, [], {
    cwd,
    shell: true,
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  }), timeoutMs, options);
}

/**
 * Argv-lane executor: the pinned absolute binary and literal arguments, with
 * no shell and a minimal environment. spawn exposes POSIX process groups;
 * execFile does not forward detached and buffers another copy of all output.
 */
export function executeArgv(file: string, args: readonly string[], cwd: string, timeoutMs: number, options: ExecOptions = {}): Promise<ExecResult> {
  return superviseChild(() => spawn(file, [...args], {
    cwd,
    env: minimalEnv(),
    shell: false,
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  }), timeoutMs, options);
}

function superviseChild(start: () => ChildProcess, timeoutMs: number, options: ExecOptions): Promise<ExecResult> {
  return new Promise((resolveResult) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let terminationReason: 'timeout' | 'abort' | undefined;
    let closed = false;
    let processError = false;
    let closeCode: number | null = null;
    let forced = false;
    let windowsCleanupFinished = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let sigkillHandle: ReturnType<typeof setTimeout> | undefined;
    let pulseHandle: ReturnType<typeof setInterval> | undefined;
    const { signal, onActivity } = options;

    if (signal?.aborted) {
      resolveResult({ stdout, stderr, exitCode: null, timedOut: false, aborted: true });
      return; // An already-cancelled turn must not start a new process.
    }

    let child: ChildProcess;
    try {
      child = start();
    } catch (err: any) {
      resolveResult({ stdout: '', stderr: `Process error: ${err?.message ?? String(err)}`, exitCode: null, timedOut: false, aborted: false });
      return;
    }

    const onAbort = () => terminate('abort');

    const finish = (exitCode: number | null, timedOut: boolean, aborted = false) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (sigkillHandle) clearTimeout(sigkillHandle);
      if (pulseHandle) clearInterval(pulseHandle);
      signal?.removeEventListener('abort', onAbort);
      resolveResult({ stdout, stderr, exitCode, timedOut, aborted });
    };

    const signalGroup = (kind: NodeJS.Signals) => {
      if (!child.pid) return;
      try { process.kill(-child.pid, kind); }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
          stderr += `\nProcess termination error: ${(err as Error).message}`;
          child.kill(kind);
        }
      }
    };
    const maybeFinish = () => {
      if (!closed) return; // 'exit' can precede the last stdout/stderr bytes.
      if (!terminationReason) { finish(processError ? null : closeCode, false); return; }
      if (process.platform === 'win32') {
        if (!windowsCleanupFinished) return;
      } else if (!forced) {
        // The leader and its output have closed, so it can no longer shut down
        // any children gracefully. Stop remaining group members before releasing
        // the turn, including descendants that redirected their output.
        signalGroup('SIGKILL');
      }
      finish(null, terminationReason === 'timeout', terminationReason === 'abort');
    };

    // Latch the first reason and keep ownership until the child closes. Merely
    // sending a signal (child.killed) does not mean the process has stopped.
    const terminate = (reason: 'timeout' | 'abort') => {
      if (settled || terminationReason) return;
      terminationReason = reason;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (process.platform === 'win32') {
        if (!child.pid) {
          windowsCleanupFinished = true;
          maybeFinish();
          return;
        }
        // Windows has no POSIX process groups. Kill the tree before the shell
        // leader, since killing only cmd.exe can leave its command running.
        const taskkill = resolve(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
        execFile(taskkill, ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: SIGTERM_GRACE_MS }, (err) => {
          if (err) {
            stderr += `\nProcess tree termination error: ${err.message}`;
            child.kill('SIGKILL');
          }
          windowsCleanupFinished = true;
          maybeFinish();
        });
      } else {
        sigkillHandle = setTimeout(() => {
          signalGroup('SIGKILL');
          forced = true;
          maybeFinish();
        }, SIGTERM_GRACE_MS);
        signalGroup('SIGTERM');
        maybeFinish();
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_BUFFER) {
        stdout += chunk.toString();
        if (stdout.length > MAX_BUFFER) {
          stdout = stdout.slice(stdout.length - MAX_BUFFER);
        }
      }
      onActivity?.();
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_BUFFER) {
        stderr += chunk.toString();
        if (stderr.length > MAX_BUFFER) {
          stderr = stderr.slice(stderr.length - MAX_BUFFER);
        }
      }
      onActivity?.();
    });

    child.on('error', (err) => {
      processError = true;
      stderr += `\nProcess error: ${err.message}`;
      // Node emits close after a spawn error too. A kill error must not
      // release the turn while the process is still alive.
    });

    child.on('close', (code) => {
      closed = true;
      closeCode = code;
      maybeFinish();
    });

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    // A quiet build (no output for minutes) is still progress as long as the
    // child is alive and inside its own timeout. Pulse so the stall watchdog
    // does not abort the turn underneath it.
    if (onActivity) {
      pulseHandle = setInterval(onActivity, TOOL_PULSE_INTERVAL_MS);
    }

    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => terminate('timeout'), timeoutMs);
    }
  });
}

export function createRunCommandTool(permissions: PermissionManager, getCwd: () => string, setCwd: (dir: string) => void) {
  return tool({
    description: `Run a shell command in the current working directory. Use the cd tool to change directories first — cd commands within this tool only affect chained commands (e.g., "cd /path && ls"), not subsequent calls.
Blocked commands (sudo, rm -rf /, etc.) are never executed.
Simple read-only commands (ls, cat, grep, find, git status/log/diff, ...) with no pipes, redirection, variables or globs run without asking, executed directly (no shell).
Everything else — including pipelines and && chains — prompts the user for approval before execution.
The optional timeout parameter sets how long (in seconds) the command can run before being killed (default 120, max 600). For very long builds or test suites, set a higher timeout or use /bg to run the command in the background.`,
    inputSchema: zodSchema(z.object({
      command: z.string().describe('The shell command to execute'),
      timeout: z.number().min(10).max(600).default(120).optional().describe('Timeout in seconds (default 120, max 600). Increase for long-running commands like builds or test suites.'),
    })),
    execute: async ({ command, timeout }, toolOptions?: { abortSignal?: AbortSignal }) => {
      const cwd = getCwd();
      const check = await permissions.checkShellCommand(command, { cwd });
      if (!check.allowed) {
        return `Error: ${check.reason}`;
      }

      const timeoutMs = (timeout ?? 120) * 1000;

      // Any command the argv lane can express runs without a shell, whichever
      // lane approved it; only commands that need a shell reach one.
      const plan = planArgvExecution(command);
      if (plan?.kind === 'builtin') {
        return runBuiltin(plan, cwd, setCwd);
      }
      if (check.lane === 'argv' && !plan) {
        // Classified for the argv lane but no longer executable that way
        // (e.g. the binary vanished): never fall back to a shell unapproved.
        return 'Error: command could not be executed without a shell; it requires approval.';
      }

      try {
        logger.info({ cmd: command, cwd, timeoutMs, lane: plan ? 'argv' : 'shell' }, 'Executing command');
        const execOptions = { signal: toolOptions?.abortSignal, onActivity: pulseProgress };
        const result = plan
          ? await executeArgv(plan.file, plan.args, cwd, timeoutMs, execOptions)
          : await executeCommand(command, cwd, timeoutMs, execOptions);

        if (result.stdout || result.stderr) {
          detectCd(command, cwd, setCwd);
        }

        if (result.aborted) {
          const partial = result.stdout?.trim();
          let msg = '⛔ Command stopped: the turn was interrupted before it finished.';
          if (partial) msg += `\nPartial output:\n${redactSecrets(partial.split('\n').slice(-30).join('\n'))}`;
          return msg;
        }

        if (result.timedOut) {
          const partial = result.stdout?.trim();
          let msg = `⏱ Command timed out after ${timeoutMs / 1000}s.`;
          if (partial) {
            const lines = partial.split('\n');
            const preview = redactSecrets(lines.length > 30 ? lines.slice(-30).join('\n') : partial);
            const boundedPreview = preview.length > MAX_OUTPUT_CHARS
              ? preview.slice(0, MAX_OUTPUT_CHARS) + '\n[Preview truncated]'
              : preview;
            msg += `\nPartial output:\n${boundedPreview}`;
          }
          msg += '\n\nTo run long commands in the background, use /bg <command>.';
          return msg;
        }

        const trimmedOutput = result.stdout?.trim() || '(no output)';
        // Bound the tool result echoed into the LLM conversation: the AI SDK
        // retains per-step conversation clones for every remaining agent
        // step, so unbounded command output compounds into O(N²) heap.
        const boundedOutput = trimmedOutput.length > MAX_OUTPUT_CHARS
          ? trimmedOutput.slice(0, MAX_OUTPUT_CHARS) + `\n\n[Output truncated: showing first ${Math.round(MAX_OUTPUT_CHARS / 1024)}KB of ${Math.round(trimmedOutput.length / 1024)}KB. Re-run with head/tail/grep for specific sections.]`
          : trimmedOutput;
        // Command output can contain environment secrets (env, config files,
        // API responses) — anything echoed into the conversation ends up in
        // session transcripts and logs. Redact before echoing.
        const redactedOutput = redactSecrets(boundedOutput);
        if (result.exitCode !== 0 && result.exitCode !== null) {
          let msg = `Command exited with code ${result.exitCode}`;
          if (redactedOutput && redactedOutput !== '(no output)') msg += `\nOutput: ${redactedOutput}`;
          if (result.stderr?.trim()) msg += `\nError: ${redactSecrets(result.stderr.trim().slice(0, MAX_OUTPUT_CHARS))}`;
          return msg;
        }

        detectCd(command, cwd, setCwd);
        return redactedOutput;
      } catch (err: any) {
        const msg = `Command failed: ${err.message || String(err)}`;
        return msg;
      }
    },
  });
}

/** `cd` in the argv lane: change the tool cwd in-process (it is a shell builtin). */
function runBuiltin(plan: Extract<ArgvPlan, { kind: 'builtin' }>, cwd: string, setCwd: (dir: string) => void): string {
  const target = plan.argv[1] ?? homedir();
  const resolved = isAbsolute(target) ? resolve(target) : resolve(cwd, target);
  try {
    if (!statSync(resolved).isDirectory()) return `Error: Not a directory: ${resolved}`;
  } catch {
    return `Error: Directory not found: ${resolved}`;
  }
  setCwd(resolved);
  return `Changed directory to ${resolved}`;
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