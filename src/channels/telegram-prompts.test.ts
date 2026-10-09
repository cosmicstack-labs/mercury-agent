import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TelegramChannel } from './telegram.js';

/**
 * Telegram inline-keyboard prompts (ROADMAP P0.8, #23).
 *
 * - A prompt nobody answers is decided FOR the user after 2 min; the card must
 *   say so (outcome written back in place, keyboard removed, card kept).
 * - A tap on Allow / Deny / Continue / Stop / a choice must remove the keyboard
 *   and append the chosen outcome — the same treatment as the choice path.
 * - The status card's notice list must not grow unbounded with heartbeats.
 */

const TARGET = 'telegram:4242';
const CHAT_ID = 4242;

type MockBot = {
  api: {
    sendMessage: ReturnType<typeof vi.fn>;
    editMessageText: ReturnType<typeof vi.fn>;
    deleteMessage: ReturnType<typeof vi.fn>;
  };
};

function makeChannel(): { channel: TelegramChannel; bot: MockBot } {
  const config = { channels: { telegram: { admins: [], members: [], pendingRequests: [] } } } as any;
  const channel = new TelegramChannel(config);
  let nextMessageId = 100;
  const bot: MockBot = {
    api: {
      sendMessage: vi.fn(async () => ({ message_id: nextMessageId++ })),
      editMessageText: vi.fn(async () => true),
      deleteMessage: vi.fn(async () => true),
    },
  };
  (channel as any).bot = bot;
  return { channel, bot };
}

function makeTapCtx(data: string) {
  return {
    callbackQuery: { data },
    answerCallbackQuery: vi.fn(async () => true),
    editMessageReplyMarkup: vi.fn(async () => true),
  };
}

/** The callback_data of the n-th button on the last sent keyboard. */
function sentButtonData(bot: MockBot, index: number): string {
  const call = bot.api.sendMessage.mock.calls.at(-1)!;
  const keyboard = call[2].reply_markup.inline_keyboard.flat();
  return keyboard[index].callback_data;
}

async function flush(): Promise<void> {
  // settlePromptCard runs fire-and-forget after resolve — let it finish.
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('Telegram prompt timeouts write the outcome back into the card', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('askPermission: no answer in 2 min → "no", card says Deny, keyboard removed, card kept', async () => {
    const { channel, bot } = makeChannel();
    const pending = channel.askPermission('Run **rm -rf build**?', TARGET);
    await vi.advanceTimersByTimeAsync(0);
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(await pending).toBe('no');
    await flush();

    expect(bot.api.editMessageText).toHaveBeenCalledTimes(1);
    const [chatId, messageId, text, opts] = bot.api.editMessageText.mock.calls[0];
    expect(chatId).toBe(CHAT_ID);
    expect(messageId).toBe(100);
    expect(text).toContain('rm -rf build'); // original question preserved
    expect(text).toContain('⏱ No answer in 2 min — treated as <b>Deny</b>');
    expect(opts.reply_markup).toBeUndefined(); // keyboard gone
    expect(bot.api.deleteMessage).not.toHaveBeenCalled(); // card kept
  });

  it('presentChoicePrompt: no answer → first option, card names the recommended option', async () => {
    const { channel, bot } = makeChannel();
    const pending = channel.presentChoicePrompt('Which?', [
      { value: 'quick', label: 'Quick answer' },
      { value: 'deep', label: 'Deep research' },
    ], TARGET);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await pending).toBe('quick');
    await flush();

    const text = bot.api.editMessageText.mock.calls[0][2];
    expect(text).toContain('Which?');
    expect(text).toContain('continued with the recommended option: <b>Quick answer</b>');
    expect(bot.api.deleteMessage).not.toHaveBeenCalled();
  });

  it('askToContinue: no answer → false, card says stopped', async () => {
    const { channel, bot } = makeChannel();
    const pending = channel.askToContinue('Keep going?', TARGET);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await pending).toBe(false);
    await flush();

    const text = bot.api.editMessageText.mock.calls[0][2];
    expect(text).toContain('⏱ No answer in 2 min — <b>stopped</b>');
    expect(bot.api.deleteMessage).not.toHaveBeenCalled();
  });

  it('askPermissionMode: no answer → ask-me, card says so', async () => {
    const { channel, bot } = makeChannel();
    const pending = channel.askPermissionMode(TARGET);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await pending).toBe('ask-me');
    await flush();
    expect(bot.api.editMessageText.mock.calls[0][2]).toContain('defaulting to <b>Ask Me</b>');
  });

  it('falls back to plain text when the HTML edit is rejected', async () => {
    const { channel, bot } = makeChannel();
    bot.api.editMessageText.mockRejectedValueOnce(new Error("can't parse entities"));
    const pending = channel.askToContinue('Keep going?', TARGET);
    await vi.advanceTimersByTimeAsync(120_000);
    await pending;
    await flush();

    expect(bot.api.editMessageText).toHaveBeenCalledTimes(2);
    const [, , plain, opts] = bot.api.editMessageText.mock.calls[1];
    expect(plain).toContain('⏱ No answer in 2 min — stopped');
    expect(plain).not.toContain('<b>');
    expect(opts).toBeUndefined();
  });
});

