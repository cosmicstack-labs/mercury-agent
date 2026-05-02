import { logger } from '../utils/logger.js';

export type ProgrammingModeState = 'off' | 'plan' | 'execute';

export class ProgrammingMode {
  private state: ProgrammingModeState = 'off';
  private projectContext: string | null = null;

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
    logger.info('Programming mode: execute');
  }

  setOff(): void {
    this.state = 'off';
    this.projectContext = null;
    logger.info('Programming mode: off');
  }

  toggle(): ProgrammingModeState {
    if (this.state === 'off') {
      this.state = 'plan';
    } else if (this.state === 'plan') {
      this.state = 'execute';
    } else {
      this.state = 'off';
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
      suffix += '\nDo NOT write code yet. Present your plan using numbered steps.';
      suffix += '\nWhen multiple approaches exist, use the ask_user tool to present choices.';
      suffix += '\nWait for user approval before switching to execution.';
    } else if (this.state === 'execute') {
      suffix += '\nMode: EXECUTE';
      suffix += '\nYou are in execution mode. Implement the plan step by step.';
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