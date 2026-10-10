import { describe, expect, it, vi } from 'vitest';
import { TelegramChannel } from './telegram.js';
import type { ChannelMessage } from '../types/channel.js';

/**
 * Tappable bot controls (ADR-023): a message sent with action rows carries an
 * inline keyboard, and a tap by an approved user turns into the slash command
 * behind the button — emitted as an ordinary ChannelMessage so routing,
 * permissions and replies are exactly what typing it would give.
 */

const CHAT_ID = 4242;
const ADMIN = 7;
const STRANGER = 99;

function makeChannel() {
  const config = { channels: { telegram: { admins: [{ userId: ADMIN, name: 'Owner' }], members: [], pending: [], pendingRequests: [] } } };
  const channel = new TelegramChannel(config as never);
  type Keyboard = { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
  const sendMessage = vi.fn<(chatId: number, text: string, opts: { reply_markup: Keyboard }) => Promise<{ message_id: number }>>(async () => ({ message_id: 1 }));
  const bot = { api: { sendMessage } };
  (channel as unknown as { bot: typeof bot }).bot = bot;
  const received: ChannelMessage[] = [];
  channel.onMessage(async (m) => { received.push(m); });
  return { channel, bot, received };
}

/** Reach the private tap handler the way grammy would. */
function tapHandler(channel: TelegramChannel): (ctx: unknown) => Promise<void> {
  return (channel as unknown as { handleCallbackQuery(ctx: unknown): Promise<void> }).handleCallbackQuery.bind(channel);
}

function tap(data: string, userId: number) {
  return {
    callbackQuery: { data, message: { chat: { id: CHAT_ID } } },
    from: { id: userId, first_name: 'T' },
    answerCallbackQuery: vi.fn(async () => true),
  };
}

describe('Telegram tappable actions', () => {
  it('sends an inline keyboard whose rows mirror the given actions', async () => {
    const { channel, bot } = makeChannel();
    await channel.sendWithActions('roster', [
      [{ label: '⏹ Stop ceo', command: '/bots stop ceo' }, { label: '🏃 Run', command: '/bots run ceo' }],
      [{ label: '💰 Cost', command: '/bots cost' }],
    ], `telegram:${CHAT_ID}`);
    const keyboard = bot.api.sendMessage.mock.calls[0]![2]!.reply_markup.inline_keyboard;
    expect(keyboard).toHaveLength(2);
    expect(keyboard[0]).toHaveLength(2);
    expect(keyboard[0][0].text).toBe('⏹ Stop ceo');
    expect(keyboard[0][0].callback_data).toMatch(/^ba:[a-z0-9]+$/);
    expect(keyboard[0][0].callback_data.length).toBeLessThanOrEqual(64);
  });

  it('a tap by an approved user emits the command as a message from that user', async () => {
    const { channel, bot, received } = makeChannel();
    await channel.sendWithActions('roster', [[{ label: 'Stop all', command: '/bots stop all' }]], `telegram:${CHAT_ID}`);
    const data = bot.api.sendMessage.mock.calls[0]![2]!.reply_markup.inline_keyboard[0][0].callback_data;
    const ctx = tap(data, ADMIN);
    await tapHandler(channel)(ctx);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      channelId: `telegram:${CHAT_ID}`,
      channelType: 'telegram',
      senderId: String(ADMIN),
      senderRole: 'admin',
      content: '/bots stop all',
    });
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
  });

  it('a tap by an unapproved user is refused and emits nothing', async () => {
    const { channel, bot, received } = makeChannel();
    await channel.sendWithActions('roster', [[{ label: 'Stop all', command: '/bots stop all' }]], `telegram:${CHAT_ID}`);
    const data = bot.api.sendMessage.mock.calls[0]![2]!.reply_markup.inline_keyboard[0][0].callback_data;
    const ctx = tap(data, STRANGER);
    await tapHandler(channel)(ctx);
    expect(received).toHaveLength(0);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({ text: 'Not allowed' }));
  });

  it('an unknown or expired token answers without emitting', async () => {
    const { channel, received } = makeChannel();
    const ctx = tap('ba:nope', ADMIN);
    await tapHandler(channel)(ctx);
    expect(received).toHaveLength(0);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('Expired') }));
  });
});
