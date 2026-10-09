/**
 * Memory choice picker shared by the CLI menus.
 * Moved out of Agent (P2.1 split); `agent` is the Agent instance.
 */
import type { Agent } from '../agent.js';
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


export async function openMemoryChoiceMenu(agent: Agent, channel: any, channelId: string): Promise<void> {
  if (!agent.userMemory) return;

  const learningLabel = agent.userMemory.isLearningPaused() ? 'Resume Learning' : 'Pause Learning';
  const shareLabel = agent.userMemory.isShareLearning() ? 'Shared Learning: ON' : 'Shared Learning: OFF';
  const action = await channel.presentChoicePrompt('Memory', [
    { value: 'overview', label: 'Overview' },
    { value: 'recent', label: 'Recent Memories' },
    { value: 'shared', label: 'Shared Memories' },
    { value: 'toggle', label: learningLabel },
    { value: 'share', label: shareLabel },
    { value: 'clear', label: 'Clear All Memories' },
    { value: 'cancel', label: 'Cancel' },
  ], channelId);

  if (action === 'cancel') return;

  if (action === 'overview') {
    await agent.sendMemoryOverview(channel, channelId);
    return;
  }

  if (action === 'recent') {
    const recent = agent.userMemory.getRecent(10);
    if (recent.length === 0) {
      await channel.send('No memories yet.', channelId);
      return;
    }
    const lines = ['**Recent Memories:**', ''];
    for (const r of recent) {
      const scope = r.scope === 'active' ? '⏳' : '📌';
      const kind = r.evidenceKind === 'direct' ? 'direct' : r.evidenceKind === 'inferred' ? 'inferred' : r.evidenceKind;
      lines.push(`${scope} [${r.type}] ${r.summary}`);
      lines.push(`   Confidence: ${r.confidence.toFixed(2)} | Evidence: ${kind} | Seen: ${r.evidenceCount}x`);
    }
    await channel.send(lines.join('\n'), channelId);
    return;
  }

  if (action === 'shared') {
    const shared = agent.userMemory.getShareable(20);
    if (shared.length === 0) {
      await channel.send('No shared memories yet. Enable shared learning to mark new memories as shareable for cloud fetch.', channelId);
      return;
    }
    const lines = [`**Shared Memories (${shared.length}):**`, ''];
    for (const r of shared) {
      const scope = r.scope === 'active' ? '⏳' : '📌';
      const cats = r.categories.length > 0 ? ` {${r.categories.join(', ')}}` : '';
      lines.push(`${scope} [${r.type}]${cats} ${r.summary}`);
      lines.push(`   Confidence: ${r.confidence.toFixed(2)} | Evidence: ${r.evidenceKind} | Seen: ${r.evidenceCount}x`);
    }
    await channel.send(lines.join('\n'), channelId);
    return;
  }

  if (action === 'toggle') {
    const currentlyPaused = agent.userMemory.isLearningPaused();
    agent.userMemory.setLearningPaused(!currentlyPaused);
    await channel.send(currentlyPaused ? 'Learning resumed. Mercury will remember new things from conversations.' : 'Learning paused. Mercury will not store new memories until resumed.', channelId);
    return;
  }

  if (action === 'share') {
    const currently = agent.userMemory.isShareLearning();
    agent.userMemory.setShareLearning(!currently);
    const cfg = loadConfig();
    if (!cfg.memory.collaborativeKnowledge) cfg.memory.collaborativeKnowledge = {};
    cfg.memory.collaborativeKnowledge.shareLearning = !currently;
    saveConfig(cfg);
    const count = agent.userMemory.countShareable();
    await channel.send(
      currently
        ? `Shared learning disabled. New memories will stay private. (${count} memories already shareable are unchanged.)`
        : `Shared learning enabled. New memories will be marked shareable for cloud fetch. (${count} memories currently shareable.)`,
      channelId,
    );
    return;
  }

  if (action === 'clear') {
    const confirm = await channel.presentChoicePrompt('Clear all memories?', [
      { value: 'cancel', label: 'Cancel' },
      { value: 'confirm', label: 'Clear everything' },
    ], channelId);
    if (confirm === 'confirm') {
      const cleared = agent.userMemory.clear();
      await channel.send(`Cleared ${cleared} memories.`, channelId);
    }
  }
}
