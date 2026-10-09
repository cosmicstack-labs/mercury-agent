/**
 * Slash-command dispatcher for chat surfaces (/help, /status, /model, /memory, /sessions, /new, /trace, /reset, …).
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
import { MAX_STEPS } from '../agent.js';
import path from 'node:path';
import type { ChannelMessage, ChannelType } from '../../types/channel.js';
import { createProvider, ProviderRegistry as ProviderRegistryImpl } from '../../providers/registry.js';
import { ProgrammingMode } from '../programming-mode.js';
import { logger } from '../../utils/logger.js';
import { CLIChannel } from '../../channels/cli.js';
import { formatToolStep, formatNarrative, type NarrativeStep } from '../../utils/tool-label.js';
import { getTelegramHelp, getDiscordHelp, getSlackHelp } from '../../utils/manual.js';
import { WebChannel } from '../../channels/web.js';
import type { ArrowSelectOption } from '../../utils/arrow-select.js';
import { PLAYER_CONTROLS, handlePlayerAction, formatNowPlaying } from '../../spotify/ui.js';
import { getCloudTokenStore } from '../../cloud/token-store.js';
import { updateCliProviderStatus } from '../provider-status.js';
import { whatsNewText } from '../../utils/whats-new.js';

export async function handleChatCommand(agent: Agent, content: string, channelType: string, channelId: string): Promise<boolean> {
  const trimmed = content.trim();
  const cmd = trimmed.toLowerCase();
  const channel = agent.channels.get(channelType as any);
  if (!channel) return false;

  const ctx = agent.capabilities.getChatCommandContext();
  if (!ctx) return false;

  if (cmd === '/sessions' || cmd.startsWith('/session')) {
    await agent.handleSessionCommand(trimmed, channelType as ChannelType, channelId);
    return true;
  }

  // /new — fresh conversation context for this chat; memory is kept.
  // Unlike /reset this never halts agents, clears queues, or wipes state.
  if (cmd === '/new') {
    await agent.handleSessionCommand('/session new', channelType as ChannelType, channelId);
    return true;
  }

  // /trace [id] — what happened in a turn: provider, tokens, timing,
  // verification, and every tool call. Answers "why did it do that?".
  if (cmd === '/trace' || cmd.startsWith('/trace ')) {
    await channel.send(agent.renderTrace(channelType as ChannelType, channelId, trimmed.slice('/trace'.length).trim()), channelId);
    return true;
  }

  if (cmd === '/help') {
    const helpText = channelType === 'telegram' ? getTelegramHelp() : channelType === 'discord' ? getDiscordHelp() : channelType === 'slack' ? getSlackHelp() : ctx.manual();
    await channel.send(helpText, channelId);
    return true;
  }

  if (cmd === '/whatsnew' || cmd.startsWith('/whatsnew ')) {
    // Curated highlights for the running version — one friendly block,
    // exhaustive notes stay in CHANGELOG.md / the releases page.
    const runningVersion = channelType === 'cli' && channel instanceof CLIChannel
      ? (channel.getTuiState().version || 'dev')
      : 'dev';
    await channel.send(whatsNewText(runningVersion), channelId).catch((e) => logger.warn({ e }, 'channel send failed'));
    return true;
  }

  if (cmd.startsWith('/update')) {
    const sub = trimmed.slice('/update'.length).trim().toLowerCase();
    if (sub === 'ignore') {
      const { latestSeenUpdate, ignoreUpdateVersion, getIgnoredUpdateVersion } = await import('../../cli/update-notice.js');
      const runningVersion = channelType === 'cli' && channel instanceof CLIChannel
        ? (channel.getTuiState().version || 'dev')
        : 'dev';
      const target = latestSeenUpdate(runningVersion);
      if (!target) {
        await channel.send('Nothing to ignore — no update was offered for this version.', channelId);
        return true;
      }
      if (getIgnoredUpdateVersion() === target) {
        await channel.send(`Update to v${target} is already ignored.`, channelId);
        return true;
      }
      ignoreUpdateVersion(target);
      if (channel instanceof CLIChannel) channel.setUpdateAvailable(null);
      await channel.send(`Ignored — update notices for v${target} are silenced permanently. \`mercury upgrade\` in the terminal still works whenever you want it.`, channelId);
      return true;
    }
    await channel.send('Usage: `/update ignore` — permanently silence the offered update notice.', channelId);
    return true;
  }

  if (cmd === '/saver' || cmd.startsWith('/saver ')) {
    await agent.handleSaverCommand(trimmed.slice('/saver'.length).trim(), channelType, channelId);
    return true;
  }

  if (cmd.startsWith('/bg')) {
    await agent.handleBgCommand(trimmed, { content: trimmed, channelId, channelType: channelType as any, id: Date.now().toString(36), senderId: 'user', timestamp: Date.now() }, channel);
    return true;
  }

  if (cmd === '/progress' || cmd === '/still') {
    if (!agent.processing || !agent.currentMessage) {
      await channel.send('No active foreground task.', channelId);
      return true;
    }
    const elapsedSec = Math.round((Date.now() - agent.currentMessage.timestamp) / 1000);
    const stepInfo = agent.completedStepCount > 0 ? ` · step ${agent.completedStepCount}/${MAX_STEPS}` : '';
    const narrative = formatNarrative(agent.stepNarrative, agent.currentActivity, 10);
    const narrativeBlock = narrative ? `\n${narrative}` : '';
    await channel.send(
      `⏳ Task in progress (${elapsedSec}s${stepInfo})${narrativeBlock}\nUse /bg current to move it to background.`,
      channelId,
    );
    return true;
  }

  if (cmd === '/exit' || cmd === '/quit') {
    await channel.send('Goodbye! Shutting down Mercury...', channelId);
    agent.shutdown();
    return true;
  }

  if (cmd === '/permissions') {
    if (channelType === 'cli' && channel instanceof CLIChannel) {
      const mode = await channel.askPermissionMode?.();
      if (mode === 'allow-all') {
        agent.capabilities.permissions.setAutoApproveAll(true);
        agent.capabilities.permissions.addTempScope('/', true, true);
        await channel.send('Allow All mode active for this session. All scopes, commands, and loops auto-approved. Resets on restart.', channelId);
      } else {
        agent.capabilities.permissions.setAutoApproveAll(false);
        await channel.send('Ask Me mode active. Risky actions will prompt for confirmation.', channelId);
      }
      return true;
    }
    await channel.send('Use /permissions in CLI to switch permission mode. On Telegram, use the /permissions button or command.', channelId);
    return true;
  }

  if (cmd === '/status') {
    const config = ctx.config();
    const budget = ctx.tokenBudget();
    const saver = agent.saverMode.getState();
    const saverLine = saver === 'off'
      ? `Saver: off (auto at ${agent.saverMode.getAutoThreshold()}%)`
      : `Saver: ${saver.toUpperCase()} · saved today ~${agent.tokenBudget.getSavedToday().toLocaleString()} tokens`;
    const lines = [
      `**${config.identity.name}** — Status`,
      `Owner: ${config.identity.owner || '(not set)'}`,
      `Provider: ${config.providers.default}`,
      `Telegram: ${config.channels.telegram.enabled ? 'enabled' : 'disabled'}`,
      `Telegram access: ${getTelegramAccessSummary(config)}`,
      `Discord: ${config.channels.discord.enabled ? 'enabled' : 'disabled'}`,
      `Discord access: ${getDiscordAccessSummary(config)}`,
      `Slack: ${config.channels.slack.enabled ? 'enabled' : 'disabled'}`,
      `Slack access: ${getSlackAccessSummary(config)}`,
      `Budget: ${budget.getStatusText()}`,
      saverLine,
      `Skills: ${ctx.skillNames().length > 0 ? ctx.skillNames().join(', ') : 'none'}`,
    ];
    await channel.send(lines.join('\n'), channelId);
    return true;
  }

  if (cmd === '/models' || cmd === '/model' || cmd.startsWith('/models ') || cmd.startsWith('/model ')) {
    const base = cmd.startsWith('/model ') || cmd === '/model' ? '/model' : '/models';
    const rawArgs = trimmed.slice(base.length).trim();
    const activeProviders = getActiveProviders(agent.config);
    const current = agent.providers.getDefault();

    if (!rawArgs) {
      const lines = [
        '**Session Models**',
        '',
        ...activeProviders.map((p) => {
          const marker = p.name === current.name ? ' ← current' : '';
          return `• ${p.name} · ${p.model}${marker}`;
        }),
        '',
        'Use `/models use <provider>` to switch the default (saved across restarts).',
        'Use `mercury doctor` to add/configure models.',
      ];
      await channel.send(lines.join('\n'), channelId);

      if (channelType === 'cli' && channel instanceof CLIChannel && activeProviders.length > 1) {
        const choices = [
          ...activeProviders.map((p) => `${p.name} · ${p.model}${p.name === current.name ? ' (current)' : ''}`),
          'Open doctor instructions',
          'Keep current model',
        ];
        const picked = await agent.presentChoice('Switch session model?', choices, channelId, channelType);
        if (picked === 'Open doctor instructions') {
          await channel.send('Run `mercury doctor` and update provider/model settings. Then restart Mercury to persist defaults.', channelId);
          return true;
        }
        if (picked === 'Keep current model') return true;
        const providerName = picked.split(' · ')[0].trim();
        if (providerName && providerName !== current.name) {
          const switched = await agent.switchSessionProvider(providerName);
          await channel.send(switched.message, channelId);
        }
      }
      return true;
    }

    if (rawArgs === 'doctor' || rawArgs === 'add') {
      await channel.send('Use `mercury doctor` to add/configure models. Then use `/models` to switch active session model.', channelId);
      return true;
    }

    const target = rawArgs.replace(/^use\s+/i, '').trim();
    if (!target) {
      await channel.send('Usage: `/models` or `/models use <provider>`', channelId);
      return true;
    }

    const switched = await agent.switchSessionProvider(target);
    await channel.send(switched.message, channelId);
    return true;
  }

  if (cmd === '/cloud' || cmd.startsWith('/cloud ')) {
    const cfg = ctx.config();
    if (!cfg.cloud.enabled || !cfg.cloud.jwt) {
      await channel.send('Mercury Cloud is not connected. Run `mercury cloud connect` to set it up.', channelId);
      return true;
    }

    const sub = trimmed.slice('/cloud'.length).trim();

    const ensureFreshToken = async (): Promise<string> => {
      try {
        const store = getCloudTokenStore();
        if (store) {
          return await store.rotateIfExpired();
        }
        const parts = cfg.cloud.jwt.split('.');
        if (parts.length === 3) {
          const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
          const exp = payload.exp * 1000;
          if (Date.now() > exp - 60_000 && cfg.cloud.refreshToken) {
            const { refreshToken } = await import('../../cloud/pairing.js');
            const result = await refreshToken(cfg.cloud.apiUrl, cfg.cloud.refreshToken);
            cfg.cloud.jwt = result.jwt;
            cfg.cloud.refreshToken = result.refreshToken;
            cfg.providers.mercuryCloud.apiKey = result.jwt;
            const { saveConfig } = await import('../../utils/config.js');
            saveConfig(cfg);
            agent.config = cfg;
            return result.jwt;
          }
        }
      } catch {}
      return cfg.cloud.jwt;
    };

    if (!sub || sub === 'models' || sub === 'model') {
      try {
        const jwt = await ensureFreshToken();
        const res = await fetch(`${cfg.cloud.apiUrl}/v1/models`, {
          headers: { Authorization: `Bearer ${jwt}` },
        });
        if (!res.ok) {
          await channel.send(`Failed to fetch cloud models (HTTP ${res.status}). Your token may have expired — run \`mercury cloud login\`.`, channelId);
          return true;
        }
        const data = await res.json() as { data: Array<{ id: string; label: string; tier_required: string; context_window: number; available: boolean; is_branded?: boolean; discount_percent?: number }> };
        const models = data.data || [];
        if (models.length === 0) {
          await channel.send('No models available.', channelId);
          return true;
        }

        const currentModel = cfg.providers.mercuryCloud?.model || '—';
        const branded = models.filter((m) => m.is_branded);
        const raw = models.filter((m) => !m.is_branded);

        const formatModel = (m: typeof models[0]) => {
          const marker = m.id === currentModel ? ' ← current' : '';
          const lock = m.available ? '' : ' 🔒';
          const discount = m.discount_percent && m.discount_percent > 0 ? ` (${m.discount_percent}% off input)` : '';
          return `• ${m.id} · ${m.label} (${m.tier_required})${discount}${lock}${marker}`;
        };

        const lines = [
          '**Mercury Cloud Models**',
          '',
          '**Mercury Branded**',
          ...branded.map(formatModel),
          '',
          '**Direct Models**',
          ...raw.map(formatModel),
          '',
          'Use `/cloud use <model-id>` to switch.',
        ];
        await channel.send(lines.join('\n'), channelId);

        if (channelType === 'cli' && channel instanceof CLIChannel) {
          const availableModels = models.filter((m) => m.available);
          const choices = [
            ...availableModels.map((m) => `${m.id} · ${m.label}${m.id === currentModel ? ' (current)' : ''}`),
            'Keep current model',
          ];
          if (availableModels.length <= 1) {
            await channel.send('Only one model available for your tier. Upgrade to unlock more.', channelId);
            return true;
          }
          const picked = await agent.presentChoice('Switch cloud model?', choices, channelId, channelType);
          if (picked === 'Keep current model') return true;
          const modelId = picked.split(' · ')[0].trim();
          if (modelId) {
            cfg.providers.mercuryCloud.model = modelId;
            cfg.providers.mercuryCloud.enabled = true;
            cfg.providers.default = 'mercuryCloud';
            const { saveConfig } = await import('../../utils/config.js');
            saveConfig(cfg);
            agent.config = cfg;
            const provider = await createProvider(cfg.providers.mercuryCloud, getCloudTokenStore());
            agent.providers.set('mercuryCloud', provider);
            agent.providers.setDefault('mercuryCloud');
            updateCliProviderStatus(agent.channels.get('cli'), 'mercuryCloud', modelId);
            await channel.send(`✓ Switched to **${modelId}**. Saved to config.`, channelId);
          }
        }
      } catch (err) {
        await channel.send(`Error fetching cloud models: ${(err as Error).message}`, channelId);
      }
      return true;
    }

    if (sub.startsWith('use ')) {
      const modelId = sub.slice(4).trim();
      if (!modelId) {
        await channel.send('Usage: `/cloud use <model-id>`', channelId);
        return true;
      }
      await ensureFreshToken();
      try {
        cfg.providers.mercuryCloud.model = modelId;
        cfg.providers.mercuryCloud.enabled = true;
        if (cfg.providers.default !== 'mercuryCloud') {
          cfg.providers.default = 'mercuryCloud';
        }
        const { saveConfig } = await import('../../utils/config.js');
        saveConfig(cfg);
        agent.config = cfg;
        const provider = await createProvider(cfg.providers.mercuryCloud, getCloudTokenStore());
        agent.providers.set('mercuryCloud', provider);
        agent.providers.setDefault('mercuryCloud');
        updateCliProviderStatus(agent.channels.get('cli'), 'mercuryCloud', modelId);
        await channel.send(`✓ Switched to **${modelId}**. Saved to config.`, channelId);
      } catch (err) {
        await channel.send(`Error switching model: ${(err as Error).message}`, channelId);
      }
      return true;
    }

    await channel.send('Usage: `/cloud models` to list, `/cloud use <model-id>` to switch', channelId);
    return true;
  }

  if (cmd === '/memory') {
    if (!agent.userMemory) {
      const cfg = ctx.config();
      if (cfg.memory.secondBrain?.enabled === false) {
        await channel.send('Second brain is disabled in configuration.', channelId);
      } else {
        await channel.send('Second brain dependency issue: SQLite backend (better-sqlite3) is not available.', channelId);
      }
      return true;
    }

    if (channelType === 'cli' && channel instanceof CLIChannel) {
      await agent.openCliMemoryMenu(channel, channelId);
      return true;
    }

    const choiceChannel = channel as typeof channel & { presentChoicePrompt?: (question: string, options: ArrowSelectOption[], targetId?: string) => Promise<string> };
    if (typeof choiceChannel.presentChoicePrompt === 'function') {
      await agent.openMemoryChoiceMenu(choiceChannel, channelId);
      return true;
    }

    await agent.sendMemoryOverview(channel, channelId);
    return true;
  }

  if (cmd.startsWith('/telegram')) {
    if (channelType !== 'cli') {
      await channel.send('`/telegram` is only available from the Mercury CLI chat.', channelId);
      return true;
    }

    const config = ctx.config();
    const rawSubcommand = trimmed.slice('/telegram'.length).trim();
    if (!rawSubcommand && channel instanceof CLIChannel) {
      await channel.withMenu(async (select) => {
        await agent.openCliTelegramMenu(channel, channelId, select);
      });
      return true;
    }

    const parts = rawSubcommand.split(/\s+/).filter(Boolean);
    const action = parts[0]?.toLowerCase() || 'help';
    const formatTelegramUser = (user: {
      userId: number;
      username?: string;
      firstName?: string;
      pairingCode?: string;
    }) => {
      const username = user.username ? ` (@${user.username})` : '';
      const firstName = user.firstName ? ` ${user.firstName}` : '';
      const pairingCode = user.pairingCode ? ` [code: ${user.pairingCode}]` : '';
      return `${user.userId}${username}${firstName}${pairingCode}`;
    };

    const sendTelegramOverview = async () => {
      const lines = [
        '**Telegram Management**',
        '',
        `Access: ${getTelegramAccessSummary(config)}`,
        `Admins: ${config.channels.telegram.admins.length > 0 ? config.channels.telegram.admins.map(formatTelegramUser).join(', ') : 'none'}`,
        `Members: ${config.channels.telegram.members.length > 0 ? config.channels.telegram.members.map(formatTelegramUser).join(', ') : 'none'}`,
        `Pending: ${config.channels.telegram.pending.length > 0 ? config.channels.telegram.pending.map(formatTelegramUser).join(', ') : 'none'}`,
        '',
        'Commands:',
        '• `/telegram pending`',
        '• `/telegram users`',
        '• `/telegram approve <pairing-code|user-id>`',
        '• `/telegram reject <user-id>`',
        '• `/telegram remove <user-id>`',
        '• `/telegram promote <user-id>`',
        '• `/telegram demote <user-id>`',
        '• `/telegram reset`',
      ];
      await channel.send(lines.join('\n'), channelId);
    };

    if (action === 'help' || action === 'status') {
      await sendTelegramOverview();
      return true;
    }

    if (action === 'pending') {
      const pending = getTelegramPendingRequests(config);
      const lines = [
        '**Telegram Pending Requests**',
        '',
        pending.length > 0 ? pending.map(formatTelegramUser).join('\n') : 'No pending Telegram requests.',
      ];
      await channel.send(lines.join('\n'), channelId);
      return true;
    }

    if (action === 'users') {
      const approved = getTelegramApprovedUsers(config);
      const lines = [
        '**Telegram Approved Users**',
        '',
        `Admins: ${config.channels.telegram.admins.length > 0 ? config.channels.telegram.admins.map(formatTelegramUser).join(', ') : 'none'}`,
        `Members: ${config.channels.telegram.members.length > 0 ? config.channels.telegram.members.map(formatTelegramUser).join(', ') : 'none'}`,
        '',
        `Total approved: ${approved.length}`,
      ];
      await channel.send(lines.join('\n'), channelId);
      return true;
    }

    if (action === 'approve') {
      const value = parts[1];
      if (!value) {
        await channel.send('Usage: `/telegram approve <pairing-code|user-id>`', channelId);
        return true;
      }

      let approved = approveTelegramPendingRequestByPairingCode(config, value);
      let resultLabel = value;

      if (!approved) {
        const userId = Number(value);
        if (!isNaN(userId)) {
          approved = approveTelegramPendingRequest(config, userId, 'member');
          resultLabel = userId.toString();
        }
      }

      if (!approved) {
        await channel.send(`No pending Telegram request found for \`${resultLabel}\`.`, channelId);
        return true;
      }

      saveConfig(config);
      await channel.send(`Approved Telegram user ${formatTelegramUser(approved)}.`, channelId);
      return true;
    }

    if (action === 'reject') {
      const value = Number(parts[1]);
      if (isNaN(value)) {
        await channel.send('Usage: `/telegram reject <user-id>`', channelId);
        return true;
      }

      const rejected = rejectTelegramPendingRequest(config, value);
      if (!rejected) {
        await channel.send(`No pending Telegram request found for \`${value}\`.`, channelId);
        return true;
      }

      saveConfig(config);
      await channel.send(`Rejected Telegram request for ${formatTelegramUser(rejected)}.`, channelId);
      return true;
    }

    if (action === 'remove') {
      const value = Number(parts[1]);
      if (isNaN(value)) {
        await channel.send('Usage: `/telegram remove <user-id>`', channelId);
        return true;
      }

      const removed = removeTelegramUser(config, value);
      if (!removed) {
        await channel.send(`No approved Telegram user found for \`${value}\`.`, channelId);
        return true;
      }

      saveConfig(config);
      await channel.send(`Removed Telegram access for ${formatTelegramUser(removed)}.`, channelId);
      return true;
    }

    if (action === 'promote') {
      const value = Number(parts[1]);
      if (isNaN(value)) {
        await channel.send('Usage: `/telegram promote <user-id>`', channelId);
        return true;
      }

      const promoted = promoteTelegramUserToAdmin(config, value);
      if (!promoted) {
        await channel.send(`No Telegram member found for \`${value}\`.`, channelId);
        return true;
      }

      saveConfig(config);
      await channel.send(`Promoted ${formatTelegramUser(promoted)} to Telegram admin.`, channelId);
      return true;
    }

    if (action === 'demote') {
      const value = Number(parts[1]);
      if (isNaN(value)) {
        await channel.send('Usage: `/telegram demote <user-id>`', channelId);
        return true;
      }

      const demoted = demoteTelegramAdmin(config, value);
      if (!demoted) {
        await channel.send('Could not demote that Telegram admin. Mercury must keep at least one admin.', channelId);
        return true;
      }

      saveConfig(config);
      await channel.send(`Demoted ${formatTelegramUser(demoted)} to Telegram member.`, channelId);
      return true;
    }

    if (action === 'reset' || action === 'unpair') {
      config.channels.telegram.admins = [];
      config.channels.telegram.members = [];
      config.channels.telegram.pending = [];
      saveConfig(config);
      await channel.send('Telegram access reset. New users can send /start to begin pairing again.', channelId);
      return true;
    }

    await channel.send(
    `Unknown Telegram command "${action}". Try \`/telegram\`, \`/telegram pending\`, or \`/telegram users\`.`,
      channelId,
    );
    return true;
  }

  if (cmd.startsWith('/discord')) {
    if (channelType !== 'cli') {
      await channel.send('`/discord` is only available from the Mercury CLI chat.', channelId);
      return true;
    }

    const config = ctx.config();
    const rawSubcommand = trimmed.slice('/discord'.length).trim();
    const parts = rawSubcommand.split(/\s+/).filter(Boolean);
    const action = parts[0]?.toLowerCase() || 'help';
    const formatDiscordUser = (user: {
      userId: string;
      username?: string;
      displayName?: string;
      pairingCode?: string;
    }) => {
      const username = user.username ? ` (@${user.username})` : '';
      const displayName = user.displayName ? ` ${user.displayName}` : '';
      const pairingCode = user.pairingCode ? ` [code: ${user.pairingCode}]` : '';
      return `${user.userId}${username}${displayName}${pairingCode}`;
    };

    const sendDiscordOverview = async () => {
      const lines = [
        '**Discord Management**',
        '',
        `Access: ${getDiscordAccessSummary(config)}`,
        `Admins: ${config.channels.discord.admins.length > 0 ? config.channels.discord.admins.map(formatDiscordUser).join(', ') : 'none'}`,
        `Members: ${config.channels.discord.members.length > 0 ? config.channels.discord.members.map(formatDiscordUser).join(', ') : 'none'}`,
        `Pending: ${config.channels.discord.pending.length > 0 ? config.channels.discord.pending.map(formatDiscordUser).join(', ') : 'none'}`,
        '',
        'Commands:',
        '\u2022 `/discord pending`',
        '\u2022 `/discord users`',
        '\u2022 `/discord approve <pairing-code|user-id>`',
        '\u2022 `/discord reject <user-id>`',
        '\u2022 `/discord remove <user-id>`',
        '\u2022 `/discord reset`',
      ];
      await channel.send(lines.join('\n'), channelId);
    };

    if (action === 'help' || action === 'status') {
      await sendDiscordOverview();
      return true;
    }

    if (action === 'pending') {
      const pending = config.channels.discord.pending;
      const lines = [
        '**Discord Pending Requests**',
        '',
        pending.length > 0 ? pending.map(formatDiscordUser).join('\n') : 'No pending Discord requests.',
      ];
      await channel.send(lines.join('\n'), channelId);
      return true;
    }

    if (action === 'users') {
      const lines = [
        '**Discord Approved Users**',
        '',
        `Admins: ${config.channels.discord.admins.length > 0 ? config.channels.discord.admins.map(formatDiscordUser).join(', ') : 'none'}`,
        `Members: ${config.channels.discord.members.length > 0 ? config.channels.discord.members.map(formatDiscordUser).join(', ') : 'none'}`,
        '',
        `Total approved: ${config.channels.discord.admins.length + config.channels.discord.members.length}`,
      ];
      await channel.send(lines.join('\n'), channelId);
      return true;
    }

    if (action === 'approve') {
      const value = parts[1];
      if (!value) {
        await channel.send('Usage: `/discord approve <pairing-code|user-id>`', channelId);
        return true;
      }

      let approved = approveDiscordPendingRequestByPairingCode(config, value);
      let resultLabel = value;

      if (!approved) {
        approved = approveDiscordPendingRequest(config, value, 'member');
        resultLabel = value;
      }

      if (!approved) {
        await channel.send(`No pending Discord request found for \`${resultLabel}\`.`, channelId);
        return true;
      }

      saveConfig(config);
      await channel.send(`Approved Discord user ${formatDiscordUser(approved)}.`, channelId);
      return true;
    }

    if (action === 'reject') {
      const value = parts[1];
      if (!value) {
        await channel.send('Usage: `/discord reject <user-id>`', channelId);
        return true;
      }

      const rejected = rejectDiscordPendingRequestConfig(config, value);
      if (!rejected) {
        await channel.send(`No pending Discord request found for \`${value}\`.`, channelId);
        return true;
      }

      saveConfig(config);
      await channel.send(`Rejected Discord request for ${formatDiscordUser(rejected)}.`, channelId);
      return true;
    }

    if (action === 'remove') {
      const value = parts[1];
      if (!value) {
        await channel.send('Usage: `/discord remove <user-id>`', channelId);
        return true;
      }

      const removed = removeDiscordUser(config, value);
      if (!removed) {
        await channel.send(`No approved Discord user found for \`${value}\`.`, channelId);
        return true;
      }

      saveConfig(config);
      await channel.send(`Removed Discord access for ${formatDiscordUser(removed)}.`, channelId);
      return true;
    }

    if (action === 'reset' || action === 'unpair') {
      clearDiscordAccess(config);
      saveConfig(config);
      await channel.send('Discord access reset. New users can send /start in a DM to begin pairing again.', channelId);
      return true;
    }

    await channel.send(
      `Unknown Discord command "${action}". Try \`/discord\`, \`/discord pending\`, or \`/discord users\`.`,
      channelId,
    );
    return true;
  }

  if (cmd.startsWith('/slack')) {
    if (channelType !== 'cli') {
      await channel.send('`/slack` is only available from the Mercury CLI chat.', channelId);
      return true;
    }

    const config = ctx.config();
    const rawSubcommand = trimmed.slice('/slack'.length).trim();
    const parts = rawSubcommand.split(/\s+/).filter(Boolean);
    const action = parts[0]?.toLowerCase() || 'help';
    const formatSlackUser = (user: {
      userId: string;
      userName?: string;
      displayName?: string;
      pairingCode?: string;
    }) => {
      const userName = user.userName ? ` (@${user.userName})` : '';
      const displayName = user.displayName ? ` ${user.displayName}` : '';
      const pairingCode = user.pairingCode ? ` [code: ${user.pairingCode}]` : '';
      return `${user.userId}${userName}${displayName}${pairingCode}`;
    };

    const sendSlackOverview = async () => {
      const lines = [
        '**Slack Management**',
        '',
        `Access: ${getSlackAccessSummary(config)}`,
        `Admins: ${config.channels.slack.admins.length > 0 ? config.channels.slack.admins.map(formatSlackUser).join(', ') : 'none'}`,
        `Members: ${config.channels.slack.members.length > 0 ? config.channels.slack.members.map(formatSlackUser).join(', ') : 'none'}`,
        `Pending: ${config.channels.slack.pending.length > 0 ? config.channels.slack.pending.map(formatSlackUser).join(', ') : 'none'}`,
        '',
        'Commands:',
        '\u2022 `/slack pending`',
        '\u2022 `/slack users`',
        '\u2022 `/slack approve <pairing-code|user-id>`',
        '\u2022 `/slack reject <user-id>`',
        '\u2022 `/slack remove <user-id>`',
        '\u2022 `/slack reset`',
      ];
      await channel.send(lines.join('\n'), channelId);
    };

    if (action === 'help' || action === 'status') {
      await sendSlackOverview();
      return true;
    }

    if (action === 'pending') {
      const pending = config.channels.slack.pending;
      const lines = [
        '**Slack Pending Requests**',
        '',
        pending.length > 0 ? pending.map(formatSlackUser).join('\n') : 'No pending Slack requests.',
      ];
      await channel.send(lines.join('\n'), channelId);
      return true;
    }

    if (action === 'users') {
      const lines = [
        '**Slack Approved Users**',
        '',
        `Admins: ${config.channels.slack.admins.length > 0 ? config.channels.slack.admins.map(formatSlackUser).join(', ') : 'none'}`,
        `Members: ${config.channels.slack.members.length > 0 ? config.channels.slack.members.map(formatSlackUser).join(', ') : 'none'}`,
        '',
        `Total approved: ${config.channels.slack.admins.length + config.channels.slack.members.length}`,
      ];
      await channel.send(lines.join('\n'), channelId);
      return true;
    }

    if (action === 'approve') {
      const value = parts[1];
      if (!value) {
        await channel.send('Usage: `/slack approve <pairing-code|user-id>`', channelId);
        return true;
      }

      let approved = approveSlackPendingRequestByPairingCode(config, value);
      let resultLabel = value;

      if (!approved) {
        approved = approveSlackPendingRequest(config, value, 'member');
        resultLabel = value;
      }

      if (!approved) {
        await channel.send(`No pending Slack request found for \`${resultLabel}\`.`, channelId);
        return true;
      }

      saveConfig(config);
      await channel.send(`Approved Slack user ${formatSlackUser(approved)}.`, channelId);
      return true;
    }

    if (action === 'reject') {
      const value = parts[1];
      if (!value) {
        await channel.send('Usage: `/slack reject <user-id>`', channelId);
        return true;
      }

      const rejected = rejectSlackPendingRequestConfig(config, value);
      if (!rejected) {
        await channel.send(`No pending Slack request found for \`${value}\`.`, channelId);
        return true;
      }

      saveConfig(config);
      await channel.send(`Rejected Slack request for ${formatSlackUser(rejected)}.`, channelId);
      return true;
    }

    if (action === 'remove') {
      const value = parts[1];
      if (!value) {
        await channel.send('Usage: `/slack remove <user-id>`', channelId);
        return true;
      }

      const removed = removeSlackUser(config, value);
      if (!removed) {
        await channel.send(`No approved Slack user found for \`${value}\`.`, channelId);
        return true;
      }

      saveConfig(config);
      await channel.send(`Removed Slack access for ${formatSlackUser(removed)}.`, channelId);
      return true;
    }

    if (action === 'reset' || action === 'unpair') {
      clearSlackAccess(config);
      saveConfig(config);
      await channel.send('Slack access reset. New users can send /mercury start in a DM to begin pairing again.', channelId);
      return true;
    }

    await channel.send(
      `Unknown Slack command "${action}". Try \`/slack\`, \`/slack pending\`, or \`/slack users\`.`,
      channelId,
    );
    return true;
  }

  if ((cmd === '/' || cmd === '/menu') && channelType === 'cli' && channel instanceof CLIChannel) {
    await agent.openCliCommandMenu(channel, channelId);
    return true;
  }

  if (cmd === '/tools') {
    const tools = ctx.toolNames();
    const grouped = [
      `**${tools.length} tools loaded:**`,
      '',
      ...tools.sort().map(t => `• \`${t}\``),
    ];
    await channel.send(grouped.join('\n'), channelId);
    return true;
  }

  if (cmd === '/skills' || cmd.startsWith('/skills ')) {
    await agent.handleSkillsSlashCommand(trimmed, channel, channelId, ctx);
    return true;
  }

  if (cmd.startsWith('/code')) {
    const rawArgs = trimmed.slice('/code'.length).trim().toLowerCase();
    const cliChannel = channelType === 'cli' && channel instanceof CLIChannel ? channel : null;

    if (!rawArgs) {
      if (cliChannel) {
        const cwd = agent.capabilities.getCwd();
        const entered = cliChannel.enterMercuryCode(cwd, cliChannel.getTuiState().version || 'dev');
        if (entered.ok) {
          // Keep the agent-side ProgrammingMode in sync with the TUI:
          // AUTO is the default Mercury Code flow (plan and build in one
          // pass). setProgrammingStatus pushes it to the TUI — the stale
          // 'plan' here was overriding the TUI's AUTO in the status bar.
          agent.programmingMode.setAuto();
          agent.programmingMode.setProjectContext(cwd);
          cliChannel.setProgrammingStatus(agent.programmingMode.getState(), agent.programmingMode.getProjectContext());
          // Plain message, not a heartbeat: entering /code starts no task,
          // so the TUI must not flip into a perpetual "Analyzing" spinner.
          // channel.send() also clears any stale heartbeat + isThinking.
          await channel.send('Mercury Code active (AUTO). Describe the change — I will plan and build in one flow, confirming with you only before large or consequential changes.', channelId);
          return true;
        }
        await channel.send(entered.message, channelId);
        return true;
      }
      await channel.send(agent.programmingMode.getStatusText(), channelId);
      return true;
    }

    if (rawArgs === 'exit' || rawArgs === 'quit') {
      if (cliChannel && cliChannel.getTuiState().mercuryCode) {
        // Arm the inline confirmation; the TUI resolves it (Esc cancels,
        // Enter/`y` confirms, Ctrl+D force-quits without asking).
        cliChannel.setMercuryCodeExitConfirm(true);
        return true;
      }
      agent.programmingMode.setOff();
      if (cliChannel) cliChannel.setProgrammingStatus(agent.programmingMode.getState(), agent.programmingMode.getProjectContext());
      await channel.send('Programming mode: **Off**\nBack to normal conversation mode.', channelId);
      return true;
    }

    if (rawArgs === 'status') {
      await channel.send(agent.programmingMode.getStatusText(), channelId);
      return true;
    }

    if (rawArgs === 'workspace' || rawArgs === 'ws') {
      if (!cliChannel) {
        await channel.send('Workspace IDE mode is currently available in CLI only.', channelId);
        return true;
      }
      const current = agent.capabilities.getCwd();
      const opened = cliChannel.openWorkspace(current);
      if (opened.ok) {
        agent.programmingMode.setExecute();
        cliChannel.setProgrammingStatus(agent.programmingMode.getState(), agent.programmingMode.getProjectContext());
        await channel.send(`${opened.message}\nWorkspace IDE mode enabled.`, channelId);
      } else {
        await channel.send(opened.message, channelId);
      }
      return true;
    }

    if (rawArgs === 'auto') {
      agent.programmingMode.setAuto();
      if (cliChannel) cliChannel.setProgrammingStatus(agent.programmingMode.getState(), agent.programmingMode.getProjectContext());
      await channel.send('Programming mode: **Auto**\nI plan and build in one flow — reading first, implementing immediately, and asking for confirmation only before large or consequential changes. Use `/code off` to exit.', channelId);
      return true;
    }

    if (rawArgs === 'plan') {
      agent.programmingMode.setPlan();
      if (cliChannel) cliChannel.setProgrammingStatus(agent.programmingMode.getState(), agent.programmingMode.getProjectContext());
      await channel.send('Programming mode: **Plan**\nI will explore, analyze, and present a plan before writing any code. Use `/code execute` or `/code auto` to switch to execution.', channelId);
      return true;
    }

    if (rawArgs === 'execute' || rawArgs === 'exec') {
      agent.programmingMode.setExecute();
      if (cliChannel) cliChannel.setProgrammingStatus(agent.programmingMode.getState(), agent.programmingMode.getProjectContext());
      await channel.send('Programming mode: **Execute**\nI will implement the plan step by step, verifying with builds/tests. Use `/code off` to exit.', channelId);
      return true;
    }

    if (rawArgs === 'build') {
      agent.programmingMode.setExecute();
      if (cliChannel) cliChannel.setProgrammingStatus(agent.programmingMode.getState(), agent.programmingMode.getProjectContext());
      await channel.send('Programming mode: **Build**\nExecution mode is active for implementation/build tasks.', channelId);
      return true;
    }

    if (rawArgs.startsWith('agent ') || rawArgs.startsWith('delegate ')) {
      if (!agent.supervisor) {
        await channel.send('Sub-agents are not enabled in this environment.', channelId);
        return true;
      }
      const taskDescription = rawArgs.replace(/^(agent|delegate)\s+/, '').trim();
      if (!taskDescription) {
        await channel.send('Usage: `/code agent <task>`', channelId);
        return true;
      }
      const cwd = agent.capabilities.getCwd();
      const agentId = await agent.supervisor.spawn({
        task: taskDescription,
        sourceChannelId: channelId,
        sourceChannelType: channelType as any,
        workingDirectory: cwd,
      });
      const bgId = agent.backgroundTasks.spawnAgent(taskDescription, cwd, agentId);
      agent.syncBgTasksToTui();
      await channel.send(`Started coding sub-agent ${agentId} in background task ${bgId}. Use /bg ${bgId} for progress.`, channelId);
      return true;
    }

    if (rawArgs === 'off') {
      agent.programmingMode.setOff();
      if (cliChannel) {
        if (cliChannel.getTuiState().mercuryCode) cliChannel.exitMercuryCode();
        cliChannel.setProgrammingStatus(agent.programmingMode.getState(), agent.programmingMode.getProjectContext());
      }
      await channel.send('Programming mode: **Off**\nBack to normal conversation mode.', channelId);
      return true;
    }

    if (rawArgs === 'toggle') {
      const newState = agent.programmingMode.toggle();
      const labels: Record<string, string> = { off: 'Off', auto: 'Auto', plan: 'Plan', execute: 'Execute' };
      if (cliChannel) cliChannel.setProgrammingStatus(agent.programmingMode.getState(), agent.programmingMode.getProjectContext());
      await channel.send(`Programming mode: **${labels[newState]}**`, channelId);
      return true;
    }

    if (rawArgs === 'init') {
      // Ask the agent itself to write/maintain AGENTS.md for this repo.
      await channel.send('Scanning the repository and writing AGENTS.md...', channelId);
      await agent.processInternalPrompt(
        'You are in Mercury Code (/code). Create or refresh the repo-level AGENTS.md in the current working directory. ' +
        'Read the repo structure: package manifests, build config, CI, test setup, directory layout. ' +
        'AGENTS.md must contain ONLY durable, verified facts you confirmed by reading files: build/test/lint commands, ' +
        'project layout, code conventions you actually observed, entry points. Keep it under 40 lines. ' +
        'If AGENTS.md already exists, merge-preserving accurate human edits and fixing stale commands.',
        channelId,
        channelType,
      );
      return true;
    }

    if (rawArgs === 'diff') {
      const cwd = agent.capabilities.getCwd();
      try {
        const { execFileSync } = await import('node:child_process');
        const diff = execFileSync('git', ['--no-pager', 'diff', '--no-color', 'HEAD'], { cwd, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
        const trimmedDiff = diff.length > 20000 ? diff.slice(-20000) : diff;
        if (!trimmedDiff.trim()) {
          await channel.send('Working tree is clean — no unstaged/staged changes vs HEAD.', channelId);
        } else {
          await channel.send('```\n' + trimmedDiff + '\n```', channelId);
        }
      } catch (err: any) {
        await channel.send(`git diff failed: ${err?.message || String(err)}`, channelId);
      }
      return true;
    }

    await channel.send('Unknown /code command. Available: /code, /code plan, /code execute, /code build, /code init, /code diff, /code expand, /code workspace, /code agent <task>, /code off, /code toggle, /code exit', channelId);
    return true;
  }

  if (cmd.startsWith('/research')) {
    const rawArgs = trimmed.slice('/research'.length).trim();

    if (!rawArgs || rawArgs.toLowerCase() === 'status') {
      await channel.send(agent.researchMode.getStatusText(), channelId);
      return true;
    }

    if (rawArgs.toLowerCase() === 'on') {
      agent.researchMode.setOn();
      await channel.send(
        'Research mode: **On**\nI will perform deep, multi-source web research and produce a full markdown research article. Long tasks are expected. Use `/research off` to exit.',
        channelId,
      );
      return true;
    }

    if (rawArgs.toLowerCase() === 'off') {
      agent.researchMode.setOff();
      await channel.send('Research mode: **Off**\nBack to normal conversation mode.', channelId);
      return true;
    }

    if (rawArgs.toLowerCase() === 'toggle') {
      const newState = agent.researchMode.toggle();
      await channel.send(`Research mode: **${newState === 'on' ? 'On' : 'Off'}**`, channelId);
      return true;
    }

    // Treat remaining args as a topic + enable research mode
    agent.researchMode.setOn(rawArgs);
    if (channel instanceof WebChannel) {
      channel.sendHeartbeat(`Research mode: On. Topic: ${rawArgs}. I will gather live sources and produce a full research article.`, channelId);
    } else {
      await channel.send(
        `Research mode: **On**\nTopic: ${rawArgs}\nI will gather live sources and produce a full research article. Use \`/research off\` to exit.`,
        channelId,
      );
    }
    // Enqueue the topic as a real user message so the agent immediately
    // begins researching it, rather than only setting mode + topic and
    // waiting for the user to repeat themselves.
    const researchTopicMsg: ChannelMessage = {
      id: `research-${Date.now().toString(36)}`,
      channelId,
      channelType: channelType as ChannelType,
      senderId: 'user',
      senderName: 'You',
      content: rawArgs,
      timestamp: Date.now(),
    };
    agent.enqueueMessage(researchTopicMsg);
    return true;
  }

  if (cmd.startsWith('/ws') || cmd.startsWith('/workspace')) {
    const cliChannel = channelType === 'cli' && channel instanceof CLIChannel ? channel : null;
    if (!cliChannel) {
      await channel.send('Workspace IDE mode is currently available in CLI only.', channelId);
      return true;
    }

    const base = cmd.startsWith('/workspace') ? '/workspace' : '/ws';
    const rawArgs = trimmed.slice(base.length).trim();
    const rawLower = rawArgs.toLowerCase();

    if (!rawArgs || rawLower === 'status') {
      const ws = cliChannel.getWorkspace();
      await channel.send(ws?.active ? `Workspace active: ${ws.rootPath}` : 'No active workspace. Use `/ws open <path>`.', channelId);
      return true;
    }

    if (rawLower.startsWith('open ')) {
      const target = rawArgs.slice(5).trim();
      const opened = cliChannel.openWorkspace(target);
      if (opened.ok) {
        agent.capabilities.setCwd(path.resolve(target.replace(/^~(?=$|\/)/, process.env.HOME || '~')));
        agent.capabilities.permissions.addTempScope(agent.capabilities.getCwd(), true, true);
        agent.programmingMode.setExecute();
        agent.programmingMode.setProjectContext(agent.capabilities.getCwd());
        cliChannel.setProgrammingStatus(agent.programmingMode.getState(), agent.programmingMode.getProjectContext());
        await channel.send(`${opened.message}\nWorkspace IDE is ready.`, channelId);
      } else {
        await channel.send(opened.message, channelId);
      }
      return true;
    }

    if (rawLower === 'refresh') {
      cliChannel.refreshWorkspace();
      await channel.send('Workspace refreshed.', channelId);
      return true;
    }

    if (rawLower.startsWith('stage ')) {
      const fileArg = rawArgs.slice(6).trim();
      const result = cliChannel.stageWorkspaceFile(fileArg || 'all');
      await channel.send(result.message, channelId);
      return true;
    }

    if (rawLower.startsWith('commit ')) {
      const message = rawArgs.slice(7).trim();
      const result = cliChannel.commitWorkspace(message);
      await channel.send(result.message, channelId);
      return true;
    }

    if (rawLower.startsWith('undo ')) {
      const fileArg = rawArgs.slice(5).trim();
      const result = cliChannel.undoWorkspaceFile(fileArg);
      await channel.send(result.message, channelId);
      return true;
    }

    if (rawLower === 'help') {
      await channel.send('Workspace commands:\n`/ws open <path>`\n`/ws refresh`\n`/ws stage <file|all>`\n`/ws commit <message>`\n`/ws undo <file>`\n`/ws status`', channelId);
      return true;
    }

    await channel.send('Unknown workspace command. Use `/ws help`.', channelId);
    return true;
  }

  if (cmd.startsWith('/spotify')) {
    if (!agent.spotifyClient) {
      await channel.send('Spotify is not connected. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in your config, then run /spotify auth.', channelId);
      return true;
    }
    const rawArgs = trimmed.slice('/spotify'.length).trim().toLowerCase();

    if (!rawArgs || rawArgs === 'status') {
      const auth = agent.spotifyClient.isAuthenticated() ? 'Connected' : 'Not connected';
      const device = agent.spotifyClient.getDeviceId() || 'none';

      let accountName = agent.spotifyClient.getAccountName();
      let accountId = agent.spotifyClient.getAccountId();
      let product = agent.spotifyClient.getProduct();
      let accountError = '';

      if (!accountName) {
        try {
          await agent.spotifyClient.saveAccountInfo();
          accountName = agent.spotifyClient.getAccountName();
          accountId = agent.spotifyClient.getAccountId();
          product = agent.spotifyClient.getProduct();
        } catch (err: any) {
          accountError = err.message;
          logger.warn({ err: err.message }, 'Failed to fetch Spotify account info');
        }
      }

      let premium = agent.spotifyClient.getPremiumStatus();
      if (premium === null) {
        premium = await agent.spotifyClient.checkPremium();
      }

      let status = `Spotify: **${auth}**`;
      if (accountName) status += `\nAccount: **${accountName}**`;
      if (accountId) status += `\nUser ID: ${accountId}`;
      if (product) status += `\nPlan: ${product}`;
      if (premium === true) {
        status += ' — all features available';
      } else if (premium === false) {
        status += ' — playback control requires Premium';
      }
      if (accountError) status += `\n⚠ Could not verify account: ${accountError}`;
      status += `\nDevice: ${device !== 'none' ? device : 'none selected'}`;
      await channel.send(status, channelId);
      return true;
    }

    if (rawArgs === 'auth') {
      if (channelType === 'cli' && channel instanceof CLIChannel) {
        try {
          const choice = await channel.withMenu(async (select) => {
            return select('Spotify Authorization', [
              { value: 'browser', label: 'Open browser (recommended)' },
              { value: 'manual', label: 'Paste authorization code manually' },
              { value: 'cancel', label: 'Cancel' },
            ]);
          });
          if (!choice || choice === 'cancel') {
            await channel.send('Spotify auth cancelled.', channelId);
            return true;
          }
          if (choice === 'manual') {
            const authUrl = agent.spotifyClient.getAuthUrl();
            await channel.send('1. Open this URL in your browser:\n' + authUrl + '\n\n2. After authorizing, you will be redirected to localhost — it may show an error page, that is OK.\n3. Copy the `code` parameter from the URL in your browser address bar.\n4. Paste it below:', channelId);
            const code = await channel.prompt('Authorization code: ');
            if (!code || !code.trim()) {
              await channel.send('No code provided. Auth cancelled.', channelId);
              return true;
            }
            await agent.spotifyClient.authenticateWithCode(code.trim());
            await channel.send('Spotify connected successfully! Try: play some music', channelId);
          } else {
            await channel.send(`Opening browser for Spotify authorization...\nIf it doesn't open, visit ${agent.spotifyClient.getLocalLoginUrl()}`, channelId);
            await agent.spotifyClient.authenticate();
            await channel.send('Spotify connected successfully! Try: play some music', channelId);
          }
        } catch (err: any) {
          await channel.send(`Spotify auth failed: ${err.message}`, channelId);
        }
      } else {
        const authUrl = agent.spotifyClient.getAuthUrl();
        await channel.send(
          '**Connect Spotify**\n\n1. Open this URL on any device with a browser:\n' + authUrl + '\n\n2. After authorizing, you will be redirected to localhost — that page may show an error, that is OK.\n3. Copy the `code` from the URL, then type:\n`/spotify code <paste-code-here>`',
          channelId
        );
      }
      return true;
    }

    if (rawArgs.startsWith('code ')) {
      const code = rawArgs.slice('code '.length).trim();
      if (!code) {
        await channel.send('Usage: /spotify code <authorization-code>', channelId);
        return true;
      }
      try {
        await agent.spotifyClient.authenticateWithCode(code);
        await channel.send('Spotify connected successfully! Try: play some music', channelId);
      } catch (err: any) {
        await channel.send(`Spotify auth failed: ${err.message}`, channelId);
      }
      return true;
    }

    if (rawArgs === 'devices') {
      try {
        const data = await agent.spotifyClient.getDevices();
        if (!data?.devices?.length) { await channel.send('No active devices. Open Spotify on a device first.', channelId); return true; }
        const lines = ['**Spotify Devices:**\n'];
        for (const d of data.devices) {
          lines.push(`${d.is_active ? '▶' : '○'} **${d.name}** (${d.type}) — \`${d.id}\`${d.is_active ? ' [active]' : ''}`);
        }
        await channel.send(lines.join('\n'), channelId);
      } catch (err: any) { await channel.send(`Failed: ${err.message}`, channelId); }
      return true;
    }

    if (rawArgs.startsWith('device ')) {
      const id = rawArgs.slice('device '.length).trim();
      agent.spotifyClient.setDevice(id);
      await channel.send(`Active device set to: ${id}`, channelId);
      return true;
    }

    if (rawArgs === 'player' && channelType === 'cli' && channel instanceof CLIChannel) {
      await channel.withMenu(async (select) => {
        while (true) {
          try {
            const np = await agent.spotifyClient!.getCurrentlyPlaying();
            if (np) {
              await channel.send(formatNowPlaying(np), channelId);
            }
          } catch {}
          const action = await select('Spotify Player', PLAYER_CONTROLS);
          if (action === 'exit' || !action) return;
          if (action === 'search') {
            const query = await channel.prompt('Search: ');
            if (!query) continue;
            try {
              const results = await agent.spotifyClient!.search(query, 'track', 5);
              const tracks = results?.tracks?.items || [];
              if (tracks.length === 0) { await channel.send('No results found.', channelId); continue; }
              const trackOptions = tracks.map((t: any, i: number) => ({
                value: t.uri,
                label: `${t.artists?.map((a: any) => a.name).join(', ')} — ${t.name}`,
              }));
              const picked = await select('Play which track?', [...trackOptions, { value: 'back', label: 'Back' }]);
              if (picked && picked !== 'back') {
                await agent.spotifyClient!.play([picked]);
              }
            } catch (err: any) { await channel.send(`Search failed: ${err.message}`, channelId); }
            continue;
          }
          if (action === 'volume') {
            const vol = await channel.prompt('Volume (0-100): ');
            const n = parseInt(vol, 10);
            if (!isNaN(n) && n >= 0 && n <= 100) {
              await agent.spotifyClient!.setVolume(n);
              await channel.send(`Volume: ${n}%`, channelId);
            }
            continue;
          }
          if (action === 'queue') {
            const query = await channel.prompt('Search track to queue: ');
            if (!query) continue;
            try {
              const results = await agent.spotifyClient!.search(query, 'track', 5);
              const tracks = results?.tracks?.items || [];
              if (tracks.length === 0) { await channel.send('No results.', channelId); continue; }
              const trackOptions = tracks.map((t: any) => ({
                value: t.uri,
                label: `${t.artists?.map((a: any) => a.name).join(', ')} — ${t.name}`,
              }));
              const picked = await select('Queue which track?', [...trackOptions, { value: 'back', label: 'Back' }]);
              if (picked && picked !== 'back') {
                await agent.spotifyClient!.addToQueue(picked);
                await channel.send('Added to queue.', channelId);
              }
            } catch (err: any) { await channel.send(`Failed: ${err.message}`, channelId); }
            continue;
          }
          try {
            const result = await handlePlayerAction(action, agent.spotifyClient!);
            await channel.send(result, channelId);
          } catch (err: any) {
            await channel.send(`Failed: ${err.message}`, channelId);
          }
        }
      });
      return true;
    }

    if (rawArgs === 'now' || rawArgs === 'playing' || rawArgs === 'np') {
      try {
        const text = await agent.spotifyClient.getNowPlayingText();
        await channel.send(text, channelId);
      } catch (err: any) { await channel.send(`Failed: ${err.message}`, channelId); }
      return true;
    }

    if (rawArgs === 'logout') {
      agent.spotifyClient.logout();
      await channel.send('Spotify disconnected. Run `/spotify auth` to reconnect.', channelId);
      return true;
    }

    await channel.send('Unknown /spotify command. Available: /spotify, /spotify auth, /spotify code <code>, /spotify logout, /spotify player, /spotify devices, /spotify device <id>, /spotify now', channelId);
    return true;
  }

  if (cmd === '/stream on') {
    agent.telegramStreaming = true;
    await channel.send('Telegram streaming enabled. Responses will appear progressively.', channelId);
    return true;
  }

  if (cmd === '/stream off') {
    agent.telegramStreaming = false;
    await channel.send('Telegram streaming disabled. Responses will arrive as a single message.', channelId);
    return true;
  }

  if (cmd === '/stream') {
    agent.telegramStreaming = !agent.telegramStreaming;
    await channel.send(
      agent.telegramStreaming
        ? 'Telegram streaming enabled. Responses will appear progressively.'
        : 'Telegram streaming disabled. Responses will arrive as a single message.',
      channelId,
    );
    return true;
  }
  if (cmd === '/stream off') {
    agent.telegramStreaming = false;
    await channel.send('Telegram streaming disabled. Responses will arrive as a single message.', channelId);
    return true;
  }

  if (cmd.startsWith('/agents')) {
    if (!agent.supervisor) {
      await channel.send('Sub-agents are not available.', channelId);
      return true;
    }
    const rawArgs = trimmed.slice('/agents'.length).trim();

    if (!rawArgs) {
      const agents = agent.supervisor.getActiveAgents();
      const resourceInfo = agent.supervisor.getResourceUsage();
      if (agents.length === 0) {
        await channel.send(`No active sub-agents.\nMax concurrent: ${resourceInfo.maxConcurrentAgents} (auto) | CPU: ${resourceInfo.cpuCores} cores`, channelId);
        return true;
      }
      const statusIcons: Record<string, string> = { pending: '🔵', running: '🟢', paused: '🟡', completed: '✅', failed: '❌', halted: '⛔' };
      const lines = [`**Sub-Agents** (${agents.length})`, ''];
      for (const agent of agents) {
        const icon = statusIcons[agent.status] || '❓';
        const taskPreview = agent.task.length > 40 ? agent.task.slice(0, 40) + '...' : agent.task;
        lines.push(`${icon} **${agent.id}**  ${taskPreview}`);
        if (agent.progress) lines.push(`   ${agent.progress}`);
      }
      lines.push('');
      lines.push(`Max concurrent: ${resourceInfo.maxConcurrentAgents} (auto) | CPU: ${resourceInfo.cpuCores} cores`);
      lines.push(`Active: ${resourceInfo.activeAgents} | Queued: ${resourceInfo.queuedAgents}`);
      await channel.send(lines.join('\n'), channelId);
      return true;
    }

    const parts = rawArgs.split(/\s+/);
    const action = parts[0]?.toLowerCase();

    if (action === 'stop') {
      const target = parts[1]?.toLowerCase();
      if (!target) {
        await channel.send('Usage: /agents stop <id> or /agents stop all', channelId);
        return true;
      }
      if (target === 'all') {
        await agent.supervisor.haltAll();
        await channel.send('All sub-agents halted. They will finish their current tool step before stopping.', channelId);
      } else {
        const halted = await agent.supervisor.halt(target);
        if (!halted) {
          await channel.send(`No active agent found with ID "${target}".`, channelId);
        } else {
          await channel.send(`Agent ${target} halt signal sent. It will finish its current step then stop.`, channelId);
        }
      }
      return true;
    }

    if (action === 'pause') {
      const target = parts[1]?.toLowerCase();
      if (!target) {
        await channel.send('Usage: /agents pause <id>', channelId);
        return true;
      }
      const paused = await agent.supervisor.pause(target);
      await channel.send(paused ? `Agent ${target} paused. Use /agents resume ${target} to continue.` : `No running agent found with ID "${target}".`, channelId);
      return true;
    }

    if (action === 'resume') {
      const target = parts[1]?.toLowerCase();
      if (!target) {
        await channel.send('Usage: /agents resume <id>', channelId);
        return true;
      }
      const resumed = await agent.supervisor.resume(target);
      await channel.send(resumed ? `Agent ${target} resumed.` : `No paused agent found with ID "${target}".`, channelId);
      return true;
    }

    if (action === 'config') {
      const info = agent.supervisor.getResourceUsage();
      const lines = [
        '**Sub-Agent Configuration**',
        `CPU cores: ${info.cpuCores}`,
        `System RAM: ${info.systemMemoryMB}MB`,
        `Available RAM: ${info.availableMemoryMB}MB`,
        `Max concurrent: ${info.maxConcurrentAgents}`,
        `Active agents: ${info.activeAgents}`,
        `Queued agents: ${info.queuedAgents}`,
        `Token budget remaining: ${info.tokenBudgetRemaining.toLocaleString()}`,
      ];
      await channel.send(lines.join('\n'), channelId);
      return true;
    }

    if (action === 'set' && parts[1]?.toLowerCase() === 'max') {
      const n = parseInt(parts[2], 10);
      if (isNaN(n) || n < 1) {
        await channel.send('Usage: /agents set max <number>', channelId);
        return true;
      }
      agent.supervisor.setMaxConcurrent(n);
      await channel.send(`Max concurrent sub-agents set to ${n}.`, channelId);
      return true;
    }

    await channel.send(`Unknown /agents command "${action}". Available: /agents, /agents stop <id|all>, /agents pause <id>, /agents resume <id>, /agents config, /agents set max <n>`, channelId);
    return true;
  }

  if (cmd === '/halt') {
    if (!agent.supervisor) {
      await channel.send('Sub-agents are not available.', channelId);
      return true;
    }
    await agent.supervisor.haltAll();
    await channel.send('All sub-agents halted and queue cleared.', channelId);
    return true;
  }

  if (cmd === '/stop') {
    if (!agent.supervisor) {
      await channel.send('Sub-agents are not available.', channelId);
      return true;
    }
    await agent.supervisor.haltAll();
    agent.supervisor.clearTaskBoard();
    agent.lifecycle.transition('idle');
    await channel.send('All sub-agents stopped, queue cleared, locks released, task board cleared. Short-term memory preserved.', channelId);
    return true;
  }

  if (cmd === '/reset') {
    if (channelType === 'cli' && channel instanceof CLIChannel) {
      const confirmed = await channel.askToContinue(
        '⚠ /reset will halt ALL agents, clear queues, release locks, clear task board, and wipe conversation context. Continue? (y/n)',
        channelId,
      ).catch(() => false);
      if (!confirmed) {
        await channel.send('Reset cancelled.', channelId);
        return true;
      }
    }
    if (agent.supervisor) {
      await agent.supervisor.haltAll();
      agent.supervisor.clearTaskBoard();
    }
    agent.shortTerm.clearAll();
    agent.lifecycle.transition('idle');
    await channel.send('Mercury reset. All agents stopped, all state cleared. Long-term memory preserved. Ready for a fresh start.', channelId);
    return true;
  }

  return false;
}
