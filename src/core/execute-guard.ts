/**
 * Execute-mode completion guard.
 *
 * Regression: in Mercury Code execute mode the model could end its turn with
 * narration alone — "Building X per its spec. Reading it first." — without a
 * single mutating tool call, and the agent loop still printed
 * "Task complete · 2 steps". The repo stayed untouched behind a green banner.
 *
 * The guard answers one question: is the agent allowed to finish this turn?
 * If the request reads as implementation work (or an approved plan is waiting)
 * and no world-changing tool ran, the turn must NOT count as complete.
 */

/** Tools that change the world. Anything else is observation or narration. */
export const EXECUTE_MUTATING_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'create_file',
  'edit_file',
  'delete_file',
  'run_command',
  'git_add',
  'git_commit',
  'git_push',
  'create_pr',
  'create_issue',
  'github_api',
  'send_file',
  'delegate_task',
  'use_skill',
  'install_skill',
]);

/** Deliberate pause: the model asked the user instead of stopping unilaterally. */
const EXECUTE_PAUSE_TOOLS: ReadonlySet<string> = new Set(['ask_user']);

/**
 * Bounded number of forced continuation rounds per turn. Generous by
 * design: models routinely need a few nudges to switch from narration to
 * tool use, and the user asked for automatic continuation — the pause is
 * a last resort, not a checkpoint.
 */
export const MAX_EXECUTE_CONTINUATIONS = 5;

/** Result markers produced by tool executors when a mutation did NOT land. */
const FAILED_RESULT_MARKERS = [
  'error:',
  'permission denied',
  'command exited with code',
  'command failed',
  'command timed out',
  'exit code 1',
  'exit code 2',
];

export function isFailedToolResult(resultText: string): boolean {
  const head = resultText.slice(0, 300).trimStart().toLowerCase();
  return FAILED_RESULT_MARKERS.some((marker) => head.includes(marker));
}

const IMPLEMENTATION_PATTERN = new RegExp(
  [
    'build', 'implement', 'creat', 'mak', 'add', 'fix',
    'repair', 'refactor', 'develop', 'writ', 'generat',
    'migrat', 'set\\s?up', 'setup', 'install', 'integrat',
    'deploy', 'cod', 'program', '\\bapp\\b', 'application',
    'feature', 'function', 'component', 'endpoint', '\\bapi\\b',
    'script', 'module', 'class', 'website', 'web\\s?page',
    '\\bpage\\b', '\\bgame\\b', '\\bbot\\b', '\\bcli\\b', 'test',
    'bug', 'dashboard', 'database', '\\bschema\\b',
    'rout', 'service', 'scaffold', 'boilerplate',
    'continu', 'resum', 'keep going', 'go ahead', 'go on',
    'proceed', 'do it', 'try again', 'retry',
  ].join('|'),
  'i',
);

/** Pure acknowledgments/chat — never an implementation request. */
const PURE_CONVERSATION_PATTERN = /^(thanks|thank you|thx|ty|cool|nice|great|awesome|perfect|ok|okay|got it|understood|bye|hi|hey|hello|lol|lgtm|sounds good|well done)[\s!,.?]*$/i;

