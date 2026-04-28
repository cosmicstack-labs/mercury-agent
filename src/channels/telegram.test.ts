import { describe, expect, it, vi } from 'vitest';
import { getDefaultConfig } from '../utils/config.js';
import { TelegramChannel } from './telegram.js';

describe('TelegramChannel approvals', () => {
  it('sends permission prompts to the requested target chat', async () => {
    const config = getDefaultConfig();
    config.channels.telegram.members = [{
      userId: 123,
      chatId: 123,
      approvedAt: '2026-04-28T06:39:00.000Z',
    }];
    const channel = new TelegramChannel(config);
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });

    Object.assign(channel as object, {
      bot: {
        api: {
          sendMessage,
        },
      },
    });

    const approvalPromise = channel.askPermission('Run command: npm publish', 'telegram:123');

    await Promise.resolve();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]).toBe(123);
    expect(sendMessage.mock.calls[0]?.[1]).toContain('Run command: npm publish');

    const pendingApprovals = (channel as any).pendingApprovals as Map<string, () => void>;
    const approvalKey = Array.from(pendingApprovals.keys()).find((key) => key.endsWith(':yes'));
    expect(approvalKey).toBeDefined();
    pendingApprovals.get(approvalKey!)?.();

    await expect(approvalPromise).resolves.toBe('yes');
  });
});
