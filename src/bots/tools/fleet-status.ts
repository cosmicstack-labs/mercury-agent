import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import type { BotManager } from '../bot-manager.js';

/**
 * fleet_status — a lead bot's awareness loop: live state of every crew
 * member (running/queued/idle/paused/disabled, current activity, last run,
 * needs-you flags). Derived from the manager's in-memory + store state, so
 * it is always current and never blocks.
 */
export function createFleetStatusTool(manager: BotManager, leadId: string) {
  return tool({
    description:
      'Check the live status of your fleet crew — who is running, queued, idle, or blocked, and what each is working on. ' +
      'Use this before delegating (pick an idle specialist) and to monitor delegated tasks.',
    inputSchema: zodSchema(z.object({})),
    execute: async () => {
      const crew = manager.getStatusSummaries().filter(s => s.parent === leadId);
      if (crew.length === 0) {
        return 'Your crew is empty. Use bot_spawn to add specialists, or ask the user to add crew members.';
      }
      const lines: string[] = [`Crew (${crew.length}):`];
      for (const s of crew) {
        const icon = s.state === 'running' ? '🟢' : s.state === 'queued' ? '🔵' : s.state === 'paused' ? '🟡' : s.state === 'disabled' ? '⛔' : '⚪';
        const detail = s.activity ? ` — ${s.activity}` : '';
        const attention = s.needsYou ? ' · ⚠ NEEDS YOU' : '';
        lines.push(`- ${s.name} (${s.id}) [${s.state}]${attention}${detail}`);
      }
      const open = manager.tasks.open({ requester: leadId });
      if (open.length > 0) {
        lines.push('', `Open tasks (${open.length}) — you will be woken when they finish:`);
        for (const t of open) lines.push(`- ${t.id} → ${t.assignee}: ${t.status}${t.stage ? ` (${t.stage})` : ''} — ${t.goal.slice(0, 70)}`);
      }
      return lines.join('\n');
    },
  });
}