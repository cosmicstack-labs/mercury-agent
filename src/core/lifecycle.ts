import type { AgentState } from '../types/agent.js';
import { logger } from '../utils/logger.js';

type Transition = { from: AgentState; to: AgentState; condition?: () => boolean };

const VALID_TRANSITIONS: Transition[] = [
  { from: 'unborn', to: 'birthing' },
  { from: 'birthing', to: 'onboarding' },
  { from: 'onboarding', to: 'idle' },
  { from: 'idle', to: 'thinking' },
  { from: 'thinking', to: 'responding' },
  { from: 'responding', to: 'idle' },
  { from: 'idle', to: 'sleeping' },
  { from: 'sleeping', to: 'awakening' },
  { from: 'awakening', to: 'idle' },
  { from: 'thinking', to: 'idle' },
  { from: 'idle', to: 'onboarding' },
  { from: 'idle', to: 'delegating' },
  { from: 'delegating', to: 'idle' },
];

export class Lifecycle {
  private state: AgentState = 'unborn';

  getState(): AgentState {
    return this.state;
  }

  transition(to: AgentState): boolean {
    const valid = VALID_TRANSITIONS.some(t => t.from === this.state && t.to === to);
    if (!valid) {
      logger.warn({ from: this.state, to }, 'Invalid state transition');
      return false;
    }
    logger.info({ from: this.state, to }, 'State transition');
    this.state = to;
    return true;
  }

  is(newState: AgentState): boolean {
    return this.state === newState;
  }

  canTransitionTo(to: AgentState): boolean {
    return VALID_TRANSITIONS.some(t => t.from === this.state && t.to === to);
  }
}