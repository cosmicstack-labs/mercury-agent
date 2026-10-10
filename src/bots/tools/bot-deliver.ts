import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import type { BotManager } from '../bot-manager.js';

/**
 * bot_deliver — move a finished artifact out of the bot's writable areas
 * (its private sandbox, or the fleet-shared folder) into the OWNER-CURATED
 * `outputs/<botId>/` zone. Deliverables there are exempt from the retention
 * janitor and land on the owner's machine — a bot should deliver when the
 * artifact is final, then say so in its turn summary.
 *
 * Fail-closed: only files inside the bot's own writable roots travel;
 * anything else is rejected with `outside_sandbox`.
 */
export function createBotDeliverTool(manager: BotManager, botId: string) {
  return tool({
    description:
      `Deliver a result you produced (an article, report, export, dataset, script…) from your sandbox ` +
      `or the fleet-shared folder to the owner's deliverables folder — the place the owner actually looks. ` +
      `Give it a human title. Mark final: true for the finished piece the owner asked for (it lands on top of the folder); ` +
      `research, drafts and checks are work (they land under work/). Deliver ONCE per artifact, and name the delivered file in your reply. ` +
      `Delivering is what makes a run count as done.`,
    inputSchema: zodSchema(z.object({
      file: z.string().min(1).max(500).describe(
        'The file to deliver: an absolute path, or a path relative to your sandbox or the fleet-shared folder (e.g. "_shared/report-2026-09-30.md")',
      ),
      title: z.string().max(120).optional().describe(
        'Human title for the delivered file, e.g. "Oxide Series D explained" (the date is added automatically).',
      ),
      final: z.boolean().optional().describe(
        'true = the finished piece the owner asked for (top of the folder). Omit for research, drafts and intermediate stages.',
      ),
      saveAs: z.string().max(120).optional().describe(
        'Optional filename override (extension auto-kept). Prefer title.',
      ),
    })),
    execute: async ({ file, title, final, saveAs }: { file: string; title?: string; final?: boolean; saveAs?: string }) => {
      const result = manager.deliver(botId, file, { title, final, saveAs });
      if (!result.accepted) {
        if (result.reasonCode === 'outside_sandbox') {
          return `Error: ${file} is not a readable file inside your sandbox or the fleet-shared folder.`;
        }
        if (result.reasonCode === 'target_unknown') {
          return `Error: bot profile for "${botId}" is gone.`;
        }
        return `Error: delivering ${file} failed [reason: ${result.reasonCode}]. Keep the file where it is and report the failure in your summary.`;
      }
      return `Delivered to ${result.path} — ${result.final ? 'a FINAL in the owner\'s deliverables folder' : 'work in the owner\'s deliverables folder (under work/)'}. The source copy has been removed.`;
    },
  });
}