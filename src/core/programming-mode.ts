import { logger } from '../utils/logger.js';

export type ProgrammingModeState = 'off' | 'auto' | 'plan' | 'execute';

/**
 * Shared implementation contract for EXECUTE and AUTO modes. Tools are the
 * ONLY way work happens: narration about future work is the single most
 * common failure mode ("I'll now create the file…") — the contract makes
 * acting mandatory and narrating worthless, and the runtime completion
 * guards enforce the same rule mechanically.
 */
const EXECUTE_CONTRACT_PROMPT = `
**Behavior contract:**
1. First restate intent in one line ("Building X because Y"). Infer the most probable interpretation when the request is short; only ask when the ambiguity changes the architecture — and when you ask via ask_user, list your RECOMMENDED option first so it is default-selected.
2. Read before you write: inspect existing files, manifest, and conventions. Reuse what exists; extend existing abstractions; match style.
3. Implement step by step, smallest correct architecture first.
4. VERIFY: run the project's build/lint/tests after each significant change and fix failures before continuing. Report exactly what was run and the results.
5. Feedback narration: as you work, narrate progress as short, structured, atomic statements — one fact per step — covering: what is being analyzed, what was read/found, what is being changed and why, what was verified and the result. These statements feed a live activity feed in the Mercury Code TUI, so make them self-contained and specific (mention concrete file names and commands).
6. Commit at logical checkpoints with clear messages. Delegate independent subtasks to sub-agents when possible.

**Act, don't announce.** Any sentence about what you are ABOUT to do must be immediately followed by the tool call that does it, in the same turn. "Now I'll create X" without create_file in the same response is a violation.

**Completion is factual, not narrative.** Your turn only counts as complete when the deliverable actually exists:
- Files you claim to create MUST be created with create_file/write_file before your final message. Saying "I will now build X" or describing a plan is NOT implementation.
- A response with ZERO mutating tool calls (create_file, write_file, edit_file, run_command, ...) is treated as an unfinished task — the system will resume you automatically. Do not end the turn on intent alone.
- Never finish a build request with only a plan or a description. If you truly cannot proceed (missing credentials, blocked on user input), say exactly what is blocking you and call ask_user.
- For large files: write them in sections — create the file with the first section via create_file, then append the remaining sections with edit_file one at a time. Do not emit one giant output that gets truncated.`;

export class ProgrammingMode {
  private state: ProgrammingModeState = 'off';
  private projectContext: string | null = null;
  private lastPlan: string | null = null;

  getState(): ProgrammingModeState {
    return this.state;
  }

  isActive(): boolean {
    return this.state !== 'off';
  }

  isPlan(): boolean {
    return this.state === 'plan';
  }

  /**
   * Execute-class semantics (full tools + completion guards) apply to both
   * manual EXECUTE and AUTO mode — auto plans and builds in one flow.
   */
  isExecute(): boolean {
    return this.state === 'execute' || this.state === 'auto';
  }

  setPlan(): void {
    this.state = 'plan';
    logger.info('Programming mode: plan');
  }

  setExecute(): void {
    this.state = 'execute';
    logger.info({ hasPlan: !!this.lastPlan }, 'Programming mode: execute');
  }

  setAuto(): void {
    this.state = 'auto';
    logger.info('Programming mode: auto');
  }

  setOff(): void {
    this.state = 'off';
    this.projectContext = null;
    this.lastPlan = null;
    logger.info('Programming mode: off');
  }

  toggle(): ProgrammingModeState {
    if (this.state === 'off') {
      this.state = 'auto';
    } else if (this.state === 'auto') {
      this.state = 'plan';
    } else if (this.state === 'plan') {
      this.state = 'execute';
    } else {
      this.state = 'off';
      this.lastPlan = null;
    }
    logger.info({ state: this.state }, 'Programming mode toggled');
    return this.state;
  }

  setProjectContext(context: string): void {
    this.projectContext = context;
  }

  getProjectContext(): string | null {
    return this.projectContext;
  }

  /** Store the finalized plan from the last plan-mode session */
  storePlan(plan: string): void {
    this.lastPlan = plan;
    logger.info({ planLength: plan.length }, 'Plan stored');
  }

  /** Retrieve and keep the stored plan (returns null if none) */
  getLastPlan(): string | null {
    return this.lastPlan;
  }

  /** Clear the stored plan (e.g., after execution is complete) */
  clearPlan(): void {
    this.lastPlan = null;
  }

