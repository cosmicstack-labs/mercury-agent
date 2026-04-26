import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import cron from 'node-cron';
import type { Scheduler, ScheduledTaskManifest } from '../../core/scheduler.js';

export function createScheduleTaskTool(scheduler: Scheduler, getContext: () => { channelId: string; channelType: string }) {
  return tool({
    description: 'Schedule a task. Use "cron" for recurring tasks (e.g. "0 9 * * *" for daily at 9am) or "delay_seconds" for one-shot delayed tasks (e.g. 15 for "remind me in 15 seconds"). Provide exactly one of cron or delay_seconds.',
    inputSchema: zodSchema(z.object({
      cron: z.string().optional().describe('Cron expression for recurring tasks (e.g. "0 9 * * *" for daily at 9am)'),
      delay_seconds: z.number().optional().describe('Delay in seconds for one-shot tasks (e.g. 15 for "remind me in 15 seconds")'),
      description: z.string().describe('Human-readable description of what this task does'),
      prompt: z.string().optional().describe('Prompt to send to the agent when the task fires'),
      skill_name: z.string().optional().describe('Name of a skill to invoke when the task fires'),
    })),
    execute: async ({ cron: cronExpr, delay_seconds, description, prompt, skill_name }) => {
      if (!cronExpr && !delay_seconds) {
        return 'Either cron or delay_seconds must be provided.';
      }
      if (cronExpr && delay_seconds) {
        return 'Provide either cron or delay_seconds, not both.';
      }

      if (!prompt && !skill_name) {
        return 'Either prompt or skill_name must be provided so the task has something to do.';
      }

      const id = `task-${Date.now().toString(36)}`;
      const ctx = getContext();

      if (delay_seconds) {
        const manifest: ScheduledTaskManifest = {
          id,
          description,
          prompt,
          skillName: skill_name,
          delaySeconds: delay_seconds,
          executeAt: new Date(Date.now() + delay_seconds * 1000).toISOString(),
          createdAt: new Date().toISOString(),
          sourceChannelId: ctx.channelId,
          sourceChannelType: ctx.channelType,
        };

        scheduler.addDelayedTask(manifest);
        scheduler.persistSchedules();

        const triggerType = skill_name ? `skill: ${skill_name}` : `prompt: "${prompt!.slice(0, 60)}"`;
        return `Reminder "${id}" set. Will trigger in ${delay_seconds} second${delay_seconds !== 1 ? 's' : ''}. ${triggerType}. Description: ${description}`;
      }

      if (!cron.validate(cronExpr!)) {
        return `Invalid cron expression: "${cronExpr}". Use standard 5-field cron format (min hour day month weekday).`;
      }

      const manifest: ScheduledTaskManifest = {
        id,
        cron: cronExpr,
        description,
        prompt,
        skillName: skill_name,
        createdAt: new Date().toISOString(),
        sourceChannelId: ctx.channelId,
        sourceChannelType: ctx.channelType,
      };

      scheduler.addPersistedTask(manifest);
      scheduler.persistSchedules();

      const triggerType = skill_name ? `skill: ${skill_name}` : `prompt: "${prompt!.slice(0, 60)}"`;
      return `Task "${id}" scheduled. Cron: ${cronExpr}. Will execute ${triggerType}. Description: ${description}`;
    },
  });
}