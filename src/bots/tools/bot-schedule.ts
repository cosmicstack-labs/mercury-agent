import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { logger } from '../../utils/logger.js';

export interface BotScheduler {
  addDelayedTask(manifest: {
    id: string;
    description: string;
    prompt: string;
    delaySeconds?: number;
    executeAt?: string;
    botId?: string;
    createdAt: string;
  }): void;
  addPersistedTask(manifest: {
    id: string;
    cron: string;
    description: string;
    prompt: string;
    botId?: string;
    createdAt: string;
  }): void;
  persistSchedules(): void;
  /** All live manifests, used for the per-bot self-schedule cap. */
  getManifests(): Array<{ id: string; botId?: string }>;
}

const SELF_PREFIX = 'self-';
const ROUTINE_PREFIX = 'routine-';
const MAX_DELAY_MINUTES = 60 * 24 * 30; // 30 days
const MAX_PENDING_SELF_SCHEDULES = 10;

/**
 * bot_schedule — a bot schedules its OWN future run (durable, persisted with
 * the fleet's schedules): one-shot delayed runs ("post again in an hour") or
 * self-created recurring routines. Guardrails keep runaway loops bounded:
 * prompts are capped, delays are capped, and a bot can have at most
 * MAX_PENDING_SELF_SCHEDULES pending one-shots.
 */
export function createBotScheduleTool(scheduler: BotScheduler, botId: string) {
  return tool({
    description:
      'Schedule work for yourself in the future. Use when a task needs a follow-up later (e.g. "post the follow-up in one hour") ' +
      'or a recurring routine. One-shot: delayMinutes (or executeAt ISO date). Recurring: cron (5 fields). ' +
      'The scheduled run starts fresh with your persona and tools; results are delivered like any other run.',
    inputSchema: zodSchema(z.object({
      prompt: z.string().min(1).max(4000).describe('What you should do on the future run — self-contained, include all needed context'),
      delayMinutes: z.number().min(1).max(MAX_DELAY_MINUTES).optional().describe('One-shot: run again after this many minutes (1..43200)'),
      executeAt: z.string().optional().describe('One-shot alternative: ISO timestamp to run at'),
      cron: z.string().optional().describe('Recurring: 5-field cron expression, e.g. "0 9 * * 1"'),
      name: z.string().max(40).optional().describe('Label for recurring routines (required with cron)'),
    })),
    execute: async ({ prompt, delayMinutes, executeAt, cron, name }: {
      prompt: string; delayMinutes?: number; executeAt?: string; cron?: string; name?: string;
    }) => {
      const hasDelay = delayMinutes !== undefined || executeAt !== undefined;
      if (hasDelay === Boolean(cron)) {
        return 'Error: choose exactly one — delayMinutes/executeAt for a one-shot, or cron for a recurring routine.';
      }

      if (cron) {
        if (!name) return 'Error: cron schedules need a name (used to update/replace the routine later).';
        if (cron.trim().split(/\s+/).length !== 5) {
          return `Error: "${cron}" is not a 5-field cron expression.`;
        }
        const id = `bot:${botId}:${ROUTINE_PREFIX}${name.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}`;
        scheduler.addPersistedTask({
          id,
          cron,
          description: name,
          prompt,
          botId,
          createdAt: new Date().toISOString(),
        });
        scheduler.persistSchedules();
        logger.info({ botId, id, cron }, 'Bot self-scheduled a recurring routine');
        return `Scheduled: routine "${name}" (${cron}) — fires through the cron lane; results land in your chat like any other run. Manage via /bots.`;
      }

      // One-shot with a pending cap — this is the runaway-loop guard.
      const pending = scheduler.getManifests().filter(m => m.botId === botId && m.id.includes(`:${SELF_PREFIX}`)).length;
      if (pending >= MAX_PENDING_SELF_SCHEDULES) {
        return `Error: you already have ${MAX_PENDING_SELF_SCHEDULES} pending self-scheduled runs — complete or let them fire before adding more.`;
      }

      let delaySeconds: number;
      if (executeAt) {
        const at = new Date(executeAt);
        if (Number.isNaN(at.getTime())) return `Error: "${executeAt}" is not a valid ISO timestamp.`;
        delaySeconds = Math.max(1, Math.ceil((at.getTime() - Date.now()) / 1000));
        if (delaySeconds > MAX_DELAY_MINUTES * 60) {
          return `Error: scheduled time is beyond the ${MAX_DELAY_MINUTES / 60 / 24}-day horizon.`;
        }
      } else {
        if ((delayMinutes as number) > MAX_DELAY_MINUTES) {
          return `Error: delayMinutes exceeds the ${MAX_DELAY_MINUTES / 60 / 24}-day horizon.`;
        }
        delaySeconds = Math.round((delayMinutes as number) * 60);
      }

      const id = `bot:${botId}:${SELF_PREFIX}${randomUUID().slice(0, 8)}`;
      const executeAtIso = new Date(Date.now() + delaySeconds * 1000).toISOString();
      scheduler.addDelayedTask({
        id,
        description: 'bot self-schedule',
        prompt,
        delaySeconds,
        executeAt: executeAtIso,
        botId,
        createdAt: new Date().toISOString(),
      });
      scheduler.persistSchedules();
      logger.info({ botId, id, executeAtIso }, 'Bot self-scheduled a one-shot run');
      return `Scheduled: this run will fire in ${Math.round(delaySeconds / 60)} min (at ${executeAtIso}). It survives restarts; prompt: "${prompt.slice(0, 80)}"`;
    },
  });
}