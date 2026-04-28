import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import type { Scheduler } from '../../core/scheduler.js';

export function createCancelTaskTool(scheduler: Scheduler) {
  return tool({
    description: 'Cancel and remove a scheduled task by its ID.',
    inputSchema: zodSchema(z.object({
      id: z.string().describe('ID of the scheduled task to cancel'),
    })),
    execute: async ({ id }) => {
      const manifests = scheduler.getManifests();
      const exists = manifests.some(m => m.id === id);
      if (!exists) {
        return `Task "${id}" not found. Use list_scheduled_tasks to see active tasks.`;
      }

      scheduler.removeTask(id);
      scheduler.persistSchedules();

      return `Task "${id}" cancelled and removed.`;
    },
  });
}