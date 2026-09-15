import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLIChannel } from './cli.js';

describe('CLIChannel bot chat (transcript swap + target routing)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeChannel(): CLIChannel {
    vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
    return new CLIChannel();
  }

  it('enterBotChat swaps the transcript and parks the main one', async () => {
    const channel = new CLIChannel();
    await channel.send('main message one');
    expect(channel.getTuiState().chatMessages.some(m => m.content.includes('main message one'))).toBe(true);

    channel.enterBotChat('researcher', 'Research');
    const state = channel.getTuiState();
    expect(state.botChat).toEqual({ botId: 'researcher', botName: 'Research' });
    // Transcript swapped to the bot's seeded thread
    expect(state.chatMessages.some(m => m.content.includes('bot chat'))).toBe(true);
    expect(state.chatMessages.some(m => m.content.includes('main message one'))).toBe(false);

    // Main-agent traffic while in the bot chat parks in the main transcript
    await channel.send('main agent completion');
    expect(channel.getTuiState().chatMessages.some(m => m.content.includes('main agent completion'))).toBe(false);

    channel.exitBotChat();
    const restored = channel.getTuiState();
    expect(restored.botChat).toBeNull();
    expect(restored.chatMessages.some(m => m.content.includes('main message one'))).toBe(true);
    expect(restored.chatMessages.some(m => m.content.includes('main agent completion'))).toBe(true);
  });

  it('routes bot:<id> sends live when that bot chat is open', async () => {
    const channel = new CLIChannel();
    channel.enterBotChat('researcher', 'Research');
    await channel.send('bot reply', 'bot:researcher');
    expect(channel.getTuiState().chatMessages.some(m => m.content.includes('bot reply'))).toBe(true);
  });

  it('stores sends for an inactive bot transcript without disturbing the screen', async () => {
    const channel = new CLIChannel();
    channel.enterBotChat('researcher', 'Research');
    await channel.send('publisher reply', 'bot:publisher');
    expect(channel.getTuiState().chatMessages.some(m => m.content.includes('publisher reply'))).toBe(false);
    // Switching to the publisher chat reveals the stored message
    channel.exitBotChat();
    channel.enterBotChat('publisher', 'Publisher');
    expect(channel.getTuiState().chatMessages.some(m => m.content.includes('publisher reply'))).toBe(true);
  });

  it('persists a bot transcript across exit and re-entry', async () => {
    const channel = new CLIChannel();
    channel.enterBotChat('researcher', 'Research');
    await channel.send('first bot run result', 'bot:researcher');
    channel.exitBotChat();
    channel.enterBotChat('researcher', 'Research');
    expect(channel.getTuiState().chatMessages.some(m => m.content.includes('first bot run result'))).toBe(true);
  });

  it('seeded bot chat shows the /chat hint exactly once', async () => {
    const channel = new CLIChannel();
    channel.enterBotChat('researcher', 'Research');
    channel.exitBotChat();
    channel.enterBotChat('researcher', 'Research');
    const hints = channel.getTuiState().chatMessages.filter(m => m.content.includes('bot chat — everything you type'));
    expect(hints).toHaveLength(1);
  });
});