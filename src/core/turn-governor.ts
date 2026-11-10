/**
 * Turn governor (ADR-037): the one place that decides how many chat turns
 * run at once, and what gives way when memory gets tight.
 *
 * Chat turns are network-bound (they wait on a provider most of the time),
 * so they share one process and one event loop; threads would multiply heap
 * cost without making a turn faster. The cost of concurrency is the shared
 * V8 heap. So this governor:
 *
 *   - sets a ceiling from the heap limit, the machine's RAM and the platform
 *     (Termux and small machines get 2), overridable in config;
 *   - draws a stop line that is exactly the old single-task guard's line
 *     with one turn running, and one turn's heap budget higher for every
 *     further turn (never past the step governor's abort line);
 *   - admits a new turn only while the heap leaves that turn its budget
 *     below the line it would raise the stop line to (and, on Linux/Android,
 *     the system still has memory available) — but always admits one when
 *     nothing runs, so work never deadlocks;
 *   - watches the heap once per second for the whole process (replacing a
 *     guard that every turn used to run for itself) and, past the stop
 *     line, stops the NEWEST turn — one at a time, with a cooldown — so
 *     long-running work survives and the rest relieve the pressure;
 *   - past the exit line (256 MB above the stop line, which stopping turns
 *     could not prevent), hands control to `onExit` so the process stops
 *     while state can still be persisted.
 */
import { freemem, totalmem } from 'node:os';
import { getHeapStatistics } from 'node:v8';
import { memoryGovernorThresholds, type MemoryGovernorThresholds } from './memory-governor.js';
import { taskHeapAbortThreshold } from './memory-guard.js';
import { isTermux } from '../utils/platform.js';
import { logger } from '../utils/logger.js';

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** Heap a concurrent turn is budgeted (history, stream buffers, tool output). */
export const TURN_HEAP_BUDGET_BYTES = 192 * MB;
/** Default ceiling for the automatic limit; config may go higher. */
export const DEFAULT_MAX_TURNS = 4;
/** Hard ceiling for a configured limit. */
export const MAX_CONFIGURABLE_TURNS = 16;
/** Between two pressure stops: give the first one time to free its memory. */
const SHED_COOLDOWN_MS = 5_000;
const WATCH_INTERVAL_MS = 1_000;

export interface MachineFacts {
  heapSizeLimit: number;
  totalMem: number;
  termux: boolean;
}

export function machineFacts(): MachineFacts {
  return { heapSizeLimit: getHeapStatistics().heap_size_limit, totalMem: totalmem(), termux: isTermux() };
}

/**
 * Automatic concurrent-turn limit. Heap headroom (limit minus a 512 MB
 * reserve the process needs to persist and respond) divided by a per-turn
 * budget, then capped by RAM and platform. Always at least 1.
 */
export function autoTurnLimit(m: MachineFacts): number {
  const headroom = Math.max(0, m.heapSizeLimit - 512 * MB);
  let limit = Math.floor(headroom / TURN_HEAP_BUDGET_BYTES);
  limit = Math.min(limit, DEFAULT_MAX_TURNS);
  if (m.termux || m.totalMem < 4 * GB) limit = Math.min(limit, 2);
  else if (m.totalMem < 8 * GB) limit = Math.min(limit, 3);
  return Math.max(1, limit);
}

/** Configured limit (> 0) wins, clamped; otherwise automatic. */
export function resolveTurnLimit(configured: number | undefined, m: MachineFacts): number {
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
    return Math.min(MAX_CONFIGURABLE_TURNS, Math.max(1, Math.floor(configured)));
  }
  return autoTurnLimit(m);
}

/** A running turn as the governor sees it. */
export interface GovernedTurn {
  readonly id: string;
  readonly startedAt: number;
  readonly label: string;
  /** True once the turn is stopping (by anyone); it is never picked twice. */
  isStopping(): boolean;
  /** Stop this turn because memory is tight. */
  shed(error: Error): void;
}

export type GovernorVerdict = 'ok' | 'shed' | 'exit';

export type AdmitDecision = { ok: true } | { ok: false; reason: 'capacity' | 'memory' | 'system-memory' };

export interface TurnGovernorDeps {
  limit: number;
  heapSizeLimit?: number;
  /** Current heap use (default: process.memoryUsage().heapUsed). */
  heapUsed?: () => number;
  /** Bytes the OS still has available, or null where that number isn't trustworthy. */
  systemAvailable?: () => number | null;
  totalMem?: number;
  now?: () => number;
  /** Heap use beyond the exit line: persist what you can and stop the process. */
  onExit?: (heapUsed: number) => void;
}

/**
 * macOS and Windows report "free" memory without the reclaimable cache, so
 * a busy desktop looks out of memory all the time. Only Linux/Android
 * (MemAvailable) is trusted for admission.
 */
function defaultSystemAvailable(): number | null {
  if (process.platform !== 'linux' && process.platform !== 'android') return null;
  return freemem();
}

export class TurnGovernor {
  private limitValue: number;
  private readonly heapLimit: number;
  private readonly heapUsed: () => number;
  private readonly systemAvailable: () => number | null;
  private readonly totalMem: number;
  private readonly now: () => number;
  private readonly onExit?: (heapUsed: number) => void;
  private baseline: number;
  private thresholds: MemoryGovernorThresholds;
  private lastShedAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private exiting = false;

