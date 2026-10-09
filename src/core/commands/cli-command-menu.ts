/**
 * The arrow-key /menu command picker on the CLI.
 * Moved out of Agent (P2.1 split); `agent` is the Agent instance.
 */
import type { Agent } from '../agent.js';
import { CLIChannel } from '../../channels/cli.js';
import { handleChatCommand as handleChatCommandImpl } from '../commands/chat-command.js';
import { openCliMemoryMenu as openCliMemoryMenuImpl } from '../commands/cli-memory-menu.js';

export async function openCliCommandMenu(agent: Agent, channel: CLIChannel, channelId: string): Promise<void> {
  const ctx = agent.capabilities.getChatCommandContext();
  if (!ctx) return;

  await channel.withMenu(async (select) => {
    while (true) {
      const streamLabel = agent.telegramStreaming ? 'Disable Telegram Streaming' : 'Enable Telegram Streaming';
      const permLabel = agent.capabilities.permissions.isAutoApproveAll() ? 'Switch to Ask Me' : 'Switch to Allow All';
      const action = await select('Mercury Commands', [
        { value: 'status', label: 'Status' },
        { value: 'memory', label: 'Memory' },
        { value: 'permissions', label: permLabel },
        { value: 'telegram', label: 'Telegram' },
        { value: 'tools', label: 'Tools' },
        { value: 'skills', label: 'Skills' },
        { value: 'stream', label: streamLabel },
        { value: 'help', label: 'Help' },
        { value: 'exit', label: 'Exit' },
      ]);

      if (action === 'exit') {
        return;
      }

      if (action === 'status') {
        await agent.handleChatCommand('/status', 'cli', channelId);
        continue;
      }

      if (action === 'memory') {
        if (agent.userMemory) {
          await agent.openCliMemoryMenu(channel, channelId, select);
        } else {
          const cfg = ctx.config();
          if (cfg.memory.secondBrain?.enabled === false) {
            await channel.send('Second brain is disabled in configuration.', channelId);
          } else {
            await channel.send('Second brain dependency issue: SQLite backend (better-sqlite3) is not available.', channelId);
          }
        }
        continue;
      }

      if (action === 'permissions') {
        await agent.handleChatCommand('/permissions', 'cli', channelId);
        continue;
      }

      if (action === 'telegram') {
        await agent.openCliTelegramMenu(channel, channelId, select);
        continue;
      }

      if (action === 'tools') {
        await agent.handleChatCommand('/tools', 'cli', channelId);
        continue;
      }

      if (action === 'skills') {
        await agent.handleChatCommand('/skills', 'cli', channelId);
        continue;
      }

      if (action === 'stream') {
        await agent.handleChatCommand('/stream', 'cli', channelId);
        continue;
      }

      if (action === 'help') {
        await channel.send(ctx.manual(), channelId);
      }
    }
  });
}
