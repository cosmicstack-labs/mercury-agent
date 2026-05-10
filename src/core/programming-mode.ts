import { logger } from '../utils/logger.js';

export type ProgrammingModeState = 'off' | 'plan' | 'execute';

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

  isExecute(): boolean {
    return this.state === 'execute';
  }

  setPlan(): void {
    this.state = 'plan';
    logger.info('Programming mode: plan');
  }

  setExecute(): void {
    this.state = 'execute';
    logger.info({ hasPlan: !!this.lastPlan }, 'Programming mode: execute');
  }

  setOff(): void {
    this.state = 'off';
    this.projectContext = null;
    this.lastPlan = null;
    logger.info('Programming mode: off');
  }

  toggle(): ProgrammingModeState {
    if (this.state === 'off') {
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
      suffix += '\nYou are in planning mode. Explore the codebase, analyze the problem, and present a step-by-step implementation plan.';
      suffix += '\nDo NOT write code or make any file changes. You only have read-only tools available.';
      suffix += '\nPresent your plan using numbered steps with clear descriptions.';
      suffix += '\nWhen multiple approaches exist, use the ask_user tool to present choices.';
      suffix += '\nWait for user approval before the user switches to execution mode.';
    } else if (this.state === 'execute') {
      suffix += '\nMode: EXECUTE';
      if (this.lastPlan) {
        suffix += '\n\n**APPROVED PLAN FROM PLANNING SESSION:**';
        suffix += `\n${this.lastPlan}`;
        suffix += '\n\n**INSTRUCTIONS:** Implement the above plan step by step. The user has already reviewed and approved this plan — do NOT re-ask for confirmation or re-analyze. Start implementing immediately.';
      } else {
        suffix += '\nYou are in execution mode. Implement the requested changes step by step.';
      }
      suffix += '\nRun builds/tests after each significant change.';
      suffix += '\nCommit at logical checkpoints.';
      suffix += '\nDelegate independent subtasks to sub-agents when possible.';
    }

    if (this.projectContext) {
      suffix += `\nProject context: ${this.projectContext}`;
    }

    return suffix;
  }
}