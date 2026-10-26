import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import cron from 'node-cron';
import { isPluginToolName } from '../../plugins/tool-bridge.js';
import type { Scheduler, ScheduledTaskManifest } from '../../core/scheduler.js';
import type { PermissionManager } from '../permissions.js';

export function createScheduleTaskTool(scheduler: Scheduler, permissions: PermissionManager, getContext: () => { channelId: string; channelType: string }) {
  return tool({
    description: 'Schedule a task. Use "cron" for recurring tasks (e.g. "0 9 * * *" for daily at 9am) or "delay_seconds" for one-shot delayed tasks (e.g. 15 for "remind me in 15 seconds"). Provide exactly one of cron or delay_seconds.',
    inputSchema: zodSchema(z.object({
      cron: z.string().optional().describe('Cron expression for recurring tasks (e.g. "0 9 * * *" for daily at 9am)'),
      delay_seconds: z.number().optional().describe('Delay in seconds for one-shot tasks (e.g. 15 for "remind me in 15 seconds")'),
      description: z.string().describe('Human-readable description of what this task does'),
      prompt: z.string().optional().describe('Prompt to send to the agent when the task fires'),
      skill_name: z.string().optional().describe('Name of a skill to invoke when the task fires'),
      allow_tools: z.array(z.string()).max(10).optional().describe(
        'Plugin tools the task needs when it fires, approved now so it can run unattended, e.g. ["whatsapp__call_owner"] for "call me in 10 minutes" or "call me when the research is done". Only list tools the task actually needs.',
      ),
    })),
    execute: async ({ cron: cronExpr, delay_seconds, description, prompt, skill_name, allow_tools }) => {
      if (!cronExpr && !delay_seconds) {
        return 'Either cron or delay_seconds must be provided.';
      }
      if (cronExpr && delay_seconds) {
        return 'Provide either cron or delay_seconds, not both.';
      }

      if (!prompt && !skill_name) {
        return 'Either prompt or skill_name must be provided so the task has something to do.';
      }

      const allowTools = [...new Set((allow_tools ?? []).filter((t) => isPluginToolName(t)))];
      const rejected = (allow_tools ?? []).filter((t) => !isPluginToolName(t));
      if (rejected.length) {
        const mcpNote = rejected.some((t) => t.startsWith('mcp__'))
          ? ' MCP tools run unattended only when the owner lists them in that server\'s tools.autoApprove (mercury.yaml).'
          : '';
        return `allow_tools only takes plugin tools (like whatsapp__call_owner); not: ${rejected.join(', ')}.${mcpNote}`;
      }
      if (allowTools.length && permissions.getCurrentSenderRole() === 'member') {
        return 'Only the owner can schedule tasks that act without asking (allow_tools).';
      }
      const approved = await permissions.requestApproval(
        `Create scheduled task: ${description}${allowTools.length ? ` (when it runs, it may use ${allowTools.join(', ')} without asking again)` : ''}`,
      );
      if (!approved) return 'Permission denied: scheduled task creation was not approved.';

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
          ...(allowTools.length ? { allowTools } : {}),
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
        ...(allowTools.length ? { allowTools } : {}),
      };

      scheduler.addPersistedTask(manifest);
      scheduler.persistSchedules();

      const triggerType = skill_name ? `skill: ${skill_name}` : `prompt: "${prompt!.slice(0, 60)}"`;
      return `Task "${id}" scheduled. Cron: ${cronExpr}. Will execute ${triggerType}. Description: ${description}`;
    },
  });
}
