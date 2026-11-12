import cron from 'node-cron';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { MercuryConfig } from '../utils/config.js';
import { getMercuryHome } from '../utils/config.js';
import { logger } from '../utils/logger.js';

export interface ScheduledTask {
  id: string;
  cron: string;
  handler: () => Promise<void>;
  description: string;
  timezone?: string;
}

export type ScheduledRunStatus = 'running' | 'completed' | 'failed' | 'interrupted' | 'skipped' | 'dispatched';
export interface ScheduledRun {
  id: string;
  status: ScheduledRunStatus;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

/** Queued main-agent work completes via finishRun; bots own a separate work ledger. */
export type ScheduledDispatch = void | 'queued' | 'dispatched' | 'skipped';

export interface ScheduledTaskManifest {
  id: string;
  cron?: string;
  description: string;
  skillName?: string;
  prompt?: string;
  delaySeconds?: number;
  executeAt?: string;
  createdAt: string;
  /** IANA timezone for cron; omitted means the host timezone for legacy schedules. */
  timezone?: string;
  /** Overdue one-shots default to skip, preserving the legacy no-replay behavior. */
  missedRunPolicy?: 'skip' | 'run_once';
  paused?: boolean;
  lastRun?: ScheduledRun;
  sourceChannelId?: string;
  sourceChannelType?: string;
  /** Set for Mercury Bot routines — the run routes to the bot, not the main agent. */
  botId?: string;
  /**
   * Plugin tools this task may run without asking when it fires (e.g.
   * "whatsapp__call_owner" for "call me in 10 minutes"). Approved by the owner
   * once, when the task was created; nothing else is pre-approved.
   */
  allowTools?: string[];
}

const SCHEDULES_FILE = 'schedules.yaml';

function getSchedulesPath(): string {
  return join(getMercuryHome(), SCHEDULES_FILE);
}

export function loadSchedules(): ScheduledTaskManifest[] {
  const path = getSchedulesPath();
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, 'utf-8');
    const data = parseYaml(raw) as { tasks?: ScheduledTaskManifest[] };
    return Array.isArray(data?.tasks) ? data.tasks : [];
  } catch (err) {
    logger.warn({ err }, 'Failed to load schedules.yaml');
    return [];
  }
}

export function saveSchedules(tasks: ScheduledTaskManifest[]): void {
  const path = getSchedulesPath();
  mkdirSync(getMercuryHome(), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, stringifyYaml({ tasks }), 'utf-8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
    // Directory fsync is unavailable on some platforms (notably Windows).
    try {
      fd = openSync(getMercuryHome(), 'r');
      fsyncSync(fd);
    } catch { /* the file itself has already been synced */ }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temp)) unlinkSync(temp);
  }
}

export function isValidScheduleTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
    return true;
  } catch { return false; }
}

const MAX_TIMER_MS = 2 ** 31 - 1;
const MAX_FINISHED_ONESHOTS = 100;

export class Scheduler {
  private tasks: Map<string, cron.ScheduledTask> = new Map();
  private delayedTasks: Map<string, NodeJS.Timeout> = new Map();
  private taskManifests: Map<string, ScheduledTaskManifest> = new Map();
  private heartbeatIntervalMinutes: number;
  private heartbeatHandler?: () => Promise<void>;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(
    config: MercuryConfig,
    private onScheduledTask?: (manifest: ScheduledTaskManifest, runId: string) => Promise<ScheduledDispatch>,
  ) {
    this.heartbeatIntervalMinutes = config.heartbeat.intervalMinutes;
  }

  setOnScheduledTask(handler: (manifest: ScheduledTaskManifest, runId: string) => Promise<ScheduledDispatch>): void {
    this.onScheduledTask = handler;
  }

  onHeartbeat(handler: () => Promise<void>): void {
    this.heartbeatHandler = handler;
  }

  startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    const ms = this.heartbeatIntervalMinutes * 60 * 1000;
    logger.info({ intervalMin: this.heartbeatIntervalMinutes }, 'Heartbeat started');

