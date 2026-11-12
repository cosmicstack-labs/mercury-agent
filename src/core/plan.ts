import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getMercuryHome } from '../utils/config.js';

/**
 * The model's plan checklist (update_plan), as clients show it: the terminal
 * pins it in the TUI, the apps show a card above the composer. The latest
 * plan per conversation is kept on disk so reopening a chat (or restarting
 * Mercury) shows where the work stands.
 */

export type PlanStatus = 'pending' | 'active' | 'done';
export interface PlanStep { label: string; status: PlanStatus }
/**
 * How a plan stands once the turn that worked on it ended without finishing
 * it: paused (the reply came, steps are still open; continues when you ask)
 * or stopped (you stopped the turn, or it failed). Absent while it is worked on.
 */
export type PlanState = 'paused' | 'stopped';
export interface Plan { steps: PlanStep[]; updatedAt: number; state?: PlanState }

/**
 * A plan as the turn left it. Models often finish the work and forget to
 * tick the last step (✓✓✓✓◐ while the answer is already there), and a
 * stopped turn left its step "in progress" for good. So when a turn ends:
 *   - completed, one step open and every step before it done → that step is
 *     done (the reply is the last step);
 *   - completed, more open → paused, at the first open step;
 *   - stopped or failed → stopped, at the first open step.
 * Null when there's nothing to change (no plan, or already all done).
 */
export function settlePlan(steps: PlanStep[], outcome: 'completed' | 'stopped' | 'failed'): { steps: PlanStep[]; state?: PlanState } | null {
  if (!steps.length || steps.every((s) => s.status === 'done')) return null;
  const open = steps.map((s, i) => (s.status === 'done' ? -1 : i)).filter((i) => i >= 0);
  if (outcome === 'completed' && open.length === 1 && open[0] === steps.length - 1) {
    return { steps: steps.map((s) => ({ ...s, status: 'done' as const })) };
  }
  // Nothing is "in progress" once the turn is over: the first open step is where it stopped.
  const at = open[0];
  return { steps: steps.map((s, i) => (s.status === 'done' ? s : { ...s, status: i === at ? 'active' as const : 'pending' as const })), state: outcome === 'completed' ? 'paused' : 'stopped' };
}

/** Clean up what the model sent: labels trimmed and unique, known statuses, at most one active step. */
export function normalizePlan(steps: unknown): PlanStep[] {
  if (!Array.isArray(steps)) return [];
  const out: PlanStep[] = [];
  for (const raw of steps.slice(0, 20)) {
    const label = typeof (raw as { label?: unknown })?.label === 'string' ? (raw as { label: string }).label.trim() : '';
    const status = (raw as { status?: unknown })?.status;
    if (!label || (status !== 'pending' && status !== 'active' && status !== 'done')) continue;
    if (out.some((s) => s.label === label)) continue;
    out.push({ label: label.slice(0, 160), status });
  }
  const active = out.findIndex((s) => s.status === 'active');
  out.forEach((s, i) => { if (s.status === 'active' && i !== active) s.status = 'pending'; });
  return out;
}

const MAX_KEPT = 200;

export class PlanStore {
  private plans = new Map<string, Plan>();
  private loaded = false;
  constructor(private readonly file = join(getMercuryHome(), 'memory', 'plans.json')) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (!existsSync(this.file)) return;
      const raw = JSON.parse(readFileSync(this.file, 'utf-8')) as Record<string, Plan>;
      for (const [k, v] of Object.entries(raw)) if (Array.isArray(v?.steps)) this.plans.set(k, { steps: normalizePlan(v.steps), updatedAt: Number(v.updatedAt) || 0, ...(v.state === 'paused' || v.state === 'stopped' ? { state: v.state } : {}) });
    } catch { /* a broken file starts fresh */ }
  }

  get(id: string): Plan | null {
    this.load();
    return this.plans.get(id) ?? null;
  }

  set(id: string, steps: PlanStep[], now = Date.now(), state?: PlanState): Plan {
    this.load();
    const plan: Plan = { steps, updatedAt: now, ...(state ? { state } : {}) };
    this.plans.delete(id);
    this.plans.set(id, plan);
    while (this.plans.size > MAX_KEPT) this.plans.delete(this.plans.keys().next().value as string);
    this.save();
    return plan;
  }

  private save(): void {
    try {
      mkdirSync(join(this.file, '..'), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.plans)), { encoding: 'utf-8', mode: 0o600 });
      renameSync(tmp, this.file);
    } catch { /* the live card still works; only the reopen view would be stale */ }
  }
}
