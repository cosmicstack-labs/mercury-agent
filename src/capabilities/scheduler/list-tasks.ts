import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import type { Scheduler, ScheduledTaskManifest } from '../../core/scheduler.js';

export function createListTasksTool(scheduler: Scheduler) {
  return tool({
    description: 'List all scheduled tasks with their cron expressions and descriptions.',
    inputSchema: zodSchema(z.object({})),
    execute: async () => {
      const manifests = scheduler.getManifests();
      if (manifests.length === 0) {
        return 'No scheduled tasks. Use schedule_task to create one.';
      }
      return manifests.map((m: ScheduledTaskManifest) => {
        const trigger = m.skillName ? `skill: ${m.skillName}` : m.prompt ? `prompt: "${m.prompt.slice(0, 40)}"` : 'no action';
        return `${m.id} | ${m.cron} | ${m.description} | ${trigger}`;
      }).join('\n');
    },
  });
}