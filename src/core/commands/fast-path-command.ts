/**
 * Fast-path commands answered without a model call.
 * Moved out of Agent (P2.1 split); `agent` is the Agent instance.
 */
import type { Agent } from '../agent.js';
import { MAX_STEPS } from '../agent.js';
import type { ChannelMessage, ChannelType } from '../../types/channel.js';
import path from 'node:path';
import { formatToolStep, formatNarrative, type NarrativeStep } from '../../utils/tool-label.js';
import { handleBotsCommand as handleBotsCommandImpl } from '../commands/bots-command.js';
import { handleBgCommand as handleBgCommandImpl } from '../commands/bg-command.js';
import { handleSessionCommand as handleSessionCommandImpl } from '../commands/session-command.js';

export async function handleFastPathCommand(agent: Agent, msg: ChannelMessage): Promise<void> {
  const trimmed = msg.content.trim();
  const channel = agent.channels.getChannelForMessage(msg);
  if (!channel) return;

  const activeAgents = agent.supervisor ? agent.supervisor.getActiveAgents() : [];
  const hasActiveAgents = activeAgents.length > 0;
  const busyPrefix = hasActiveAgents ? '' : '';

  if (trimmed === '/sessions' || trimmed.startsWith('/session')) {
    await agent.handleSessionCommand(trimmed, msg.channelType, msg.channelId);
    return;
  }

  if (trimmed === '/agents' || trimmed === '/status') {
    if (agent.supervisor) {
      const agents = agent.supervisor.getActiveAgents();
      if (agents.length === 0) {
        await channel.send('No active sub-agents.', msg.channelId);
      } else {
        let text = '**Sub-Agents:**\n\n';
        for (const a of agents) {
          const icon = a.status === 'running' ? '🔄' : a.status === 'pending' ? '⏳' : a.status === 'completed' ? '✅' : '❌';
          text += `${icon} **${a.id}**: ${a.task.slice(0, 60)}${a.task.length > 60 ? '...' : ''} — ${a.status}${a.progress ? ` (${a.progress})` : ''}\n`;
        }
        await channel.send(text, msg.channelId);
      }
    } else {
      await channel.send('Sub-agents not enabled.', msg.channelId);
    }
    return;
  }

  if (trimmed === '/halt' || trimmed === '/stop') {
    await channel.send(await agent.stopAllWork(trimmed === '/stop' ? 'stopped' : 'halted'), msg.channelId);
    return;
  }

  // Bots run outside the main queue — /bots commands are always fast-path.
  if (trimmed.startsWith('/bots')) {
    await agent.handleBotsCommand(trimmed, msg, channel);
    return;
  }

  if (trimmed.startsWith('/bg')) {
    await agent.handleBgCommand(trimmed, msg, channel);
    return;
  }

  if (trimmed === '/progress' || trimmed === '/still') {
    if (!agent.processing || !agent.currentMessage) {
      await channel.send('No active foreground task.', msg.channelId);
      return;
    }
    const elapsedSec = Math.round((Date.now() - agent.currentMessage.timestamp) / 1000);
    const stepInfo = agent.completedStepCount > 0 ? ` · step ${agent.completedStepCount}/${MAX_STEPS}` : '';
    const narrative = formatNarrative(agent.stepNarrative, agent.currentActivity, 10);
    const narrativeBlock = narrative ? `\n${narrative}` : '';
    await channel.send(
      `⏳ Task in progress (${elapsedSec}s${stepInfo})${narrativeBlock}\nUse /bg current to move it to background.`,
      msg.channelId,
    );
    return;
  }

  if (trimmed === '/help') {
    await channel.send('Agent is busy. Available: /sessions, /session, /agents, /halt, /stop, /progress, /spotify, /code, /research, /memory, /bg', msg.channelId);
    return;
  }

  if (trimmed.startsWith('/spotify')) {
    await agent.handleFastPathSpotify(trimmed, msg, channel);
    return;
  }

  if (trimmed.startsWith('/code')) {
    await agent.handleFastPathCode(trimmed, msg, channel);
    return;
  }

  if (trimmed === '/memory') {
    await channel.send('Agent is busy. Memory management will be available after current task completes.', msg.channelId);
    return;
  }

  if (hasActiveAgents) {
    const agentList = activeAgents.map(a => `**${a.id}**: ${a.task.slice(0, 40)}`).join(', ');
    await channel.send(`I'm busy working on sub-agent tasks (${agentList}). Your message has been queued — I'll respond once I'm free. Use /agents to check status.`, msg.channelId);
  } else {
    const elapsedSec = agent.currentMessage ? Math.round((Date.now() - agent.currentMessage.timestamp) / 1000) : 0;
    await channel.send(`I'm busy processing${elapsedSec > 0 ? ` (${elapsedSec}s elapsed)` : ''}. Use /progress for live status or /bg current to move this task to the background.`, msg.channelId);
  }

  agent.queueMessage(msg);
}
