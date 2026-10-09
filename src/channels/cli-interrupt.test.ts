import { describe, expect, it, vi } from 'vitest';
import { CLIChannel, INTERRUPTED_MARKER } from './cli.js';

/**
 * Esc during a running turn must go through the SAME stop routine `/stop`
 * uses, installed by the boot path — the channel never reaches into the
 * agent. It writes a one-line marker into the transcript, and is a no-op
 * when nothing is running (Esc then keeps its exit/back bindings).
 */
describe('CLIChannel.interruptTurn', () => {
  it('is a no-op while idle', () => {
    const channel = new CLIChannel();
    const stop = vi.fn();
    channel.setInterruptHandler(stop);
    expect(channel.isTurnRunning()).toBe(false);
    expect(channel.interruptTurn()).toBe(false);
    expect(stop).not.toHaveBeenCalled();
    expect(channel.getTuiState().chatMessages.some((m) => m.content === INTERRUPTED_MARKER)).toBe(false);
  });

  it('calls the installed stop routine once and writes the Interrupted marker', async () => {
    const channel = new CLIChannel();
    const stop = vi.fn(async () => 'stopped');
    channel.setInterruptHandler(stop);
    await channel.typing();
    expect(channel.isTurnRunning()).toBe(true);
    expect(channel.interruptTurn()).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
    const messages = channel.getTuiState().chatMessages;
    const marker = messages[messages.length - 1];
    expect(marker.role).toBe('system');
    expect(marker.content).toBe(INTERRUPTED_MARKER);
    expect(marker.content.includes('\n')).toBe(false);
  });

  it('does nothing without a handler (no agent wired)', async () => {
    const channel = new CLIChannel();
    await channel.typing();
    expect(channel.interruptTurn()).toBe(false);
  });

  it('a rejecting stop routine never throws into the key handler', async () => {
    const channel = new CLIChannel();
    channel.setInterruptHandler(() => Promise.reject(new Error('boom')));
    await channel.typing();
    expect(() => channel.interruptTurn()).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });
});
