/**
 * The /session and /sessions commands (list, new, switch, archive, delete).
 * Moved out of Agent (P2.1 split); `agent` is the Agent instance.
 */
import type { Agent } from '../agent.js';
import type { ChannelMessage, ChannelType } from '../../types/channel.js';
import { CLIChannel } from '../../channels/cli.js';
import { normalizeGeneratedSessionTitle, SessionResolutionError, type SessionRepository } from '../../sessions/index.js';

export async function handleSessionCommand(agent: Agent, content: string, channelType: ChannelType, channelId: string): Promise<void> {
  const channel = agent.channels.get(channelType);
  if (!channel) return;
  const bindingId = channelType === 'cli' ? 'current' : channelId;
  const format = (session: { alias: string; shortId: string; title: string }) => `${session.alias}  [${session.shortId}]  ${session.title}`;
  const transcript = (session: ReturnType<SessionRepository['get']>) => {
    const recent = session.messages
      .filter((message) => message.kind === 'message' && (message.role === 'user' || message.role === 'assistant'))
      .slice(-8);
    if (recent.length === 0) return 'No messages yet.';
    return recent.map((message) => {
      const label = message.role === 'user' ? 'You' : 'Mercury';
      const text = message.content.replace(/\s+/g, ' ').trim();
      return `${label}: ${text.length > 280 ? `${text.slice(0, 277)}...` : text}`;
    }).join('\n');
  };
  const syncCliSession = (session: ReturnType<SessionRepository['get']>) => {
    if (channelType === 'cli' && channel instanceof CLIChannel) {
      channel.setCurrentSession(session);
    }
  };
  try {
    if (content.trim().toLowerCase() === '/sessions') {
      const current = agent.sessions.getByBinding(channelType, bindingId);
      const sessions = agent.sessions.list();
      await channel.send(sessions.length
        ? sessions.map((session) => `${session.id === current?.id ? '*' : ' '} ${format(session)}`).join('\n')
        : 'No active sessions. Use /session new.', channelId);
      return;
    }
    const argument = content.trim().slice('/session'.length).trim();
    if (argument.toLowerCase() === 'new') {
      const session = agent.sessions.create();
      agent.sessions.bind(session.id, channelType, bindingId);
      syncCliSession(session);
      await channel.send(`New session: ${format(session)}`, channelId);
      return;
    }
    if (!argument || argument.toLowerCase() === 'current') {
      const current = agent.sessions.getByBinding(channelType, bindingId);
      await channel.send(current ? `Current session: ${format(current)}\n\n${transcript(current)}` : 'No current session. Use /session new.', channelId);
      return;
    }
    if (argument.toLowerCase().startsWith('delete ')) {
      const session = agent.sessions.resolve(argument.slice('delete '.length).trim());
      const wasCurrent = agent.sessions.getByBinding(channelType, bindingId)?.id === session.id;
      const confirmed = await channel.askToContinue(
        `Permanently delete ${format(session)} and all ${session.messages.length} messages everywhere? This cannot be undone.`,
        channelId,
      );
      if (!confirmed) {
        await channel.send('Session deletion cancelled.', channelId);
        return;
      }
      if (agent.sessionSyncEnabled) agent.sessions.markDeleted(session.id);
      else agent.sessions.deletePermanently(session.id);
      const replacement = wasCurrent ? agent.sessions.create({ binding: { channelType, externalConversationId: bindingId } }) : null;
      if (replacement) syncCliSession(replacement);
      await channel.send(
        `Deleted session ${session.alias} [${session.shortId}].${agent.sessionSyncEnabled ? ' Cloud deletion is queued.' : ''}${replacement ? ` New session: ${format(replacement)}` : ''}`,
        channelId,
      );
      return;
    }
    if (argument.toLowerCase().startsWith('archive ')) {
      const session = agent.sessions.archive(argument.slice('archive '.length).trim());
      await channel.send(`Archived: ${format(session)}`, channelId);
      return;
    }
    let session;
    try {
      session = agent.sessions.resolve(argument);
    } catch (error) {
      if (channelType !== 'web' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(argument)) throw error;
      session = agent.sessions.create({ id: argument });
    }
    agent.sessions.bind(session.id, channelType, bindingId);
    syncCliSession(session);
    await channel.send(`Switched session: ${format(session)}\n\n${transcript(session)}`, channelId);
  } catch (error) {
    const message = error instanceof SessionResolutionError ? error.message : error instanceof Error ? error.message : String(error);
    await channel.send(message, channelId);
  }
}
