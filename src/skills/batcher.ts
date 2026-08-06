import type { MatchedSkill } from './types.js';
import type { SubAgentSupervisor } from '../core/supervisor.js';
import type { BackgroundTaskManager } from '../core/background-tasks.js';
import { logger } from '../utils/logger.js';

export interface BatchTask {
  batchId: string;
  category: string;
  categoryLabel: string;
  skills: MatchedSkill[];
  agentIds: string[];
  startedAt: number;
  completedAt?: number;
  results?: BatchResult[];
  status: 'pending' | 'running' | 'completed' | 'partial' | 'failed';
}

export interface BatchResult {
  skillName: string;
  agentId: string;
  status: 'completed' | 'failed' | 'halted';
  output: string;
  error?: string;
  duration: number;
}

export interface BatchExecutionPlan {
  batches: Array<{
    category: string;
    categoryLabel: string;
    skills: MatchedSkill[];
    taskDescription: string;
  }>;
  strategy: 'parallel' | 'sequential' | 'hybrid';
}

/**
 * SkillBatcher — distributes matched skills across sub-agents for parallel execution.
 *
 * Strategies:
 * - parallel: Run all category batches simultaneously
 * - sequential: Run batches one after another (within each batch, skills run in parallel)
 * - hybrid: Run independent categories in parallel, dependent ones sequentially
 */
export class SkillBatcher {
  private activeBatches: Map<string, BatchTask> = new Map();
  private supervisor: SubAgentSupervisor;
  private backgroundTasks: BackgroundTaskManager;

  constructor(supervisor: SubAgentSupervisor, backgroundTasks: BackgroundTaskManager) {
    this.supervisor = supervisor;
    this.backgroundTasks = backgroundTasks;
  }

  /**
   * Convert matched skills into an execution plan.
   */
  planExecution(matchedBatches: Array<{ category: string; categoryLabel: string; skills: MatchedSkill[] }>): BatchExecutionPlan {
    if (matchedBatches.length === 0) {
      return { batches: [], strategy: 'parallel' };
    }

    // Determine strategy based on number of batches and skills
    let strategy: 'parallel' | 'sequential' | 'hybrid' = 'parallel';

    if (matchedBatches.length > 3) {
      strategy = 'hybrid'; // mix for many categories
    }

    if (matchedBatches.length === 1 && matchedBatches[0].skills.length > 3) {
      strategy = 'sequential'; // many skills in one category — sequential per batch
    }

    const batches = matchedBatches.map((batch) => {
      // Build the task description for the sub-agent that will run these skills
      const skillList = batch.skills.map(s =>
        `- ${s.name}: ${s.description}${s.matchedIntent ? ` (matched: "${s.matchedIntent}")` : ''}`
      ).join('\n');

      const taskDescription = `Execute the following ${batch.category} skills in parallel:\n\n${skillList}\n\nFor each skill:\n1. Invoke it using the \`use_skill\` tool\n2. Follow its instructions carefully\n3. Return the results from all skills executed\n\nIf a skill fails, note the error and continue with remaining skills.`;

      return {
        category: batch.category,
        categoryLabel: batch.categoryLabel,
        skills: batch.skills,
        taskDescription,
      };
    });

    return { batches, strategy };
  }

  /**
   * Execute the matched skill batches across sub-agents.
   * Returns a promise that resolves when all batches complete.
   */
  async execute(
    plan: BatchExecutionPlan,
    userMessage: string,
    channelId?: string,
    channelType?: string,
  ): Promise<BatchTask[]> {
    const completed: BatchTask[] = [];

    if (plan.strategy === 'parallel') {
      // Launch all batches simultaneously
      const promises = plan.batches.map(batch => this.executeBatch(batch, channelId, channelType));
      const results = await Promise.allSettled(promises);

      for (const result of results) {
        if (result.status === 'fulfilled') {
          completed.push(result.value);
        }
      }
    } else if (plan.strategy === 'sequential') {
      // Execute batches one at a time
      for (const batch of plan.batches) {
        const result = await this.executeBatch(batch, channelId, channelType);
        completed.push(result);
      }
    } else {
      // Hybrid: group independent categories, run dependent/skills-heavy one at a time
      const independentBatches: typeof plan.batches = [];
      const dependentBatches: typeof plan.batches = [];

      for (const batch of plan.batches) {
        if (batch.skills.length <= 2) {
          independentBatches.push(batch);
        } else {
          dependentBatches.push(batch);
        }
      }

      // Launch all independent batches in parallel
      const promises = independentBatches.map(batch => this.executeBatch(batch, channelId, channelType));
      const results = await Promise.allSettled(promises);

      for (const result of results) {
        if (result.status === 'fulfilled') {
          completed.push(result.value);
        }
      }

      // Then run dependent batches sequentially
      for (const batch of dependentBatches) {
        const result = await this.executeBatch(batch, channelId, channelType);
        completed.push(result);
      }
    }

    return completed;
  }

