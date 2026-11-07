import { AsyncLocalStorage } from 'node:async_hooks';
import type { ChannelMessage } from '../types/channel.js';
import type { NarrativeStep } from '../utils/tool-label.js';

/** The abort reason attached to one turn (was one global on Agent). */
export type TurnAbortReason = 'stalled' | 'time-limit' | 'memory-pressure' | 'backgrounded' | 'stopped' | 'halted' | null;

/**
 * Per-session turn state. Parallel working sessions: every mid-turn session
 * owns one of these. The single-turn body in Agent (handleMessage) reads
 * through the `turn` accessor pair below, which is bound per execution
 * context via AsyncLocalStorage — so the same code runs concurrently for
 * several sessions with no shared turn fields.
 */
export interface TurnState {
  /** Keyed by: msg.metadata?.sessionId ?? msg.sessionId ?? msg.channelId. */
  sessionKey: string;
  channelId: string;
  channelType: string;
  currentMessage: ChannelMessage;
  abort: AbortController;
  abortReason: TurnAbortReason;
  activity: string;
  lastProgressAt: number;
  completedStepCount: number;
  stepNarrative: NarrativeStep[];
  processing: boolean;
  startedAt: number;
  workKey: string | null;
  heartbeatStop: (() => void) | null;
  /** Resolved working dir chosen for this turn (workCwd/programmingCwd/global cwd). */
  workDir: string | null;
  /** Interval handles owned by this turn; cleared when the turn ends. */
  timers: Array<ReturnType<typeof setInterval>>;
}

export function createTurnState(msg: ChannelMessage, sessionKey: string, workKey: string | null): TurnState {
  return {
    sessionKey,
    channelId: msg.channelId,
    channelType: msg.channelType,
    currentMessage: msg,
    abort: new AbortController(),
    abortReason: null,
    activity: '',
    lastProgressAt: Date.now(),
    completedStepCount: 0,
    stepNarrative: [],
    processing: true,
    startedAt: Date.now(),
    workKey,
    heartbeatStop: null,
    workDir: null,
    timers: [],
  };
}

const turnStore = new AsyncLocalStorage<TurnState>();

/** Run `fn` with `turn` as the ambient turn for this async execution. */
export function runWithTurn<T>(turn: TurnState, fn: () => T): T {
  return turnStore.run(turn, fn);
}

/** The turn of the current async context (undefined outside a turn). */
export function currentTurn(): TurnState | undefined {
  return turnStore.getStore();
}

/** A mutable scratch turn for tests and bootstrap paths that need field writes. */
export function testTurn(partial: Partial<TurnState> = {}): TurnState {
  return {
    sessionKey: 'test',
    channelId: 'test',
    channelType: 'cli',
    currentMessage: { id: 't', channelId: 'test', channelType: 'cli', senderId: 's', content: '', timestamp: Date.now() } as ChannelMessage,
    abort: new AbortController(),
    abortReason: null,
    activity: '',
    lastProgressAt: Date.now(),
    completedStepCount: 0,
    stepNarrative: [],
    processing: false,
    startedAt: Date.now(),
    workKey: null,
    heartbeatStop: null,
    workDir: null,
    timers: [],
    ...partial,
  };
}
