import { tool } from 'ai';
import { z } from 'zod';
import { zodSchema } from 'ai';
import type { SubAgentSupervisor } from '../../core/supervisor.js';
import { logger } from '../../utils/logger.js';

export interface SubAgentToolOptions {
  /**
   * Id of the sub-agent this tool instance belongs to. Undefined means the
   * main agent, which owns the whole tree. A sub-agent's instance may only
   * act on its own descendants (#74).
   */
  callerId?: string;
}

export function createStopAgentTool(supervisor: SubAgentSupervisor, options: SubAgentToolOptions = {}) {
  const { callerId } = options;
  const scopeNote = callerId ? ' Only agents you delegated (and their descendants) can be stopped.' : '';
  return tool({
    description: `Stop a running or queued sub-agent, or stop all sub-agents. The agent will finish its current tool step before halting.${scopeNote}`,
    inputSchema: zodSchema(z.object({
      agentId: z.string().describe(callerId
        ? 'ID of the sub-agent to stop (e.g. "a1"), or "all" to stop every agent you delegated'
        : 'ID of the sub-agent to stop (e.g. "a1"), or "all" to stop every agent'),
    })),
    execute: async ({ agentId }) => {
      try {
        if (agentId.toLowerCase() === 'all') {
          const halted = await supervisor.haltAll(callerId);
          logger.info({ callerId, halted }, 'Sub-agents halted via stop_agent tool');
          if (callerId) {
            return halted.length === 0
              ? 'No agents delegated by you are active.'
              : `Halted ${halted.length} agent${halted.length === 1 ? '' : 's'} you delegated (${halted.join(', ')}). Any agent currently executing a tool step will finish that step before stopping.`;
          }
          return 'All sub-agents have been halted. Any agents currently executing a tool step will finish that step before stopping.';
        }

        if (callerId && !supervisor.isDescendant(agentId, callerId)) {
          logger.warn({ callerId, agentId }, 'stop_agent refused: target is not a descendant of the caller');
          return `Agent ${agentId} was not delegated by you, so you cannot stop it. Use list_agents to see the agents you delegated.`;
        }

        const halted = await supervisor.halt(agentId, callerId);
        if (!halted) {
          return `No active agent found with ID "${agentId}". Use the list_agents tool to see active agents.`;
        }

        logger.info({ agentId, callerId }, 'Sub-agent halted via stop_agent tool');
        return `Agent ${agentId} halt signal sent. It will finish its current tool step and then stop. File locks will be released automatically.`;
      } catch (err: any) {
        logger.error({ err }, 'Failed to stop agent');
        return `Failed to stop agent: ${err.message}`;
      }
    },
  });
}
