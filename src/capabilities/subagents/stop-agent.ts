import { tool } from 'ai';
import { z } from 'zod';
import { zodSchema } from 'ai';
import type { SubAgentSupervisor } from '../../core/supervisor.js';
import { logger } from '../../utils/logger.js';

export function createStopAgentTool(supervisor: SubAgentSupervisor) {
  return tool({
    description: 'Stop a running or queued sub-agent, or stop all sub-agents. The agent will finish its current tool step before halting.',
    inputSchema: zodSchema(z.object({
      agentId: z.string().describe('ID of the sub-agent to stop (e.g. "a1"), or "all" to stop every agent'),
    })),
    execute: async ({ agentId }) => {
      try {
        if (agentId.toLowerCase() === 'all') {
          await supervisor.haltAll();
          logger.info('All sub-agents halted via stop_agent tool');
          return 'All sub-agents have been halted. Any agents currently executing a tool step will finish that step before stopping.';
        }

        const halted = await supervisor.halt(agentId);
        if (!halted) {
          return `No active agent found with ID "${agentId}". Use the list_agents tool to see active agents.`;
        }

        logger.info({ agentId }, 'Sub-agent halted via stop_agent tool');
        return `Agent ${agentId} halt signal sent. It will finish its current tool step and then stop. File locks will be released automatically.`;
      } catch (err: any) {
        logger.error({ err }, 'Failed to stop agent');
        return `Failed to stop agent: ${err.message}`;
      }
    },
  });
}