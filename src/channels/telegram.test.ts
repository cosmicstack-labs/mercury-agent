import { describe, expect, it, vi } from 'vitest';
import { TelegramChannel } from './telegram.js';
import { getDefaultConfig } from '../utils/config.js';

describe('TelegramChannel approval prompt cleanup', () => {
  it('replaces loop prompt buttons with a confirmation message after continue', async () => {
    const channel = new TelegramChannel(getDefaultConfig());
    const editMessageText = vi.fn().mockResolvedValue(undefined);
    const answerCallbackQuery = vi.fn().mockResolvedValue(undefined);

    (channel as any).bot = {
      api: {
        editMessageText,
        editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
      },
    };

    (channel as any).pendingApprovalPrompts.set('loop_123:yes', {
      chatId: 42,
      messageId: 321,
      kind: 'loop',
    });

    await (channel as any).cleanupApprovalPrompt({ answerCallbackQuery }, 'loop_123:yes', 'yes');

    expect(answerCallbackQuery).toHaveBeenCalledWith({ text: 'Approved' });
    expect(editMessageText).toHaveBeenCalledWith(42, 321, '✅ Continued', { reply_markup: undefined });
    expect((channel as any).pendingApprovalPrompts.has('loop_123:yes')).toBe(false);
  });

  it('clears status tracking even when no Telegram bot is active', async () => {
    const channel = new TelegramChannel(getDefaultConfig());

    (channel as any).statusMessageIds.set('telegram:42', 88);
    (channel as any).statusText.set('telegram:42', 'Working...');
    (channel as any).stepCounters.set('telegram:42', 3);
    (channel as any).bot = null;

    await (channel as any).deleteStatusMessage('telegram:42');

    expect((channel as any).statusMessageIds.has('telegram:42')).toBe(false);
    expect((channel as any).statusText.has('telegram:42')).toBe(false);
    expect((channel as any).stepCounters.has('telegram:42')).toBe(false);
  });
});
