import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getMercuryHome } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import type { TaskBoardEntry, SubAgentStatus } from '../types/agent.js';

const TASK_BOARD_FILE = 'task-board.json';

export class TaskBoard {
  private entries: Map<string, TaskBoardEntry> = new Map();

  load(): void {
    const filePath = this.getFilePath();
    if (existsSync(filePath)) {
      try {
        const data = readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(data);
        for (const entry of parsed) {
          this.entries.set(entry.agentId, entry);
        }
        logger.info({ count: this.entries.size }, 'Task board loaded');
      } catch (err) {
        logger.warn({ err }, 'Failed to load task board, starting fresh');
        this.entries.clear();
      }
    }
  }

  save(): void {
    const filePath = this.getFilePath();
    const dir = join(getMercuryHome(), 'memory');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(filePath, JSON.stringify([...this.entries.values()], null, 2), 'utf-8');
  }

  create(entry: TaskBoardEntry): void {
    this.entries.set(entry.agentId, entry);
    this.save();
    logger.info({ agentId: entry.agentId, task: entry.task.slice(0, 50) }, 'Task board entry created');
  }

  update(agentId: string, partial: Partial<TaskBoardEntry>): void {
    const existing = this.entries.get(agentId);
    if (!existing) {
      logger.warn({ agentId }, 'Task board entry not found for update');
      return;
    }
    this.entries.set(agentId, { ...existing, ...partial });
    this.save();
  }

  get(agentId: string): TaskBoardEntry | undefined {
    return this.entries.get(agentId);
  }

  getAll(): TaskBoardEntry[] {
    return [...this.entries.values()];
  }

  getByStatus(status: SubAgentStatus): TaskBoardEntry[] {
    return [...this.entries.values()].filter(e => e.status === status);
  }

  remove(agentId: string): void {
    this.entries.delete(agentId);
    this.save();
    logger.info({ agentId }, 'Task board entry removed');
  }

  clear(): void {
    this.entries.clear();
    this.save();
    logger.info('Task board cleared');
  }

  getActiveCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.status === 'running' || entry.status === 'pending' || entry.status === 'paused') {
        count++;
      }
    }
    return count;
  }

  getRunningCount(): number {
    return this.getByStatus('running').length;
  }

  nextId(): string {
    const existing = [...this.entries.keys()].filter(k => k.startsWith('a'));
    let max = 0;
    for (const id of existing) {
      const num = parseInt(id.slice(1), 10);
      if (!isNaN(num) && num > max) max = num;
    }
    return `a${max + 1}`;
  }

  private getFilePath(): string {
    return join(getMercuryHome(), 'memory', TASK_BOARD_FILE);
  }
}