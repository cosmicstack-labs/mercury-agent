/**
 * The /bg background-task command.
 * Moved out of Agent (P2.1 split); `agent` is the Agent instance.
 */
import type { Agent } from '../agent.js';
import type { ChannelMessage, ChannelType } from '../../types/channel.js';


export async function handleBgCommand(agent: Agent, trimmed: string, msg: ChannelMessage, channel: any): Promise<void> {
  const parts = trimmed.trim().split(/\s+/);
  const sub = parts.length > 1 ? parts[1] : '';
  const args = parts.slice(1).join(' ');

  if (sub === 'current') {
    if (!agent.processing || !agent.currentMessage) {
      await channel.send('No active task to background.', msg.channelId);
      return;
    }
    const taskDescription = agent.currentMessage.content.trim();
    const sourceChannelId = agent.currentMessage.channelId;
    const sourceChannelType = agent.currentMessage.channelType as any;

    if (agent.currentAbort) {
      agent.currentAbortReason = 'backgrounded';
      agent.currentAbort.abort();
    }

    if (agent.supervisor) {
      const agentId = await agent.supervisor.spawn({
        task: taskDescription,
        sourceChannelId,
        sourceChannelType,
      });
      const bgId = agent.backgroundTasks.spawnAgent(taskDescription, agent.capabilities.getCwd(), agentId);
      await channel.send(`📋 Active task moved to background as ${bgId}. I'll notify you when it completes.`, msg.channelId);
    } else {
      await channel.send('Cannot background: sub-agents not available. The active task has been aborted.', msg.channelId);
    }

    agent.syncBgTasksToTui();
    return;
  }

  if (sub === 'list' || sub === '' || sub === 'ls') {
    const tasks = agent.backgroundTasks.getAllSummaries();
    if (tasks.length === 0) {
      await channel.send('No background tasks.', msg.channelId);
      return;
    }
    const lines = tasks.map((t) => {
      const icon = t.status === 'running' ? '⏳' : t.status === 'completed' ? '✅' : t.status === 'failed' ? '❌' : t.status === 'timed_out' ? '⏱' : '⛔';
      const label = t.command || t.task || t.id;
      const elapsed = t.runningMs ? ` (${Math.round(t.runningMs / 1000)}s)` : t.completedAt ? ` (${((t.completedAt - t.startedAt) / 1000).toFixed(1)}s)` : '';
      const short = label.length > 60 ? label.slice(0, 57) + '...' : label;
      return `${icon} ${t.id}: ${short}${elapsed} — ${t.status}`;
    });
    await channel.send(`**Background Tasks:**\n${lines.join('\n')}\n\nUse /bg <id> for details, /bg cancel <id> to cancel, /bg clear to prune completed tasks.`, msg.channelId);
    return;
  }

  if (sub === 'clear') {
    const cleared = agent.backgroundTasks.clearCompleted();
    await channel.send(`Cleared ${cleared} completed task(s).`, msg.channelId);
    agent.syncBgTasksToTui();
    return;
  }

  if (sub === 'cancel' || sub === 'stop' || sub === 'kill') {
    const taskId = parts[2];
    if (!taskId) {
      await channel.send(`Usage: /bg ${sub} <id>`, msg.channelId);
      return;
    }
    const cancelled = agent.backgroundTasks.cancel(taskId);
    if (cancelled) {
      await channel.send(`⛔ Stopped background task ${taskId}.`, msg.channelId);
    } else {
      await channel.send(`Task "${taskId}" not found or not running.`, msg.channelId);
    }
    agent.syncBgTasksToTui();
    return;
  }

  if (sub === 'killall' || sub === 'stopall') {
    const count = agent.backgroundTasks.cancelAll();
    if (count === 0) {
      await channel.send('No running background tasks to stop.', msg.channelId);
    } else {
      await channel.send(`⛔ Stopped ${count} background task${count === 1 ? '' : 's'}.`, msg.channelId);
    }
    agent.syncBgTasksToTui();
    return;
  }

  const specificTask = agent.backgroundTasks.getSummary(sub);
  if (specificTask) {
    const task = agent.backgroundTasks.get(sub)!;
    const label = task.command || task.task || task.id;
    const elapsed = task.status === 'running'
      ? `Running for ${Math.round((Date.now() - task.startedAt) / 1000)}s`
      : task.completedAt
        ? `Completed in ${((task.completedAt - task.startedAt) / 1000).toFixed(1)}s`
        : task.status;
    const output = (task.stdout + '\n' + task.stderr).trim();
    const preview = output.length > 2000 ? output.slice(-2000) : output;
    await channel.send(`**${specificTask.id}**: ${label}\nStatus: ${elapsed}\nExit code: ${task.exitCode ?? 'N/A'}\n\n${preview || '(no output)'}`, msg.channelId);
    return;
  }

  const colonIdx = trimmed.indexOf(':');
  if (colonIdx !== -1 && trimmed[colonIdx + 1] === ' ') {
    const taskDescription = trimmed.slice(colonIdx + 1).trim();
    if (!taskDescription) {
      await channel.send('Usage: /bg: <natural language task> or /bg <shell command>', msg.channelId);
      return;
    }
    if (!agent.supervisor) {
      await channel.send('Sub-agents are not available. Use /bg <command> for shell commands.', msg.channelId);
      return;
    }
    const agentId = await agent.supervisor.spawn({
      task: taskDescription,
      sourceChannelId: msg.channelId,
      sourceChannelType: msg.channelType as any,
    });
    const bgId = agent.backgroundTasks.spawnAgent(taskDescription, agent.capabilities.getCwd(), agentId);
    agent.backgroundTasks.registerComplete(bgId, (task) => {
      if (task.status === 'running') return;
    });
    await channel.send(`📋 Background agent ${bgId} started: "${taskDescription.slice(0, 50)}${taskDescription.length > 50 ? '...' : ''}"`, msg.channelId);
    agent.syncBgTasksToTui();
    return;
  }

  const command = args || '';
  if (!command) {
    await channel.send('Usage:\n• /bg <command> — run a shell command in the background\n• /bg: <task> — delegate an LLM task to the background\n• /bg current — move the active task to the background\n• /bg list — show all background tasks\n• /bg <id> — show task details\n• /bg stop <id> — stop a running task\n• /bg killall — stop all running tasks\n• /bg clear — prune completed tasks', msg.channelId);
    return;
  }

  // `/bg <command>` is an alternate shell entry point: it must honor the
  // same approval boundary as the run_command tool, otherwise an
  // authenticated chat user can bypass Ask-Me approval and run arbitrary
  // commands. checkShellCommand() also enforces the blocked list and any
  // cwd/scope containment rules.
  const check = await agent.capabilities.permissions.checkShellCommand(command);
  if (!check.allowed) {
    await channel.send(`⛔ Not running in background: ${check.reason ?? 'command requires approval'}\nApprove the command first (or run it without /bg) and try again.`, msg.channelId);
    return;
  }

  const cwd = agent.capabilities.getCwd();
  const bgId = agent.backgroundTasks.spawnShell(command, cwd);
  await channel.send(`📋 Background task ${bgId} started: "${command.slice(0, 50)}${command.length > 50 ? '...' : ''}"`, msg.channelId);
  agent.syncBgTasksToTui();
}
