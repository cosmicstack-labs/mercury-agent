import { tool, zodSchema } from 'ai';
import { z } from 'zod';

/**
 * Plan checklist tool: the model maintains a visible, structured plan that
 * the Mercury Code TUI renders as a live checklist — pending / ACTIVE
 * (currently being implemented) / done. The model replaces the full list on
 * each call (TodoWrite-style), marking exactly one step `active` while
 * working on it and `done` once finished. Display state flows through the
 * agent's step observation, not through this tool's return value.
 */
export function createUpdatePlanTool() {
  return tool({
    description:
      'Maintain your visible implementation plan checklist. After analyzing the task, register your plan steps (all "pending"). Before starting each step, mark it "active"; after finishing it, mark it "done" and activate the next. The TUI shows this checklist so the user always sees which step is being implemented. Send the FULL list every time (it replaces the previous one).',
    inputSchema: zodSchema(z.object({
      steps: z.array(z.object({
        label: z.string().describe('Short, concrete step description (a file, a feature, a verification run)'),
        status: z.enum(['pending', 'active', 'done']).describe('pending = not started, active = working on it now, done = finished and verified'),
      })).min(1).max(20).describe('The full plan, in order. Exactly one step should be "active" while working.'),
    })),
    execute: async ({ steps }) => {
      const done = steps.filter((s) => s.status === 'done').length;
      const active = steps.find((s) => s.status === 'active');
      return `Plan updated: ${steps.length} steps, ${done} done${active ? `, working on: ${active.label}` : ''}.`;
    },
  });
}