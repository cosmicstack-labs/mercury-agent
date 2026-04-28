import { describe, expect, it, vi } from 'vitest';
import { CLIChannel } from '../channels/cli.js';
import { Agent, getMessagePermissionPolicy } from './agent.js';

class StubCLIChannel extends CLIChannel {
  sent: string[] = [];
  mode: 'allow-all' | 'ask-me' = 'allow-all';

  override async send(content: string): Promise<void> {
    this.sent.push(content);
  }

  override async askPermissionMode(): Promise<'allow-all' | 'ask-me'> {
    return this.mode;
  }
}

function createAgentForPermissionCommand(channel: StubCLIChannel) {
  const permissions = {
    setCurrentChannel: vi.fn(),
    setAutoApproveAll: vi.fn(),
    addTempScope: vi.fn(),
  };

  const capabilities = {
    permissions,
    getChatCommandContext: vi.fn(() => ({})),
  };

  const channels = {
    get: vi.fn(() => channel),
    onIncomingMessage: vi.fn(),
  };

  const scheduler = {
    setOnScheduledTask: vi.fn(),
    onHeartbeat: vi.fn(),
  };

  const agent = new Agent(
    { channels: { telegram: { streaming: true } } } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    null,
    channels as any,
    {} as any,
    capabilities as any,
    scheduler as any,
  );

  return { agent, permissions, capabilities, channels, scheduler };
}

describe('getMessagePermissionPolicy', () => {
  it('keeps auto-approve for internal messages without a root temp scope concept in the contract', () => {
    const policy = getMessagePermissionPolicy({
      channelType: 'internal',
      senderId: 'user-123',
    });

    expect(policy).toEqual({ autoApproveAll: true });
  });

  it('keeps auto-approve for scheduled system messages without a root temp scope concept in the contract', () => {
    const policy = getMessagePermissionPolicy({
      channelType: 'cli',
      senderId: 'system',
    });

    expect(policy).toEqual({ autoApproveAll: true });
  });

  it('does not elevate normal external messages', () => {
    const policy = getMessagePermissionPolicy({
      channelType: 'telegram',
      senderId: 'user-456',
    });

    expect(policy).toEqual({ autoApproveAll: false });
  });
});

describe('Agent /permissions command', () => {
  it('does not grant a root temp scope when CLI switches to allow-all', async () => {
    const channel = new StubCLIChannel('Mercury Sandbox');
    channel.mode = 'allow-all';
    const { agent, permissions } = createAgentForPermissionCommand(channel);

    await (agent as any).handleChatCommand('/permissions', 'cli', 'cli:default');

    expect(permissions.setCurrentChannel).toHaveBeenCalledWith('cli:default', 'cli');
    expect(permissions.setAutoApproveAll).toHaveBeenCalledWith(true);
    expect(permissions.addTempScope).not.toHaveBeenCalled();
    expect(channel.sent).toContain(
      'Allow All mode active for this session. Command approvals and loop prompts are auto-approved, but filesystem scopes and blocked shell commands still apply. Resets on restart.',
    );
  });
});
