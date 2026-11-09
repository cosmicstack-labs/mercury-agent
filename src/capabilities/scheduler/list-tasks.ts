import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import type { Scheduler, ScheduledTaskManifest } from '../../core/scheduler.js';

export function createListTasksTool(scheduler: Scheduler) {
  return tool({
    description: 'List scheduled tasks, run outcomes, failures, timezone and missed-run policy. Failed or interrupted tasks remain paused until explicitly rescheduled.',
    inputSchema: zodSchema(z.object({})),
    execute: async () => {
      const manifests = scheduler.getManifests();
      if (manifests.length === 0) {
        return 'No scheduled tasks. Use schedule_task to create one.';
      }
      return manifests.map((m: ScheduledTaskManifest) => {
        const trigger = m.skillName ? `skill: ${m.skillName}` : m.prompt ? `prompt: "${m.prompt.slice(0, 40)}"` : 'no action';
        const timing = m.cron ? `${m.cron} (${m.timezone ?? 'host timezone'})` : `${m.executeAt ?? 'unknown time'} (missed: ${m.missedRunPolicy ?? 'skip'})`;
        const state = m.lastRun ? `${m.lastRun.status}${m.paused ? ', paused' : ''}${m.lastRun.error ? `: ${m.lastRun.error}` : ''}` : 'pending';
        return `${m.id} | ${timing} | ${state} | ${m.description} | ${trigger}`;
      }).join('\n');
    },
  });
}