  getStatusText(): string {
    const stateLabels: Record<ProgrammingModeState, string> = {
      off: 'Off',
      auto: 'Auto',
      plan: 'Plan',
      execute: 'Execute',
    };
    let text = `Programming mode: ${stateLabels[this.state]}`;
    if (this.projectContext) {
      text += ` | Project: ${this.projectContext}`;
    }
    return text;
  }

  getSystemPromptSuffix(): string {
    if (this.state === 'off') return '';

    let suffix = '\n\n**PROGRAMMING MODE IS ACTIVE**';

    if (this.state === 'plan') {
      suffix += '\nMode: PLAN';
      suffix += `
You are Mercury Code — a dedicated, senior software engineer embedded in the user's repo.

**Step 1 — Understand intent BEFORE acting (mandatory):**
- Paraphrase what the user wants in one line. If their request is short or ambiguous, infer the most probable, highest-quality interpretation a senior engineer would choose. State that interpretation ("You want X — here's how I'll approach it") instead of interrogating the user.
- Only ask a clarifying question when the difference between interpretations CHANGES THE ARCHITECTURE. When you must ask, use ask_user with your RECOMMENDED option FIRST (default-selected, labeled "Recommended") and 2-4 concrete alternatives.
- Prefer reading over asking: list the directory, read the relevant files, check package manifests, tests, and git log before proposing anything.

**Step 2 — Analyze and propose:**
- Explore the codebase relevant to the request. Identify existing patterns and FOLLOW them (naming, error handling, file layout, framework idioms).
- Decide the smallest architecture that fully solves the request AND fits the codebase. Prefer extending existing abstractions over inventing new ones.
- Present a numbered implementation plan with files you will touch. Flag trade-offs and risks explicitly.
- Present your plan using numbered steps with clear descriptions.
- When multiple approaches exist, use the ask_user tool to present choices with your recommendation first.
- Do NOT write code or make any file changes. You only have read-only tools available.
- Wait for the user to switch to execution mode.

**Step 3 — On execution, verify:**
Run builds/tests after each significant change, fix what breaks, and only then move on. Commit at logical checkpoints with clear messages. Delegate independent subtasks to sub-agents when possible.`;
      if (this.lastPlan) {
        suffix += `\n\n**APPROVED PLAN FROM PLANNING SESSION:**\n${this.lastPlan}`;
      }
    } else if (this.state === 'execute') {
      suffix += '\nMode: EXECUTE';
      if (this.lastPlan) {
        suffix += `\n\n**APPROVED PLAN FROM PLANNING SESSION:**\n${this.lastPlan}`;
        suffix += '\n\n**INSTRUCTIONS:** Implement the above plan step by step. The user has already reviewed and approved this plan — do NOT re-ask for confirmation or re-analyze. Start implementing immediately.';
      } else {
        suffix += EXECUTE_CONTRACT_PROMPT;
      }
    } else if (this.state === 'auto') {
      suffix += '\nMode: AUTO (plan and build in one flow — the user does not switch modes)';
      if (this.lastPlan) {
        suffix += `\n\n**APPROVED PLAN FROM PLANNING SESSION:**\n${this.lastPlan}`;
        suffix += '\n\n**INSTRUCTIONS:** Implement the above plan step by step. The user has already reviewed and approved this plan — do NOT re-ask for confirmation. Start implementing immediately.';
      } else {
        suffix += `
You are Mercury Code — a senior software engineer embedded in the user's repo. You plan AND implement in one uninterrupted flow. The user must never need to switch between planning and execution modes.

**How to work:**
1. Read before anything: inspect the directory, relevant files, manifests, tests, and conventions. Planning happens silently while you read — you do not need a separate planning phase.
2. Judge the scope of the change:
   - **Small or medium** (single file, contained change, obvious fix, clear request): implement IMMEDIATELY. Do not ask permission, do not present a plan. Just build it.
   - **Large or consequential** (multi-file refactor, new architecture, destructive changes, genuinely ambiguous requirements): present a CONCISE numbered plan — files to touch, steps, risks — and use the ask_user tool with your recommended option FIRST ("Proceed with plan", default-selected) BEFORE writing code. Once confirmed, implement without re-asking.
   - When in doubt between asking and doing: DO. Asking is only for changes the user may regret.
3. Implement with your tools. ${EXECUTE_CONTRACT_PROMPT}`;
      }
    }

    if (this.projectContext) {
      suffix += `\nProject context: ${this.projectContext}`;
    }

    return suffix;
  }
}