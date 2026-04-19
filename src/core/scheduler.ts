import cron from 'node-cron';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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
}

export interface ScheduledTaskManifest {
  id: string;
  cron?: string;
  description: string;
  skillName?: string;
  prompt?: string;
  delaySeconds?: number;
  executeAt?: string;
  createdAt: string;
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
    return data.tasks || [];
  } catch (err) {
    logger.warn({ err }, 'Failed to load schedules.yaml');
    return [];
  }
}

export function saveSchedules(tasks: ScheduledTaskManifest[]): void {
  const path = getSchedulesPath();
  const dir = getMercuryHome();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, stringifyYaml({ tasks }), 'utf-8');
}

export class Scheduler {
  private tasks: Map<string, cron.ScheduledTask> = new Map();
  private delayedTasks: Map<string, NodeJS.Timeout> = new Map();
  private taskManifests: Map<string, ScheduledTaskManifest> = new Map();
  private heartbeatIntervalMinutes: number;
  private heartbeatHandler?: () => Promise<void>;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(
    config: MercuryConfig,
    private onScheduledTask?: (manifest: ScheduledTaskManifest) => Promise<void>,
  ) {
    this.heartbeatIntervalMinutes = config.heartbeat.intervalMinutes;
  }

  setOnScheduledTask(handler: (manifest: ScheduledTaskManifest) => Promise<void>): void {
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
    if (this.tasks.has(task.id)) {
      this.removeTask(task.id);
    }
    const scheduled = cron.schedule(task.cron, async () => {
      try {
        await task.handler();
      } catch (err) {
        logger.error({ task: task.id, err }, 'Scheduled task error');
      }
    });
    this.tasks.set(task.id, scheduled);
    logger.info({ id: task.id, cron: task.cron, desc: task.description }, 'Task scheduled');
  }

  addPersistedTask(manifest: ScheduledTaskManifest): void {
    this.taskManifests.set(manifest.id, manifest);
    this.addTask({
      id: manifest.id,
      cron: manifest.cron!,
      description: manifest.description,
      handler: async () => {
        logger.info({ task: manifest.id }, 'Scheduled task firing');
        if (this.onScheduledTask) {
          await this.onScheduledTask(manifest);
        }
      },
    });
  }

  addDelayedTask(manifest: ScheduledTaskManifest): void {
    this.taskManifests.set(manifest.id, manifest);
    const delayMs = (manifest.delaySeconds || 60) * 1000;

    const timer = setTimeout(async () => {
      try {
        logger.info({ task: manifest.id }, 'Delayed task firing');
        if (this.onScheduledTask) {
          await this.onScheduledTask(manifest);
        }
      } catch (err) {
        logger.error({ task: manifest.id, err }, 'Delayed task error');
      } finally {
        this.delayedTasks.delete(manifest.id);
        this.taskManifests.delete(manifest.id);
        this.persistSchedules();
      }
    }, delayMs);

    this.delayedTasks.set(manifest.id, timer);
    logger.info({ id: manifest.id, delaySeconds: manifest.delaySeconds }, 'Delayed task scheduled');
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

  restorePersistedTasks(): void {
    const persisted = loadSchedules();
    for (const manifest of persisted) {
      if (manifest.delaySeconds) {
        const executeAt = manifest.executeAt ? new Date(manifest.executeAt) : null;
        const now = Date.now();
        if (executeAt && executeAt.getTime() > now) {
          const remainingMs = executeAt.getTime() - now;
          manifest.delaySeconds = Math.ceil(remainingMs / 1000);
          this.addDelayedTask(manifest);
        } else {
          logger.info({ id: manifest.id }, 'Delayed task already expired, skipping');
        }
      } else if (manifest.cron && cron.validate(manifest.cron)) {
        this.addPersistedTask(manifest);
      } else {
        logger.warn({ id: manifest.id, cron: manifest.cron }, 'Skipping invalid task');
      }
    }
    if (persisted.length > 0) {
      logger.info({ count: persisted.length }, 'Restored persisted scheduled tasks');
    }
  }

  persistSchedules(): void {
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