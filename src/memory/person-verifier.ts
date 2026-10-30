/**
 * Is it a person? New names found in memories are checked by a model —
 * new ones only (rebuilds of old memories never queue), in batches, on a
 * slow clock, under a daily cap — so the people list stays real without a
 * call per mention. The owner's own edits always win and are never queued.
 *
 *   - waits `intervalMs` (5 min) between runs, longer after a failure;
 *   - one call checks up to `batch` (20) names;
 *   - at most `dailyCap` (24) calls a day;
 *   - does nothing while the queue is empty.
 */

import { logger } from '../utils/logger.js';

export type PersonVerdict = 'person' | 'pet' | 'not_person' | 'unsure';

export interface PersonCheckItem {
  person_id: string;
  name: string;
  context: string | null;
}

export interface PersonVerifierHost {
  pendingPersonChecks(limit: number): PersonCheckItem[];
  countPersonChecks(): number;
  applyPersonCheck(personId: string, verdict: PersonVerdict): void;
}

export interface PersonVerifierStatus {
  enabled: boolean;
  pending: number;
  callsToday: number;
  dailyCap: number;
  lastRunAt: number | null;
  lastError: string | null;
  nextRunAt: number | null;
  checked: number;
}

export interface PersonVerifierOptions {
  intervalMs?: number;
  batch?: number;
  dailyCap?: number;
  now?: () => number;
}

export type PersonClassifier = (items: Array<{ id: string; name: string; context: string }>) => Promise<Record<string, PersonVerdict>>;

export class PersonVerifier {
  private readonly intervalMs: number;
  private readonly batch: number;
  private readonly dailyCap: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private failures = 0;
  private day = '';
  private calls = 0;
  private checked = 0;
  private lastRunAt: number | null = null;
  private lastError: string | null = null;
  private nextRunAt: number | null = null;

  constructor(private readonly host: PersonVerifierHost, private readonly classify: PersonClassifier, opts: PersonVerifierOptions = {}) {
    this.intervalMs = opts.intervalMs ?? 5 * 60_000;
    this.batch = opts.batch ?? 20;
    this.dailyCap = opts.dailyCap ?? 24;
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    this.schedule(60_000);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextRunAt = null;
  }

  status(): PersonVerifierStatus {
    this.rollDay();
    let pending = 0;
    try { pending = this.host.countPersonChecks(); } catch { /* db closed */ }
    return { enabled: this.timer !== null || this.running, pending, callsToday: this.calls, dailyCap: this.dailyCap, lastRunAt: this.lastRunAt, lastError: this.lastError, nextRunAt: this.nextRunAt, checked: this.checked };
  }

  /** One run: returns how many names were checked (0 when idle, capped or failing). */
  async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.rollDay();
    if (this.calls >= this.dailyCap) return 0;
    const items = this.host.pendingPersonChecks(this.batch);
    if (items.length === 0) return 0;
    this.running = true;
    this.calls += 1;
    this.lastRunAt = this.now();
    try {
      const verdicts = await this.classify(items.map((i) => ({ id: i.person_id, name: i.name, context: i.context ?? '' })));
      for (const item of items) this.host.applyPersonCheck(item.person_id, verdicts[item.person_id] ?? 'unsure');
      this.failures = 0;
      this.lastError = null;
      this.checked += items.length;
      return items.length;
    } catch (err) {
      this.failures += 1;
      this.lastError = err instanceof Error ? err.message : String(err);
      logger.warn({ err: this.lastError }, 'Person check failed; will retry later');
      return 0;
    } finally {
      this.running = false;
    }
  }

  private schedule(delay: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.nextRunAt = this.now() + delay;
    this.timer = setTimeout(() => {
      void this.runOnce().finally(() => {
        // Back off after failures: 5 min → 10 → 20 → … → 1 h.
        const next = Math.min(60 * 60_000, this.intervalMs * 2 ** Math.min(this.failures, 4));
        this.schedule(next);
      });
    }, delay);
    this.timer.unref?.();
  }

  private rollDay(): void {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.calls = 0;
    }
  }
}

/** The prompt and parser for a batch check; kept here so tests cover them. */
export function personCheckPrompt(items: Array<{ id: string; name: string; context: string }>): string {
  const lines = items.map((i, n) => `${n + 1}. name: "${i.name.replace(/"/g, "'")}"\n   context: "${i.context.replace(/\s+/g, ' ').replace(/"/g, "'").slice(0, 300)}"`);
  return [
    'For each name below, decide what it refers to in its context.',
    'Answer "person" for a real human being (the user, family, friends, colleagues, public figures),',
    '"pet" for an animal someone keeps, "not_person" for anything else (companies, products, places,',
    'projects, software, fictional or game characters, ordinary words), "unsure" if the context cannot tell.',
    'Reply with one line per name, exactly: <number>: <person|pet|not_person|unsure>',
    '',
    ...lines,
  ].join('\n');
}

export function parsePersonCheck(text: string, items: Array<{ id: string }>): Record<string, PersonVerdict> {
  const out: Record<string, PersonVerdict> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s*[:.)-]\s*(person|pet|not_person|not a person|unsure)\b/i.exec(line);
    if (!m) continue;
    const item = items[Number(m[1]) - 1];
    if (!item) continue;
    const v = m[2].toLowerCase().replace(/ /g, '_').replace('not_a_person', 'not_person') as PersonVerdict;
    out[item.id] = v;
  }
  return out;
}
