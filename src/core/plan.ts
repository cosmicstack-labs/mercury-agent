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
export interface Plan { steps: PlanStep[]; updatedAt: number }

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
      for (const [k, v] of Object.entries(raw)) if (Array.isArray(v?.steps)) this.plans.set(k, { steps: normalizePlan(v.steps), updatedAt: Number(v.updatedAt) || 0 });
    } catch { /* a broken file starts fresh */ }
  }

  get(id: string): Plan | null {
    this.load();
    return this.plans.get(id) ?? null;
  }

  set(id: string, steps: PlanStep[], now = Date.now()): Plan {
    this.load();
    const plan = { steps, updatedAt: now };
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
