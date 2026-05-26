import { cpus, totalmem, freemem } from 'node:os';
import { logger } from '../utils/logger.js';
import type { ResourceUsage } from '../types/agent.js';

const MB = 1024 * 1024;
const RAM_PER_AGENT_MB = 2048;
const MIN_FREE_RAM_MB = 1024;

export class ResourceManager {
  private maxConcurrent: number;
  private userOverride: number | null = null;

  constructor() {
    this.maxConcurrent = this.calculateMaxConcurrent();
    logger.info(
      { cpuCores: cpus().length, maxConcurrent: this.maxConcurrent, totalRAM: `${Math.round(totalmem() / MB)}MB` },
      'ResourceManager initialized',
    );
  }

  private calculateMaxConcurrent(): number {
    const cpuCount = cpus().length;
    const availableMB = freemem() / MB;
    const totalMB = totalmem() / MB;

    const cpuBasedMax = Math.max(1, cpuCount - 1);
    const ramBasedMax = Math.max(1, Math.floor((availableMB - MIN_FREE_RAM_MB) / RAM_PER_AGENT_MB));
    const systemMax = Math.max(1, Math.floor((totalMB / 2) / RAM_PER_AGENT_MB));

    let max = Math.min(cpuBasedMax, ramBasedMax, systemMax);

    if (max < 1) max = 1;
    if (availableMB < MIN_FREE_RAM_MB * 2) max = 1;

    return max;
  }

  getMaxConcurrent(): number {
    return this.userOverride ?? this.maxConcurrent;
  }

  setMaxConcurrent(n: number): void {
    this.userOverride = Math.max(1, n);
    logger.info({ max: this.userOverride }, 'User override set for max concurrent sub-agents');
  }

  clearOverride(): void {
    this.userOverride = null;
    logger.info('User override cleared, using auto-detected max concurrent');
  }

  canSpawn(): boolean {
    this.maxConcurrent = this.calculateMaxConcurrent();
    const effective = this.userOverride ?? this.maxConcurrent;
    return effective > 0;
  }

  getResourceUsage(activeAgents: number, queuedAgents: number, tokenBudgetRemaining: number): ResourceUsage {
    this.maxConcurrent = this.calculateMaxConcurrent();
    return {
      cpuCores: cpus().length,
      maxConcurrentAgents: this.userOverride ?? this.maxConcurrent,
      activeAgents,
      queuedAgents,
      systemMemoryMB: Math.round(totalmem() / MB),
      availableMemoryMB: Math.round(freemem() / MB),
      tokenBudgetRemaining,
    };
  }

  refresh(): void {
    this.maxConcurrent = this.calculateMaxConcurrent();
    logger.debug({ maxConcurrent: this.maxConcurrent }, 'Resource limits refreshed');
  }
}