/** Interrogatives: the user wants an answer, not (necessarily) file changes. */
const QUESTION_PATTERN = /^(what|whats|what's|why|how|when|where|who|which|explain|describe|tell me|walk me through|compare|list)\b/i;

export interface ExecuteGuardInput {
  /** The user's request for this turn. */
  taskText: string;
  /** A plan from plan mode was approved and is pending execution. */
  hasApprovedPlan: boolean;
  /** Every tool name invoked during this turn so far. */
  toolsUsed: Iterable<string>;
  /**
   * Tool name → whether at least one invocation of that tool produced a
   * non-error result. A mutating tool that only ever failed (permission
   * denial, command exit code) does NOT satisfy the guard.
   */
  toolsSucceeded?: ReadonlyMap<string, boolean>;
}

/**
 * True when the agent must NOT be allowed to finish yet: the request is
 * implementation work (or a plan was approved) and nothing world-changing
 * happened. Conservative — read-only turns on question-style or chit-chat
 * requests are left alone.
 */
export function shouldForceExecuteContinuation(input: ExecuteGuardInput): boolean {
  for (const toolName of input.toolsUsed) {
    if (EXECUTE_PAUSE_TOOLS.has(toolName)) return false;
    if (!EXECUTE_MUTATING_TOOLS.has(toolName)) continue;
    // A mutating tool ran — but did it actually succeed at least once?
    if (!input.toolsSucceeded) return false;
    if (input.toolsSucceeded.get(toolName) !== true) continue;
    return false;
  }
  const task = input.taskText.trim();
  if (task.length < 2) return false;
  if (PURE_CONVERSATION_PATTERN.test(task)) return false;
  if (QUESTION_PATTERN.test(task)) return false;
  if (input.hasApprovedPlan) return true;
  return IMPLEMENTATION_PATTERN.test(task);
}

/**
 * True when the response ends by asking the user something in plain text.
 * That is a LEGITIMATE pause point — the model is waiting on information
 * only the user has — and the narration guard must not fight it by forcing
 * more rounds (which previously looped forever: model asks, guard resumes,
 * model searches again and asks again).
 */
export function responseAsksUser(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  const lines = trimmed.split('\n');
  const last = (lines[lines.length - 1] ?? '').trim();
  return last.endsWith('?');
}

/**
 * Continuation nudge delivered as a user message after a work-free response,
 * so the next round actually uses tools instead of narrating again.
 */
export function executeContinuationPrompt(taskHint?: string): string {
  const hint = taskHint?.trim();
  const task = hint ? `The task remains: "${hint.slice(0, 200)}".` : 'The task remains unfinished.';
  return [
    '[SYSTEM: EXECUTE-MODE GUARD] You ended your turn without doing any implementation work — no files were created or edited, no commands were run. Narration and intent statements do not count as progress.',
    task,
    'Resume now using your tools: inspect what exists, write/edit the files, run the build/tests, and iterate until it works. Do not re-ask for confirmation. If you need information only the user has, call ask_user with concrete options — that is the correct way to pause.',
  ].join(' ');
}

// ── Evidence-based completion gate ──────────────────────────────────────────
// Regression: a turn that ran one successful edit and then stopped — with a
// broken build or half the plan unimplemented — still earned the "Task
// complete" banner. Mutation alone proves change, not correctness. Before an
// implementation task may complete, at least one verification command must
// have run (build / test / typecheck) or the model must be forced to run one.

/** Bounded verification rounds per turn (never more than one). */
export const MAX_VERIFICATION_CONTINUATIONS = 1;

/**
 * A run_command invocation that counts as completion evidence. Build, test,
 * typecheck, lint — anything that can objectively fail against the change.
 */
export const VERIFICATION_COMMAND_PATTERN: RegExp =
  /(\bnpm\b|\bpnpm\b|\byarn\b)[^\n]*\b(test|run\s+test|build|typecheck|lint)\b|\b(vitest|jest|pytest|cargo\s+(build|test)|go\s+(build|test)|make|mvn|gradle|tsc|eslint|ruff|mypy)\b/i;

export interface VerificationInput {
  /** The user's request for this turn. */
  taskText: string;
  /** A plan from plan mode was approved and is pending execution. */
  hasApprovedPlan: boolean;
  /** Every run_command command string executed this turn. */
  commandsRun: Iterable<string>;
  /** Tool name → whether at least one invocation produced a non-error result. */
  toolsSucceeded?: ReadonlyMap<string, boolean>;
}

/**
 * True when the turn may NOT be called complete yet: implementation work
 * happened (a mutating tool succeeded) but nothing verified the result.
 * Question-style and conversational tasks never require verification.
 */
export function shouldRequireVerification(input: VerificationInput): boolean {
  // At least one mutating tool must have actually succeeded — otherwise the
  // narration guard (shouldForceExecuteContinuation) owns the decision.
  const mutated = [...(input.toolsSucceeded?.entries() ?? [])]
    .some(([tool, ok]) => EXECUTE_MUTATING_TOOLS.has(tool) && ok === true);
  if (!mutated) return false;
  for (const command of input.commandsRun) {
    if (VERIFICATION_COMMAND_PATTERN.test(command)) return false;
  }
  const task = input.taskText.trim();
  if (task.length < 2) return false;
  if (PURE_CONVERSATION_PATTERN.test(task)) return false;
  if (QUESTION_PATTERN.test(task)) return false;
  if (input.hasApprovedPlan) return true;
  return IMPLEMENTATION_PATTERN.test(task);
}

/**
 * Continuation nudge delivered when implementation ran but nothing verified
 * the result. One bounded round: the model must produce evidence or state
 * precisely why it cannot.
 */
export function verificationPrompt(taskHint?: string): string {
  const hint = taskHint?.trim();
  const task = hint ? `The task: "${hint.slice(0, 200)}".` : '';
  return [
    '[SYSTEM: EXECUTE-MODE VERIFICATION] You made changes but never verified them — no build, test, or typecheck command ran this turn.',
    task,
    'Before completion, run the relevant verification (build/tests/typecheck) with run_command and confirm the output is clean. If verification fails, fix and re-run. If it genuinely cannot run here (missing toolchain, environment constraint), state exactly why verification is impossible and what you checked instead.',
  ].join(' ');
}

/**
 * Wake-up call: issued after a FULL guard cycle failed to start the work.
 * Maximally blunt and constrained — this is the last automatic attempt, and
 * on the forced step the ONLY tools available are mutating ones.
 */
export function wakeUpPrompt(taskHint?: string): string {
  const hint = taskHint?.trim();
  const task = hint ? `The task: "${hint.slice(0, 200)}".` : '';
  return [
    '[SYSTEM: WAKE-UP CALL] You have failed to start the work across an entire guard cycle. This is the final automatic attempt.',
    task,
    'Your very next response MUST begin with a mutating tool call — create_file, write_file, edit_file, or run_command. ZERO prose before the call. Pick the smallest real piece of the task (even scaffolding or a stub) and DO it. Only after the call lands may you write text.',
  ].join(' ');
}