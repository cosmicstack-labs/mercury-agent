import { tool } from 'ai';
import { z } from 'zod';
import { zodSchema } from 'ai';
import type { SubAgentSupervisor } from '../../core/supervisor.js';
import { logger } from '../../utils/logger.js';

export function createDelegateTaskTool(supervisor: SubAgentSupervisor) {
  return tool({
    description: 'Delegate a task to a sub-agent worker. Use this for complex, multi-step tasks that would take a long time and should not block the main conversation. The sub-agent will work independently and report back when done. You can continue handling other messages while sub-agents work.',
    inputSchema: zodSchema(z.object({
      task: z.string().describe('Clear description of the task for the sub-agent to complete'),
      workingDirectory: z.string().optional().describe('Working directory for the sub-agent (defaults to current directory)'),
      priority: z.enum(['low', 'normal', 'high']).optional().describe('Task priority (default: normal)'),
      allowedTools: z.array(z.string()).optional().describe('Optional list of tool names this sub-agent is allowed to use. If not specified, all tools are available.'),
    })),
    execute: async ({ task, workingDirectory, priority, allowedTools }) => {
      try {
        logger.info({ task: task.slice(0, 50) }, 'Delegating task to sub-agent');

        const agentId = await supervisor.spawn({
          task,
          workingDirectory,
          priority: priority || 'normal',
          allowedTools,
          sourceChannelId: undefined,
          sourceChannelType: undefined,
        });

        const resourceInfo = supervisor.getResourceUsage();

        let response = `Task delegated to sub-agent **${agentId}**.\n`;
        response += `Task: "${task.slice(0, 80)}${task.length > 80 ? '...' : ''}"\n`;
        response += `Active agents: ${resourceInfo.activeAgents}/${resourceInfo.maxConcurrentAgents}\n`;
        response += `\nUse /agents to check status, /agents stop ${agentId} to halt.`;

        return response;
      } catch (err: any) {
        logger.error({ err }, 'Failed to delegate task');
        return `Failed to delegate task: ${err.message}`;
      }
    },
  });
}