  /**
   * Execute a single batch of skills via a sub-agent.
   */
  private async executeBatch(
    batch: { category: string; categoryLabel: string; skills: MatchedSkill[]; taskDescription: string },
    channelId?: string,
    channelType?: string,
  ): Promise<BatchTask> {
    const batchId = `batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

    const task: BatchTask = {
      batchId,
      category: batch.category,
      categoryLabel: batch.categoryLabel,
      skills: batch.skills,
      agentIds: [],
      startedAt: Date.now(),
      status: 'running',
    };

    this.activeBatches.set(batchId, task);

    try {
      // Spawn one sub-agent per skill in the batch
      const spawnPromises = batch.skills.map(async (skill) => {
        const skillTask = `Execute the skill "${skill.name}" to handle the user's request. Follow these steps:

1. Use the \`use_skill\` tool to invoke "${skill.name}"
2. Follow the skill instructions carefully
3. Return a clear summary of what was done and the result

If the skill fails, return the error clearly so it can be reported.`;

        const agentId = await this.supervisor.spawn({
          task: skillTask,
          sourceChannelId: channelId,
          sourceChannelType: channelType as any,
          priority: 'normal',
        });

        task.agentIds.push(agentId);
        return agentId;
      });

      const agentIds = await Promise.all(spawnPromises);
      task.agentIds = agentIds;

      logger.info({ batchId, category: batch.category, skillCount: batch.skills.length, agentIds }, 'Skill batch launched');

      // Wait for all agents to complete
      const results = await this.waitForAgents(agentIds);
      task.results = results;

      const allCompleted = results.every(r => r.status === 'completed');
      const anyCompleted = results.some(r => r.status === 'completed');

      task.status = allCompleted ? 'completed' : anyCompleted ? 'partial' : 'failed';
      task.completedAt = Date.now();

      logger.info({ batchId, status: task.status, completed: results.filter(r => r.status === 'completed').length, failed: results.filter(r => r.status !== 'completed').length }, 'Skill batch completed');

    } catch (err) {
      logger.error({ batchId, err }, 'Skill batch execution failed');
      task.status = 'failed';
      task.completedAt = Date.now();
    }

    this.activeBatches.delete(batchId);
    return task;
  }

  /**
   * Wait for a set of sub-agents to complete by polling.
   */
  private async waitForAgents(
    agentIds: string[],
    pollMs: number = 1000,
    timeoutMs: number = 300000, // 5 min timeout
  ): Promise<BatchResult[]> {
    const results: BatchResult[] = [];
    const startTime = Date.now();
    const remaining = new Set(agentIds);

    while (remaining.size > 0) {
      if (Date.now() - startTime > timeoutMs) {
        logger.warn({ remaining: [...remaining] }, 'Batch wait timeout — marking remaining as failed');
        for (const id of remaining) {
          results.push({
            skillName: id,
            agentId: id,
            status: 'failed',
            output: '',
            error: 'Timed out waiting for agent',
            duration: Date.now() - startTime,
          });
        }
        break;
      }

      await new Promise(resolve => setTimeout(resolve, pollMs));

      const activeAgents = this.supervisor.getActiveAgents();

      for (const id of [...remaining]) {
        const agent = activeAgents.find(a => a.id === id);
        if (!agent) {
          // Agent completed or was halted — check task board
          const taskBoard = this.supervisor.getTaskBoard();
          const entry = taskBoard.get(id);
          if (entry) {
            const status = entry.status === 'completed' ? 'completed'
              : entry.status === 'halted' ? 'halted'
              : 'failed';

            const result: BatchResult = {
              skillName: id,
              agentId: id,
              status,
              output: entry.result || entry.progress || '',
              error: entry.error,
              duration: entry.completedAt ? entry.completedAt - entry.startedAt : 0,
            };

            results.push(result);
          } else {
            results.push({
              skillName: id,
              agentId: id,
              status: 'failed',
              output: '',
              error: 'Agent vanished from task board',
              duration: Date.now() - startTime,
            });
          }

          remaining.delete(id);
        }
      }
    }

    return results;
  }

  /**
   * Summarize batch results into a human-readable format.
   */
  summarizeResults(batches: BatchTask[]): string {
    if (batches.length === 0) return '';

    const lines: string[] = [];

    for (const batch of batches) {
      const icon = batch.status === 'completed' ? '✅' : batch.status === 'partial' ? '⚠️' : '❌';
      const duration = batch.completedAt ? `${((batch.completedAt - batch.startedAt) / 1000).toFixed(1)}s` : 'unknown';
      lines.push(`\n${icon} **${batch.categoryLabel}** (${duration})`);

      if (batch.results) {
        for (const result of batch.results) {
          const skillInfo = batch.skills.find(s => s.name === result.skillName);
          const skillLabel = skillInfo ? skillInfo.name : result.skillName;
          const statusIcon = result.status === 'completed' ? '✅' : result.status === 'halted' ? '⛔' : '❌';
          const durationStr = result.duration > 0 ? ` (${(result.duration / 1000).toFixed(1)}s)` : '';
          lines.push(`  ${statusIcon} **${skillLabel}**${durationStr}`);

          if (result.output) {
            const preview = result.output.length > 200 ? result.output.slice(0, 200) + '...' : result.output;
            lines.push(`    ${preview}`);
          }

          if (result.error) {
            lines.push(`    Error: ${result.error.slice(0, 200)}`);
          }
        }
      }
    }

    return lines.join('\n');
  }

  /**
   * Get all active batches.
   */
  getActiveBatches(): BatchTask[] {
    return [...this.activeBatches.values()];
  }

  /**
   * Cancel all active batches.
   */
  async cancelAll(): Promise<void> {
    for (const [batchId, batch] of this.activeBatches.entries()) {
      for (const agentId of batch.agentIds) {
        await this.supervisor.halt(agentId);
      }
      this.activeBatches.delete(batchId);
    }
    logger.info('All skill batches cancelled');
  }
}
