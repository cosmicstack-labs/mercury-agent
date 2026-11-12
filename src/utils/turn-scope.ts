/**
 * Turn scope (ADR-037): per-turn values for state that used to be one
 * process-wide field, so several chat turns can run at once without
 * overwriting each other's working directory, tool switches and so on.
 *
 * A turn runs inside `runInTurnScope`. Everything it awaits or schedules
 * (stream callbacks, tool executions, timers) carries the same scope through
 * AsyncLocalStorage. A `ScopedValue` that the turn has claimed reads and
 * writes that turn's own copy; anywhere else (no turn, or a value the turn
 * never claimed) it reads and writes the process-wide value, which keeps
 * single-turn behavior unchanged.
 *
 * Every ScopedValue is its own key, so two registries (the main agent's and
 * a bot's) never see each other's per-turn values even when one runs inside
 * the other's async tree.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

type Cells = Map<object, { value: unknown }>;

const scopeStore = new AsyncLocalStorage<Cells>();

/** Run `fn` (and everything it awaits or schedules) in a fresh turn scope. */
export function runInTurnScope<T>(fn: () => T): T {
  return scopeStore.run(new Map(), fn);
}

/** Is the calling code inside a turn scope? */
export function inTurnScope(): boolean {
  return scopeStore.getStore() !== undefined;
}

export class ScopedValue<T> {
  private global: T;

  constructor(initial: T) {
    this.global = initial;
  }

  /** The calling turn's value when it claimed this one, else the process-wide value. */
  get(): T {
    const cell = scopeStore.getStore()?.get(this);
    return cell ? (cell.value as T) : this.global;
  }

  /** Writes the calling turn's copy when it claimed this value, else the process-wide one. */
  set(value: T): void {
    const cell = scopeStore.getStore()?.get(this);
    if (cell) cell.value = value;
    else this.global = value;
  }

  /**
   * Give the calling turn its own copy, starting at `value` (default: the
   * current process-wide value). Outside a turn scope this is a no-op and
   * returns false, so callers can't accidentally write a global.
   */
  claim(value: T = this.global): boolean {
    const cells = scopeStore.getStore();
    if (!cells) return false;
    cells.set(this, { value });
    return true;
  }

  /** Has the calling turn claimed this value? */
  isClaimed(): boolean {
    return scopeStore.getStore()?.has(this) === true;
  }

  /** The process-wide value, regardless of the calling turn. */
  getGlobal(): T {
    return this.global;
  }

  setGlobal(value: T): void {
    this.global = value;
  }
}
