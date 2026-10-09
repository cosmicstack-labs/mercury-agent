/**
 * The /saver token-saver command.
 * Moved out of Agent (P2.1 split); `agent` is the Agent instance.
 */
import type { Agent } from '../agent.js';


export async function handleSaverCommand(agent: Agent, subcommand: string, channelType: string, channelId: string): Promise<void> {
  const channel = agent.channels.get(channelType as any);
  if (!channel) return;

  const parts = subcommand.trim().split(/\s+/).filter(Boolean);
  const action = (parts[0] || '').toLowerCase();
  const arg = (parts[1] || '').toLowerCase();

  const showStatus = async () => {
    const text = agent.saverMode.getStatusText(
      agent.tokenBudget.getSavedLifetime(),
      agent.tokenBudget.getSavedToday(),
    );
    const usagePct = Math.round(agent.tokenBudget.getUsagePercentage());
    await channel.send(`${text}\nCurrent daily usage: ${usagePct}%`, channelId);
    agent.syncSaverToCli();
  };

  if (!action || action === 'status' || action === 'stats') {
    await showStatus();
    return;
  }

  if (action === 'on' || action === 'enable') {
    agent.saverMode.enable();
    await channel.send(
      '⚡ Token Saver Mode enabled. Responses will be terser, step limits lower, and history window shorter to conserve tokens.',
      channelId,
    );
    agent.syncSaverToCli();
    return;
  }

  if (action === 'off' || action === 'disable') {
    agent.saverMode.disable();
    await channel.send('Token Saver Mode disabled. Normal response settings restored.', channelId);
    agent.syncSaverToCli();
    return;
  }

  if (action === 'toggle') {
    const next = agent.saverMode.toggle();
    await channel.send(
      next === 'on'
        ? '⚡ Token Saver Mode enabled.'
        : 'Token Saver Mode disabled.',
      channelId,
    );
    agent.syncSaverToCli();
    return;
  }

  if (action === 'threshold') {
    const n = parseInt(parts[1], 10);
    if (isNaN(n) || n < 0 || n > 100) {
      await channel.send('Usage: /saver threshold <0-100> — percentage of daily budget at which saver auto-engages. Set 0 to disable.', channelId);
      return;
    }
    agent.saverMode.setAutoThreshold(n);
    await channel.send(
      n === 0
        ? 'Saver auto-engage disabled (threshold set to 0).'
        : `Saver auto-engage threshold set to ${n}% of daily budget.`,
      channelId,
    );
    return;
  }

  if (action === 'auto') {
    if (arg === 'on' || arg === 'enable') {
      agent.saverMode.setAutoEnabled(true);
      await channel.send(`Saver auto-engage enabled (at ${agent.saverMode.getAutoThreshold()}% usage).`, channelId);
    } else if (arg === 'off' || arg === 'disable') {
      agent.saverMode.setAutoEnabled(false);
      await channel.send('Saver auto-engage disabled. Saver will only activate when you run /saver on.', channelId);
      agent.syncSaverToCli();
    } else {
      await channel.send(
        `Saver auto-engage is currently ${agent.saverMode.isAutoEnabled() ? 'ON' : 'OFF'} (threshold: ${agent.saverMode.getAutoThreshold()}%).\nUse /saver auto on|off to change.`,
        channelId,
      );
    }
    return;
  }

  if (action === 'routing') {
    if (arg === 'on' || arg === 'enable') {
      agent.saverMode.setRoutingEnabled(true);
      await channel.send('Saver cheap-provider routing enabled (when saver is active, cheaper providers will be preferred).', channelId);
    } else if (arg === 'off' || arg === 'disable') {
      agent.saverMode.setRoutingEnabled(false);
      await channel.send('Saver cheap-provider routing disabled.', channelId);
    } else {
      await channel.send(`Saver cheap-provider routing is currently ${agent.saverMode.isRoutingEnabled() ? 'ON' : 'OFF'}.\nUse /saver routing on|off to change.`, channelId);
    }
    return;
  }

  await channel.send(
    'Unknown saver command. Available:\n' +
    '  /saver — show status and savings\n' +
    '  /saver on — manually enable\n' +
    '  /saver off — disable\n' +
    '  /saver toggle — flip on/off\n' +
    '  /saver threshold <0-100> — auto-engage threshold (default 75)\n' +
    '  /saver auto on|off — enable/disable auto-engagement\n' +
    '  /saver routing on|off — prefer cheap providers while active (opt-in)',
    channelId,
  );
}