  constructor(deps: TurnGovernorDeps) {
    this.limitValue = Math.max(1, deps.limit);
    this.heapLimit = deps.heapSizeLimit ?? getHeapStatistics().heap_size_limit;
    this.heapUsed = deps.heapUsed ?? (() => process.memoryUsage().heapUsed);
    this.systemAvailable = deps.systemAvailable ?? defaultSystemAvailable;
    this.totalMem = deps.totalMem ?? totalmem();
    this.now = deps.now ?? Date.now;
    this.onExit = deps.onExit;
    this.baseline = this.heapUsed();
    this.thresholds = memoryGovernorThresholds({ heapSizeLimit: this.heapLimit, baselineHeapUsed: this.baseline });
  }

  limit(): number {
    return this.limitValue;
  }

  setLimit(limit: number): void {
    this.limitValue = Math.max(1, Math.floor(limit));
  }

  getThresholds(): MemoryGovernorThresholds {
    return this.thresholds;
  }

  /**
   * The heap the process sits at with no turn running. Re-measured whenever
   * the last turn ends, so the lines follow the process (plugins loaded,
   * caches warmed) instead of a boot-time number.
   */
  noteIdle(): void {
    const used = this.heapUsed();
    // Only move the baseline down freely; up only modestly, so a leak never
    // drags the abort line up with it.
    const next = used < this.baseline ? used : Math.min(used, this.baseline + 64 * MB);
    if (next !== this.baseline) {
      this.baseline = next;
      this.thresholds = memoryGovernorThresholds({ heapSizeLimit: this.heapLimit, baselineHeapUsed: this.baseline });
    }
  }

  /**
   * Heap at which a turn is stopped with `running` turns going: the old
   * per-task guard's line for one, plus one turn budget per extra turn,
   * capped at the step governor's abort line.
   */
  stopLine(running: number): number {
    const single = taskHeapAbortThreshold(this.heapLimit, this.baseline);
    const widened = single + Math.max(0, running - 1) * TURN_HEAP_BUDGET_BYTES;
    return Math.max(single, Math.min(widened, this.thresholds.abortBytes));
  }

  /** Beyond this the process exits: 256 MB past the stop line, never past the heap limit's safety margin. */
  exitLine(running: number): number {
    return Math.min(this.stopLine(running) + 256 * MB, Math.max(this.thresholds.exitBytes, this.stopLine(running) + 64 * MB));
  }

  verdict(running: number): GovernorVerdict {
    const used = this.heapUsed();
    if (used >= this.exitLine(running)) return 'exit';
    if (used >= this.stopLine(running)) return 'shed';
    return 'ok';
  }

  /** May one more turn start, with `running` turns already going? */
  canAdmit(running: number): AdmitDecision {
    if (running <= 0) return { ok: true };
    if (running >= this.limitValue) return { ok: false, reason: 'capacity' };
    if (this.heapUsed() + TURN_HEAP_BUDGET_BYTES >= this.stopLine(running + 1)) return { ok: false, reason: 'memory' };
    const available = this.systemAvailable();
    if (available !== null && available < Math.max(128 * MB, this.totalMem * 0.04)) {
      return { ok: false, reason: 'system-memory' };
    }
    return { ok: true };
  }

  /**
   * One pressure check. Past the abort line the newest running turn that
   * isn't already stopping is shed (at most one per cooldown); past the exit
   * line `onExit` runs once. Returns what it did, for tests and logs.
   */
  check(turns: GovernedTurn[]): { verdict: GovernorVerdict; shed?: string } {
    const used = this.heapUsed();
    const verdict = this.verdict(turns.length);
    if (verdict === 'exit') {
      if (!this.exiting) {
        this.exiting = true;
        logger.error({ heapMB: Math.round(used / MB), turns: turns.length }, 'Turn governor: heap past the exit line');
        this.onExit?.(used);
      }
      return { verdict };
    }
    if (verdict !== 'shed') return { verdict };
    const now = this.now();
    if (now - this.lastShedAt < SHED_COOLDOWN_MS) return { verdict };
    const victim = pickVictim(turns);
    if (!victim) return { verdict };
    this.lastShedAt = now;
    const heapMB = Math.round(used / MB);
    logger.warn({ heapMB, victim: victim.id, label: victim.label, running: turns.length }, 'Turn governor: memory pressure — stopping the newest turn');
    victim.shed(new Error(`Task stopped at ${heapMB}MB heap usage so the other running work could continue`));
    return { verdict, shed: victim.id };
  }

  /**
   * Should this turn give way now? Used at step boundaries (deterministic,
   * unlike the timer, which can't fire while the event loop is flooded):
   * true only past the stop line, and only for the turn the timer would pick.
   */
  shouldShed(turnId: string, turns: GovernedTurn[]): boolean {
    if (this.heapUsed() < this.stopLine(turns.length)) return false;
    return pickVictim(turns)?.id === turnId;
  }

  start(getTurns: () => GovernedTurn[]): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const turns = getTurns();
      if (turns.length === 0) return;
      try { this.check(turns); } catch (err) { logger.warn({ err }, 'Turn governor check failed'); }
    }, WATCH_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** Newest first: the turn with the least sunk work gives way. */
function pickVictim(turns: GovernedTurn[]): GovernedTurn | undefined {
  let victim: GovernedTurn | undefined;
  for (const t of turns) {
    if (t.isStopping()) continue;
    if (!victim || t.startedAt > victim.startedAt) victim = t;
  }
  return victim;
}
