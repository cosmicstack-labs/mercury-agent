/**
 * The interactive /memory menu on the CLI.
 * Moved out of Agent (P2.1 split); `agent` is the Agent instance.
 */
import type { Agent } from '../agent.js';
import { CLIChannel } from '../../channels/cli.js';
import {
  approveTelegramPendingRequest,
  approveTelegramPendingRequestByPairingCode,
  clearTelegramAccess,
  demoteTelegramAdmin,
  getTelegramAccessSummary,
  getTelegramApprovedUsers,
  getTelegramPendingRequests,
  promoteTelegramUserToAdmin,
  rejectTelegramPendingRequest,
  removeTelegramUser,
  saveConfig,
  loadConfig,
  getActiveProviders,
  getDiscordAccessSummary,
  hasDiscordAdmins,
  findDiscordPendingRequest,
  approveDiscordPendingRequest,
  approveDiscordPendingRequestByPairingCode,
  rejectDiscordPendingRequest as rejectDiscordPendingRequestConfig,
  removeDiscordUser,
  clearDiscordAccess,
  getSlackAccessSummary,
  hasSlackAdmins,
  findSlackPendingRequest,
  approveSlackPendingRequest,
  approveSlackPendingRequestByPairingCode,
  rejectSlackPendingRequest as rejectSlackPendingRequestConfig,
  removeSlackUser,
  clearSlackAccess,
} from '../../utils/config.js';
import type { ArrowSelectOption } from '../../utils/arrow-select.js';

export async function openCliMemoryMenu(agent: Agent, channel: CLIChannel, channelId: string, select?: (title: string, options: ArrowSelectOption[]) => Promise<string>): Promise<void> {
  if (!agent.userMemory) return;

  const runMenu = async (sel: (title: string, options: ArrowSelectOption[]) => Promise<string>) => {
    while (true) {
      const learningLabel = agent.userMemory!.isLearningPaused() ? 'Resume Learning' : 'Pause Learning';
      const shareLabel = agent.userMemory!.isShareLearning() ? 'Shared Learning: ON' : 'Shared Learning: OFF';
      const action = await sel('Memory', [
        { value: 'overview', label: 'Overview' },
        { value: 'recent', label: 'Recent Memories' },
        { value: 'shared', label: 'Shared Memories' },
        { value: 'search', label: 'Search' },
        { value: 'toggle', label: learningLabel },
        { value: 'share', label: shareLabel },
        { value: 'clear', label: 'Clear All Memories' },
        { value: 'back', label: 'Back' },
      ]);

      if (action === 'back') return;

      if (action === 'overview') {
        await agent.sendMemoryOverview(channel, channelId);
        continue;
      }

      if (action === 'recent') {
        const recent = agent.userMemory!.getRecent(10);
        if (recent.length === 0) {
          await channel.send('No memories yet.', channelId);
          continue;
        }
        const lines = ['**Recent Memories:**', ''];
        for (const r of recent) {
          const scope = r.scope === 'active' ? '⏳' : '📌';
          const kind = r.evidenceKind === 'direct' ? 'direct' : r.evidenceKind === 'inferred' ? 'inferred' : r.evidenceKind;
          lines.push(`${scope} [${r.type}] ${r.summary}`);
          lines.push(`   Confidence: ${r.confidence.toFixed(2)} | Evidence: ${kind} | Seen: ${r.evidenceCount}x`);
        }
        await channel.send(lines.join('\n'), channelId);
        continue;
      }

      if (action === 'shared') {
        const shared = agent.userMemory!.getShareable(20);
        if (shared.length === 0) {
          await channel.send('No shared memories yet. Enable shared learning to mark new memories as shareable for cloud fetch.', channelId);
          continue;
        }
        const lines = [`**Shared Memories (${shared.length}):**`, ''];
        for (const r of shared) {
          const scope = r.scope === 'active' ? '⏳' : '📌';
          const cats = r.categories.length > 0 ? ` {${r.categories.join(', ')}}` : '';
          lines.push(`${scope} [${r.type}]${cats} ${r.summary}`);
          lines.push(`   Confidence: ${r.confidence.toFixed(2)} | Evidence: ${r.evidenceKind} | Seen: ${r.evidenceCount}x`);
        }
        await channel.send(lines.join('\n'), channelId);
        continue;
      }

      if (action === 'search') {
        const query = await channel.prompt('Search memories: ');
        if (!query) continue;
        const results = agent.userMemory!.search(query, 10);
        if (results.length === 0) {
          await channel.send(`No memories found matching "${query}".`, channelId);
          continue;
        }
        const lines = [`**Search results for "${query}":**`, ''];
        for (const r of results) {
          const scope = r.scope === 'active' ? '⏳' : '📌';
          lines.push(`${scope} [${r.type}] ${r.summary}`);
          lines.push(`   Confidence: ${r.confidence.toFixed(2)} | Evidence: ${r.evidenceKind} | Seen: ${r.evidenceCount}x`);
        }
        await channel.send(lines.join('\n'), channelId);
        continue;
      }

      if (action === 'toggle') {
        const currentlyPaused = agent.userMemory!.isLearningPaused();
        agent.userMemory!.setLearningPaused(!currentlyPaused);
        await channel.send(currentlyPaused ? 'Learning resumed. Mercury will remember new things from conversations.' : 'Learning paused. Mercury will not store new memories until resumed.', channelId);
        continue;
      }

      if (action === 'share') {
        const currently = agent.userMemory!.isShareLearning();
        agent.userMemory!.setShareLearning(!currently);
        const cfg = loadConfig();
        if (!cfg.memory.collaborativeKnowledge) cfg.memory.collaborativeKnowledge = {};
        cfg.memory.collaborativeKnowledge.shareLearning = !currently;
        saveConfig(cfg);
        const count = agent.userMemory!.countShareable();
        await channel.send(
          currently
            ? `Shared learning disabled. New memories will stay private. (${count} memories already shareable are unchanged.)`
            : `Shared learning enabled. New memories will be marked shareable for cloud fetch. (${count} memories currently shareable.)`,
          channelId,
        );
        continue;
      }

      if (action === 'clear') {
        const confirm = await sel('Clear all memories?', [
          { value: 'cancel', label: 'Cancel' },
          { value: 'confirm', label: 'Clear everything' },
        ]);
        if (confirm === 'confirm') {
          const cleared = agent.userMemory!.clear();
          await channel.send(`Cleared ${cleared} memories.`, channelId);
        }
        continue;
      }
    }
  };

  if (select) {
    await runMenu(select);
  } else {
    await channel.withMenu(runMenu);
  }
}
