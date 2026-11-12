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
/**
 * How multi-step work is done (Mercury Code's contract, for chat): sent with
 * a new plan, where the model is about to do the work. Each line is a
 * failure seen in real chats: a Node version error answered with a switch to
 * another tool, a black MP4 announced as "pixel-perfect", six summary files
 * nobody asked for.
 */
export const WORK_RULES = [
  'How to carry this out:',
  '- Act, don\'t announce: a sentence about what you\'ll do next comes with the tool call that does it.',
  '- A step is done when its result exists and you checked it (open the file, probe the video, look at the output). Report only what you checked.',
  '- When a tool or requirement fails (a version, a missing dependency, a quota), fix the cause (another installed version, a flag, a setting) or ask the user. Never switch to a different method the user didn\'t ask for, and never present a workaround as the requested result.',
  '- Don\'t create summaries, READMEs or reports nobody asked for.',
  '- Mark each step done as you finish it; the user watches this checklist.',
].join('\n');

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
      const open = steps.length - done;
      const head = `Plan updated: ${steps.length} steps, ${done} done${active ? `, working on: ${active.label}` : ''}.`;
      // A new plan of real multi-step work: the working rules Mercury Code uses, once.
      if (done === 0 && steps.length >= 3) return `${head}\n\n${WORK_RULES}`;
      return head + (open > 0 ? ' When a step is finished, mark it done; before your final reply, send the plan once more with every finished step done.' : '');
    },
  });
}