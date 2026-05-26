import { tool } from 'ai';
import { z } from 'zod';
import { zodSchema } from 'ai';
import type { SubAgentSupervisor } from '../../core/supervisor.js';
import type { CapabilityRegistry } from '../registry.js';
import { logger } from '../../utils/logger.js';

export function createDelegateTaskTool(supervisor: SubAgentSupervisor, capabilities: CapabilityRegistry) {
  return tool({
    description: 'Delegate a task to a sub-agent worker. Use this for complex, multi-step tasks that can run in parallel. The sub-agent works independently — you will be notified when it completes. You can continue handling other messages while sub-agents work.',
    inputSchema: zodSchema(z.object({
      task: z.string().describe('Clear description of the task for the sub-agent to complete'),
      workingDirectory: z.string().optional().describe('Working directory for the sub-agent (defaults to current directory)'),
      priority: z.enum(['low', 'normal', 'high']).optional().describe('Task priority (default: normal)'),
      allowedTools: z.array(z.string()).optional().describe('Optional list of tool names this sub-agent is allowed to use. If not specified, all tools are available.'),
    })),
    execute: async ({ task, workingDirectory, priority, allowedTools }) => {
      try {
        logger.info({ task: task.slice(0, 50) }, 'Delegating task to sub-agent');

        const { channelId, channelType } = capabilities.getChannelContext();

        const agentId = await supervisor.spawn({
          task,
          workingDirectory,
          priority: priority || 'normal',
          allowedTools,
          sourceChannelId: channelId,
          sourceChannelType: channelType,
        });

        const resourceInfo = supervisor.getResourceUsage();

        let response = `🤖 Multi-agent mode activated.\n\n`;
        response += `**Agent ${agentId}** is now working on: "${task.slice(0, 80)}${task.length > 80 ? '...' : ''}"\n`;
        response += `Active agents: ${resourceInfo.activeAgents}/${resourceInfo.maxConcurrentAgents}\n\n`;
        response += `You can continue chatting while the agent works. I'll notify you when it's done.\n`;
        response += `Use /agents to check status.`;

        return response;
      } catch (err: any) {
        logger.error({ err }, 'Failed to delegate task');
        return `Failed to delegate task: ${err.message}`;
      }
    },
  });
}