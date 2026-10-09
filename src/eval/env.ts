/**
 * Eval environment bootstrap.
 *
 * MUST be the first import of every eval module: several core modules read
 * MERCURY_HOME at import time (permissions.yaml path, config .env loading),
 * so the scratch home has to exist before `../core/agent.js` is evaluated.
 * ES module evaluation follows import order, so `import './env.js'` at the
 * top of runner.ts is enough.
 *
 * Nothing here touches the network or the user's real ~/.mercury.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.LOG_LEVEL) process.env.LOG_LEVEL = 'silent';
// The agent reads MERCURY_MAX_STEPS once at import (core/agent.ts). A small
// budget makes step-budget exhaustion cheap to replay; every other scripted
// turn uses far fewer steps than this.
if (!process.env.MERCURY_MAX_STEPS) process.env.MERCURY_MAX_STEPS = '6';

/** Root scratch directory for this process; every harness gets a home under it. */
export const EVAL_ROOT: string = mkdtempSync(join(tmpdir(), 'mercury-eval-'));
// The agent sends its system prompt as a leading system *message* (for
// Anthropic prompt caching) without `allowSystemInMessages: true`, so the AI
// SDK console.warns on every model call. Drop exactly that line here.
const SYSTEM_IN_MESSAGES_WARNING = 'AI SDK Warning: System messages in the prompt';
const originalWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].startsWith(SYSTEM_IN_MESSAGES_WARNING)) return;
  originalWarn(...args);
};

if (!process.env.MERCURY_HOME || !process.env.MERCURY_HOME.startsWith(EVAL_ROOT)) {
  process.env.MERCURY_HOME = join(EVAL_ROOT, 'home');
}
mkdirSync(process.env.MERCURY_HOME, { recursive: true });

/**
 * Point MERCURY_HOME at a fresh directory. Sessions, memory, the work
 * ledger, soul files and schedules all resolve `getMercuryHome()` at call
 * time, so each harness gets isolated state (permissions.yaml keeps the
 * first path — it is resolved at import — which is fine: it only holds the
 * default manifest).
 */
export function freshHome(label: string): string {
  mkdirSync(EVAL_ROOT, { recursive: true });
  const dir = mkdtempSync(join(EVAL_ROOT, `${label.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}-`));
  process.env.MERCURY_HOME = dir;
  return dir;
}

export function removeEvalRoot(): void {
  rmSync(EVAL_ROOT, { recursive: true, force: true });
}
