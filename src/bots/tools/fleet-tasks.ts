import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import type { BotManager } from '../bot-manager.js';

/**
 * Lead-side fleet tools (ADR-021):
 * - fleet_delegate: fan out typed tasks to several crew in one call; the
 *   lead is woken ONCE with a digest when the batch completes (or its
 *   deadline passes), not once per task.
 * - fleet_tasks: see open/recent tasks, cancel one.
 * - fleet_pipeline: run the lead's declared pipeline (bot.yaml) on an
 *   input — stages chain themselves without lead turns in between.
 */
export function createFleetDelegateTool(manager: BotManager, leadId: string) {
  return tool({
    description:
      'Delegate work to your crew as typed tasks — several at once, in parallel. You are woken ONCE with a digest ' +
      '(status, outcome, delivered files, summary per task) when all of them finish or the deadline passes, so you do not ' +
      'need to poll. Prefer this over bot_send for any real work.',
    inputSchema: zodSchema(z.object({
      tasks: z.array(z.object({
        bot: z.string().describe('Crew bot id'),
        goal: z.string().min(10).max(8000).describe('Self-contained task: what to produce, inputs, constraints'),
        acceptance: z.string().max(1000).optional().describe('What "done" means — a file delivered, a check passed, a list of N items…'),
      })).min(1).max(12),
      label: z.string().max(60).optional().describe('Short name for this batch, e.g. "C36 research"'),
      deadlineMinutes: z.number().min(5).max(24 * 60).optional().describe('Wake me with partial results after this long even if some tasks are still running (default 120)'),
      wakeWhen: z.enum(['all', 'each']).optional().describe('all (default) = one digest when everything is done; each = a wake per finished task'),
    })),
    execute: async ({ tasks, label, deadlineMinutes, wakeWhen }: { tasks: Array<{ bot: string; goal: string; acceptance?: string }>; label?: string; deadlineMinutes?: number; wakeWhen?: 'all' | 'each' }) => {
      const result = manager.delegate(leadId, { tasks, label, deadlineMinutes, wakeWhen });
      if (!result.ok) return `Error: ${result.error}`;
      const lines = [`Batch ${result.batchId}${label ? ` "${label}"` : ''} dispatched — ${result.tasks.length} task(s):`];
      for (const t of result.tasks) lines.push(`- ${t.id} → ${t.assignee}${t.duplicated ? ' (already in progress — not re-dispatched)' : ''}`);
      lines.push(`You will be woken with a digest when they finish${deadlineMinutes ? ` or after ${deadlineMinutes} minutes` : ' or after 120 minutes'}. Finish this turn now; do not poll.`);
      return lines.join('\n');
    },
  });
}

export function createFleetTasksTool(manager: BotManager, leadId: string) {
  return tool({
    description: 'List your open and recent delegated tasks (with results), or cancel one.',
    inputSchema: zodSchema(z.object({
      action: z.enum(['list', 'cancel']).optional().describe('list (default) or cancel'),
      taskId: z.string().optional().describe('For cancel: the task id'),
    })),
    execute: async ({ action, taskId }: { action?: 'list' | 'cancel'; taskId?: string }) => {
      if (action === 'cancel') {
        if (!taskId) return 'Error: cancel needs a taskId.';
        const r = await manager.cancelTask(leadId, taskId);
        return r.ok ? `Task ${taskId} cancelled.` : `Error: ${r.error}`;
      }
      const recent = manager.tasksFor(leadId);
      if (recent.length === 0) return 'No delegated tasks yet. Use fleet_delegate to hand work to your crew.';
      const lines = ['Your tasks (newest first):'];
      for (const t of recent) {
        const r = t.result;
        lines.push(`- ${t.id} → ${t.assignee}: ${t.status}${r?.outcome ? ` · ${r.outcome}` : ''}${r?.deliverables?.length ? ` · ${r.deliverables.length} file(s)` : ''} — ${t.goal.slice(0, 80)}`);
      }
      return lines.join('\n');
    },
  });
}

export function createFleetPipelineTool(manager: BotManager, leadId: string, stageNames: string[]) {
  return tool({
    description:
      `Run your pipeline (${stageNames.join(' → ')}) on an input. Each stage is delegated to its bot in turn and hands its ` +
      'deliverable to the next; you are woken once at the end with the final result. Use this for the standard job; do not ' +
      'run the stages by hand.',
    inputSchema: zodSchema(z.object({
      input: z.string().min(3).max(4000).describe('The subject of this run, e.g. a topic, a URL, a brief'),
      label: z.string().max(60).optional().describe('Short name for the run'),
    })),
    execute: async ({ input, label }: { input: string; label?: string }) => {
      const r = manager.runPipeline(leadId, input, label);
      if (!r.ok) return `Error: ${r.error}`;
      return `Pipeline run ${r.runId} started: stage 1/${r.total} "${r.firstStage}" dispatched${r.duplicated ? ' (a run on this input was already in progress)' : ''}. ` +
        'You will be woken when the last stage finishes. Finish this turn now.';
    },
  });
}