describe('Telegram inline-keyboard taps settle the card (#23)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('Always tap → "always", keyboard removed and outcome appended; timeout no longer fires', async () => {
    const { channel, bot } = makeChannel();
    const pending = channel.askPermission('Run build?', TARGET);
    await vi.advanceTimersByTimeAsync(0);

    const ctx = makeTapCtx(sentButtonData(bot, 1)); // Allow, Always, Deny
    expect(ctx.callbackQuery.data).toMatch(/:always$/);
    await (channel as any).handleCallbackQuery(ctx);
    expect(await pending).toBe('always');
    await flush();

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Approved' });
    expect(bot.api.editMessageText).toHaveBeenCalledTimes(1);
    const [, , text, opts] = bot.api.editMessageText.mock.calls[0];
    expect(text).toContain('Run build?');
    expect(text).toContain('✅ <b>Always allowed</b>');
    expect(opts.reply_markup).toBeUndefined();
    expect(bot.api.deleteMessage).not.toHaveBeenCalled();

    // The 2-minute timer was cleared — no second edit, no "no answer" text.
    await vi.advanceTimersByTimeAsync(120_000);
    await flush();
    expect(bot.api.editMessageText).toHaveBeenCalledTimes(1);
  });

  it('Deny tap → "no", card says Denied', async () => {
    const { channel, bot } = makeChannel();
    const pending = channel.askPermission('Run build?', TARGET);
    await vi.advanceTimersByTimeAsync(0);

    const ctx = makeTapCtx(sentButtonData(bot, 2));
    await (channel as any).handleCallbackQuery(ctx);
    expect(await pending).toBe('no');
    await flush();

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Denied' });
    expect(bot.api.editMessageText.mock.calls[0][2]).toContain('🚫 <b>Denied</b>');
  });

  it('Continue / Stop taps settle the continue card', async () => {
    const { channel, bot } = makeChannel();
    const pending = channel.askToContinue('Keep going?', TARGET);
    await vi.advanceTimersByTimeAsync(0);

    await (channel as any).handleCallbackQuery(makeTapCtx(sentButtonData(bot, 0)));
    expect(await pending).toBe(true);
    await flush();
    expect(bot.api.editMessageText.mock.calls[0][2]).toContain('▶️ <b>Continuing</b>');
    expect(bot.api.editMessageText.mock.calls[0][3].reply_markup).toBeUndefined();
  });

  it('choice tap → value, card says which option was selected', async () => {
    const { channel, bot } = makeChannel();
    const pending = channel.presentChoicePrompt('Which?', [
      { value: 'quick', label: 'Quick answer' },
      { value: 'deep', label: 'Deep research' },
    ], TARGET);
    await vi.advanceTimersByTimeAsync(0);

    const ctx = makeTapCtx(sentButtonData(bot, 1));
    await (channel as any).handleCallbackQuery(ctx);
    expect(await pending).toBe('deep');
    await flush();

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Selected' });
    const [, , text, opts] = bot.api.editMessageText.mock.calls[0];
    expect(text).toContain('✅ Selected: <b>Deep research</b>');
    expect(opts.reply_markup).toBeUndefined();

    // Timeout must not override the tap.
    await vi.advanceTimersByTimeAsync(120_000);
    await flush();
    expect(bot.api.editMessageText).toHaveBeenCalledTimes(1);
  });

  it('a second tap on a settled card answers "Expired" and edits nothing', async () => {
    const { channel, bot } = makeChannel();
    const pending = channel.askPermission('Run build?', TARGET);
    await vi.advanceTimersByTimeAsync(0);
    const data = sentButtonData(bot, 0);

    await (channel as any).handleCallbackQuery(makeTapCtx(data));
    expect(await pending).toBe('yes');
    await flush();

    const again = makeTapCtx(data);
    await (channel as any).handleCallbackQuery(again);
    expect(again.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Expired' });
    expect(bot.api.editMessageText).toHaveBeenCalledTimes(1);
  });
});

describe('Telegram status card notices are capped', () => {
  it('keeps only the last 8 stored notice lines after a refresh', async () => {
    const { channel } = makeChannel();
    const key = TARGET;
    const notices = Array.from({ length: 30 }, (_, i) => `☿ heartbeat ${i}`);
    (channel as any).statusNotices.set(key, notices);

    await (channel as any).refreshStatusCard(key);

    const stored: string[] = (channel as any).statusNotices.get(key);
    expect(stored).toHaveLength(8);
    expect(stored[0]).toBe('☿ heartbeat 22');
    expect(stored.at(-1)).toBe('☿ heartbeat 29');
  });
});