    this.heartbeatTimer = setInterval(async () => {
      try {
        await this.heartbeatHandler?.();
      } catch (err) {
        logger.error({ err }, 'Heartbeat error');
      }
    }, ms);
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      logger.info('Heartbeat stopped');
    }
  }

  addTask(task: ScheduledTask): void {
    this.tasks.get(task.id)?.stop();
    let running = false;
    const scheduled = cron.schedule(task.cron, async () => {
      if (running) return; // Cron ticks never build an overlapping backlog.
      running = true;
      try {
        await task.handler();
      } catch (err) {
        logger.error({ task: task.id, err }, 'Scheduled task error');
      } finally { running = false; }
    }, { timezone: task.timezone });
    this.tasks.set(task.id, scheduled);
  }

  private validate(manifest: ScheduledTaskManifest): void {
    if (manifest.timezone !== undefined && !isValidScheduleTimezone(manifest.timezone)) {
      throw new Error('Invalid schedule timezone');
    }
    if (manifest.missedRunPolicy !== undefined && !['skip', 'run_once'].includes(manifest.missedRunPolicy)) {
      throw new Error('Invalid missed-run policy');
    }
    if (manifest.cron && cron.validate(manifest.cron) && manifest.delaySeconds === undefined) return;
    if (!manifest.cron && Number.isFinite(manifest.delaySeconds) && manifest.delaySeconds! > 0
      && (!manifest.executeAt || Number.isFinite(Date.parse(manifest.executeAt)))) return;
    throw new Error('Manifest requires a valid cron or positive finite delaySeconds');
  }

  addPersistedTask(manifest: ScheduledTaskManifest): void {
    this.validate(manifest);
    // Registering a bot's declared routine again must not erase interrupted state.
    const previous = this.taskManifests.get(manifest.id);
    const next = { ...manifest, lastRun: manifest.lastRun ?? previous?.lastRun, paused: manifest.paused ?? previous?.paused };
    this.removeTask(manifest.id);
    this.taskManifests.set(manifest.id, next);
    if (next.paused) return;
    this.addTask({
      id: next.id, cron: next.cron!, description: next.description, timezone: next.timezone,
      handler: () => this.runTask(next.id),
    });
  }

  addDelayedTask(manifest: ScheduledTaskManifest): void {
    this.validate(manifest);
    const next = { ...manifest, executeAt: manifest.executeAt ?? new Date(Date.now() + manifest.delaySeconds! * 1000).toISOString() };
    this.removeTask(next.id);
    this.taskManifests.set(next.id, next);
    if (!next.paused && !next.lastRun) this.armDelayedTask(next);
  }

  private armDelayedTask(manifest: ScheduledTaskManifest): void {
    const remaining = Date.parse(manifest.executeAt!) - Date.now();
    const timer = setTimeout(() => {
      this.delayedTasks.delete(manifest.id);
      if (this.taskManifests.get(manifest.id) !== manifest) return;
      if (Date.parse(manifest.executeAt!) > Date.now()) {
        this.armDelayedTask(manifest); // Node timers longer than ~24 days otherwise fire immediately.
      } else {
        void this.runTask(manifest.id).catch((err) => logger.error({ err, task: manifest.id }, 'Could not persist scheduled run'));
      }
    }, Math.min(MAX_TIMER_MS, Math.max(0, remaining)));
    this.delayedTasks.set(manifest.id, timer);
  }

  private async runTask(id: string): Promise<void> {
    const manifest = this.taskManifests.get(id);
    if (!manifest || manifest.paused || manifest.lastRun?.status === 'running') return;
    const runId = randomUUID();
    manifest.lastRun = { id: runId, status: 'running', startedAt: new Date().toISOString() };
    // Fail closed: no handler runs unless the intent is durable first.
    this.persistSchedules();
    try {
      if (!this.onScheduledTask) throw new Error('Scheduled task handler unavailable');
      const outcome = await this.onScheduledTask(manifest, runId);
      if (outcome !== 'queued') this.finishRun(id, runId, outcome ?? 'completed');
    } catch (err) {
      this.finishRun(id, runId, 'failed', err instanceof Error ? err.message : String(err));
      logger.error({ err, task: id }, 'Scheduled task failed; review before resuming');
    }
  }

  /** A run identity prevents a late completion from changing an edited/deleted task. */
  finishRun(id: string, runId: string, status: Exclude<ScheduledRunStatus, 'running'>, error?: string): void {
    const manifest = this.taskManifests.get(id);
    if (!manifest || manifest.lastRun?.id !== runId || manifest.lastRun.status !== 'running') return;
    manifest.lastRun = { ...manifest.lastRun, status, finishedAt: new Date().toISOString(), ...(error ? { error: error.slice(0, 1000) } : {}) };
    if (status === 'failed' || status === 'interrupted') manifest.paused = true;
    this.persistSchedules();
  }

  removeTask(id: string): void {
    const task = this.tasks.get(id);
    if (task) {
      task.stop();
      this.tasks.delete(id);
    }
    const timer = this.delayedTasks.get(id);
    if (timer) {
      clearTimeout(timer);
      this.delayedTasks.delete(id);
    }
    this.taskManifests.delete(id);
  }

  getManifests(): ScheduledTaskManifest[] {
    return [...this.taskManifests.values()];
  }

  getManifest(id: string): ScheduledTaskManifest | null {
    return this.taskManifests.get(id) || null;
  }

  replaceManifest(manifest: ScheduledTaskManifest, resume = false): void {
    this.validate(manifest);
    if (this.getManifest(manifest.id)?.lastRun?.status === 'running') throw new Error('Cannot edit a running schedule');
    const next = { ...manifest };
    if (resume) {
      next.paused = false;
      next.lastRun = undefined;
      if (next.delaySeconds) next.executeAt = new Date(Date.now() + next.delaySeconds * 1000).toISOString();
    }
    this.removeTask(next.id);
    if (next.cron) this.addPersistedTask(next);
    else this.addDelayedTask(next);
  }

  restorePersistedTasks(): void {
    const persisted = loadSchedules();
    for (const stored of persisted) {
      const manifest = { ...stored };
      try {
        this.validate(manifest);
        if (manifest.lastRun?.status === 'running') {
          manifest.lastRun = { ...manifest.lastRun, status: 'interrupted', finishedAt: new Date().toISOString(), error: 'Mercury stopped before this run was confirmed. Check its effects before resuming.' };
          manifest.paused = true;
        }
        if (manifest.cron) {
          this.addPersistedTask(manifest);
        } else {
          // Old schedules without executeAt cannot safely be inferred as pending.
          const overdue = !manifest.executeAt || Date.parse(manifest.executeAt) <= Date.now();
          if (!manifest.lastRun && overdue && (manifest.missedRunPolicy ?? 'skip') === 'skip') {
            manifest.lastRun = { id: randomUUID(), status: 'skipped', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), error: 'Missed while Mercury was offline (policy: skip).' };
          }
          if (overdue && !manifest.lastRun) manifest.executeAt = new Date().toISOString();
          this.addDelayedTask(manifest);
        }
      } catch (err) {
        logger.warn({ err, id: manifest.id }, 'Skipping invalid task');
      }
    }
    if (persisted.length > 0) this.persistSchedules();
  }

  persistSchedules(): void {
    // Keep active work and all unresolved failures. Bound successful/skipped one-shot history.
    const finished = this.getManifests().filter((m) => !m.cron && m.lastRun && ['completed', 'skipped', 'dispatched'].includes(m.lastRun.status))
      .sort((a, b) => (b.lastRun!.finishedAt ?? '').localeCompare(a.lastRun!.finishedAt ?? ''));
    for (const manifest of finished.slice(MAX_FINISHED_ONESHOTS)) this.removeTask(manifest.id);
    saveSchedules(this.getManifests());
  }

  stopAll(): void {
    this.stopHeartbeat();
    for (const [, task] of this.tasks) {
      task.stop();
    }
    for (const [, timer] of this.delayedTasks) {
      clearTimeout(timer);
    }
    this.tasks.clear();
    this.delayedTasks.clear();
    this.taskManifests.clear();
  }
}
