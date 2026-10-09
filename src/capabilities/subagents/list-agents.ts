import { tool } from 'ai';
import { z } from 'zod';
import { zodSchema } from 'ai';
import type { SubAgentSupervisor } from '../../core/supervisor.js';
import type { SubAgentToolOptions } from './stop-agent.js';

export function createListAgentsTool(supervisor: SubAgentSupervisor, options: SubAgentToolOptions = {}) {
  const { callerId } = options;
  return tool({
    description: callerId
      ? 'List the sub-agents you delegated (and their descendants) with their status, task, and progress.'
      : 'List all active and queued sub-agents with their status, task, and progress. Use this to check what sub-agents are currently working on.',
    inputSchema: zodSchema(z.object({})),
    execute: async () => {
      // A sub-agent only sees its own descendants; the main agent sees all.
      const agents = supervisor.getActiveAgents(callerId);
      const resourceInfo = supervisor.getResourceUsage();

      if (agents.length === 0) {
        return callerId
          ? `No agents delegated by you are active.\nMax concurrent: ${resourceInfo.maxConcurrentAgents} (auto) | CPU: ${resourceInfo.cpuCores} cores`
          : `No active sub-agents.\nMax concurrent: ${resourceInfo.maxConcurrentAgents} (auto) | CPU: ${resourceInfo.cpuCores} cores`;
      }

      const statusIcons: Record<string, string> = {
        pending: '\u{1f535}',
        running: '\u{1f7e2}',
        paused: '\u{1f7e1}',
        completed: '✅',
        failed: '❌',
        halted: '⛔',
      };

      const lines = [
        `**Sub-Agents** (${agents.length})`,
        '',
      ];

      for (const agent of agents) {
        const icon = statusIcons[agent.status] || '❓';
        const taskPreview = agent.task.length > 40 ? agent.task.slice(0, 40) + '...' : agent.task;
        lines.push(`${icon} **${agent.id}**  ${taskPreview}`);
        if (agent.progress) {
          lines.push(`   ${agent.progress}`);
        }
      }

      lines.push('');
      lines.push(`Max concurrent: ${resourceInfo.maxConcurrentAgents} (auto) | CPU: ${resourceInfo.cpuCores} cores`);
      lines.push(`Active: ${resourceInfo.activeAgents} | Queued: ${resourceInfo.queuedAgents}`);

      return lines.join('\n');
    },
  });
}
