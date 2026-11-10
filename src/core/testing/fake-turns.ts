/**
 * Test helpers for agent internals built with `Object.create(Agent.prototype)`
 * (no constructor): the per-turn fields (ADR-037) live in `activeTurns`, so a
 * test marks a chat busy by registering a running turn instead of setting
 * `processing` / `currentMessage`.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ChannelMessage } from '../../types/channel.js';
import { Agent, laneKeyFor } from '../agent.js';
import { Lifecycle } from '../lifecycle.js';

/**
 * The fields a constructor-less agent needs for queue and turn bookkeeping:
 * an always-admitting governor and a capability stub with a plain cwd.
 */
export function bareTurnFields(opts: { limit?: number; cwd?: string } = {}): Record<string, unknown> {
  const limit = opts.limit ?? 4;
  let cwd = opts.cwd ?? process.cwd();
  return {
    messageQueue: [],
    queuedWorkKeys: new Set(),
    activeTurns: new Map(),
    laneCwd: new Map(),
    turnStore: new AsyncLocalStorage(),
    turnSeq: 0,
    idleWaiters: [],
    lastAdmitRefusal: null,
    governor: {
      limit: () => limit,
      canAdmit: (running: number) => (running === 0 || running < limit ? { ok: true } : { ok: false, reason: 'capacity' }),
      noteIdle: () => {},
    },
    capabilities: {
      claimTurnState: () => {},
      getCwd: () => cwd,
      getGlobalCwd: () => cwd,
      setGlobalCwd: (dir: string) => { cwd = dir; },
      permissions: { withTurn: <T>(fn: () => T) => fn() },
    },
  };
}

/** Mark `message`'s chat as running a turn (optionally doing `activity`). Returns the turn. */
export function startFakeTurn(agent: Agent, message: ChannelMessage, activity = '', startedAt = Date.now()): { abort: AbortController; message: ChannelMessage } {
  const turns = (agent as unknown as { activeTurns: Map<string, unknown> }).activeTurns;
  const turn = {
    id: `fake-${message.id}`,
    laneKey: laneKeyFor(message),
    message,
    startedAt,
    abort: new AbortController(),
    abortReason: null,
    cancelled: null,
    activity,
    completedStepCount: 0,
    stepNarrative: [],
    workKey: null,
    lastProgressAt: startedAt,
    lastTypingAt: 0,
    injectedBeliefIds: [],
    lifecycle: new Lifecycle('idle'),
    programming: null,
    done: false,
  };
  turns.set(turn.laneKey, turn);
  return turn;
}

export function endFakeTurns(agent: Agent): void {
  (agent as unknown as { activeTurns: Map<string, unknown> }).activeTurns.clear();
}
