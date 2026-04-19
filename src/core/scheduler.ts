import cron from 'node-cron';
import type { MercuryConfig } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import type { EpisodicMemory } from '../memory/store.js';

export interface ScheduledTask {
  id: string;
  cron: string;
  handler: () => Promise<void>;
  description: string;
}

export class Scheduler {
  private tasks: Map<string, cron.ScheduledTask> = new Map();
  private heartbeatIntervalMinutes: number;
  private heartbeatHandler?: () => Promise<void>;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(config: MercuryConfig) {
    this.heartbeatIntervalMinutes = config.heartbeat.intervalMinutes;
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

  removeTask(id: string): void {
    const task = this.tasks.get(id);
    if (task) {
      task.stop();
      this.tasks.delete(id);
    }
  }

  stopAll(): void {
    this.stopHeartbeat();
    for (const [, task] of this.tasks) {
      task.stop();
    }
    this.tasks.clear();
  }
}