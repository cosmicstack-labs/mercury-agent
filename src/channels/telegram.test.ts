import { describe, expect, it, vi } from 'vitest';
import { TelegramChannel } from './telegram.js';
import {
  addTelegramPendingRequest,
  getDefaultConfig,
  saveConfig,
} from '../utils/config.js';

vi.mock('../utils/config.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/config.js')>('../utils/config.js');
  return {
    ...actual,
    saveConfig: vi.fn(),
  };
});

describe('TelegramChannel callback result messages', () => {
  it('preserves the original approval request when marking it resolved', async () => {
    const channel = new TelegramChannel(getDefaultConfig()) as any;
    const editMessageText = vi.fn().mockResolvedValue(undefined);
    channel.bot = { api: { editMessageText } };

    await channel.editMessageToResult({
      callbackQuery: {
        message: {
          chat: { id: 123 },
          message_id: 456,
          text: 'Approval Required\n\nDelete file secret.txt?',
        },
        from: { first_name: 'Alice' },
      },
    }, '✅ Allow Once');

    expect(editMessageText).toHaveBeenCalledWith(
      123,
      456,
      expect.stringContaining('Approval Required'),
      expect.objectContaining({ reply_markup: undefined }),
    );
    expect(editMessageText.mock.calls[0][2]).toContain('Delete file secret.txt?');
    expect(editMessageText.mock.calls[0][2]).toContain('✅ Allow Once by Alice');
  });

  it('keeps the requested user context when marking access approval handled', async () => {
    const config = getDefaultConfig();
    config.channels.telegram.admins = [{
      userId: 9,
      chatId: 900,
      username: 'admin',
      approvedAt: '2026-01-01T00:00:00.000Z',
    }];
    addTelegramPendingRequest(config, {
      userId: 42,
      chatId: 420,
      username: 'applicant',
      firstName: 'Casey',
    });

    const channel = new TelegramChannel(config) as any;
    const editMessageText = vi.fn().mockResolvedValue(undefined);
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    channel.bot = { api: { sendMessage } };

    await channel.handleAccessCallback({
      from: { id: 9 },
      chat: { id: 900 },
      callbackQuery: {
        message: {
          text: 'Telegram access request pending approval.\n\nUser ID: 42 (@applicant) (Casey)',
        },
      },
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      editMessageText,
    }, 'tg_access:approve:42');

    expect(saveConfig).toHaveBeenCalledWith(config);
    expect(editMessageText).toHaveBeenCalledWith(
      expect.stringContaining('Telegram access request pending approval.'),
      expect.objectContaining({ reply_markup: undefined }),
    );
    expect(editMessageText.mock.calls[0][0]).toContain('User ID: 42 (@applicant) (Casey)');
    expect(editMessageText.mock.calls[0][0]).toContain('✅ Approved by 9');
  });
});
