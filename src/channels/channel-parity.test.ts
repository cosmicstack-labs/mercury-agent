import { describe, expect, it } from 'vitest';
import { BaseChannel } from './base.js';
import { CLIChannel } from './cli.js';
import { TelegramChannel } from './telegram.js';
import { WebChannel } from './web.js';
import { SignalChannel } from './signal.js';
import type { ChannelType, ChannelMessage } from '../types/channel.js';

/**
 * Channel parity contract.
 *
 * The whole point of the capability-based contract is that NO channel is more
 * or less powerful than another at the agent boundary. These tests guard that
 * invariant structurally so a future channel can't silently regress parity.
 */

// Every method the agent is allowed to call on a Channel without branching on
// the concrete class. If a channel is missing one of these (even inherited),
// the agent's uniform calls would throw at runtime.
const CONTRACT_METHODS = [
  // base transport
  'start', 'stop', 'send', 'sendFile', 'stream', 'typing', 'askToContinue',
  'isReady', 'onMessage',
  // capability flags
  'usesTaskBuffering', 'supportsStreaming',
  // task lifecycle
  'beginTask', 'endTask', 'isTaskActive', 'resetStepCounter',
  'popDeferredResponse', 'cleanupEphemeralMessages',
  // progress / completion
  'sendToolFeedback', 'sendStepDone', 'sendCompletion',
  // interactive choice
  'requestChoice',
] as const;

const CHANNELS = [
  { name: 'CLIChannel', ctor: CLIChannel },
  { name: 'TelegramChannel', ctor: TelegramChannel },
  { name: 'WebChannel', ctor: WebChannel },
  { name: 'SignalChannel', ctor: SignalChannel },
] as const;

/** Minimal concrete channel to exercise the BaseChannel defaults. */
class MockChannel extends BaseChannel {
  readonly type: ChannelType = 'internal';
  sent: string[] = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async send(content: string): Promise<void> { this.sent.push(content); }
  async sendFile(): Promise<void> {}
  async stream(): Promise<string> { return ''; }
  async typing(): Promise<void> {}
  async askToContinue(): Promise<boolean> { return false; }
}

describe('channel parity contract', () => {
  for (const { name, ctor } of CHANNELS) {
    for (const method of CONTRACT_METHODS) {
      it(`${name} implements ${method}()`, () => {
        expect(typeof (ctor.prototype as any)[method]).toBe('function');
      });
    }
  }

  it('usesTaskBuffering is true only for buffering channels (Telegram, Signal)', () => {
    expect(TelegramChannel.prototype.usesTaskBuffering.call({})).toBe(true);
    expect(SignalChannel.prototype.usesTaskBuffering.call({})).toBe(true);
    expect(CLIChannel.prototype.usesTaskBuffering.call({})).toBe(false);
    expect(WebChannel.prototype.usesTaskBuffering.call({})).toBe(false);
  });

  it('supportsStreaming is true for CLI/Web/Telegram and false for Signal', () => {
    expect(CLIChannel.prototype.supportsStreaming.call({})).toBe(true);
    expect(WebChannel.prototype.supportsStreaming.call({})).toBe(true);
    expect(TelegramChannel.prototype.supportsStreaming.call({})).toBe(true);
    expect(SignalChannel.prototype.supportsStreaming.call({})).toBe(false);
  });
});

describe('BaseChannel capability defaults', () => {
  it('default flags are the conservative no-op values', () => {
    const ch = new MockChannel();
    expect(ch.usesTaskBuffering()).toBe(false);
    expect(ch.supportsStreaming()).toBe(false);
    expect(ch.isTaskActive()).toBe(false);
    expect(ch.popDeferredResponse()).toBeUndefined();
  });

  it('lifecycle and progress no-ops do not throw', async () => {
    const ch = new MockChannel();
    expect(() => ch.beginTask('t')).not.toThrow();
    expect(() => ch.endTask('t')).not.toThrow();
    expect(() => ch.resetStepCounter('t')).not.toThrow();
    await expect(ch.cleanupEphemeralMessages('t')).resolves.toBeUndefined();
    await expect(Promise.resolve(ch.sendToolFeedback('x', {}, 't'))).resolves.toBeUndefined();
    await expect(Promise.resolve(ch.sendStepDone('x', null, 't'))).resolves.toBeUndefined();
    await expect(Promise.resolve(ch.sendCompletion(1000, 1, 't'))).resolves.toBeUndefined();
  });

  it('default requestChoice sends a numbered list and returns the first option', async () => {
    const ch = new MockChannel();
    const choice = await ch.requestChoice('Pick one', ['alpha', 'beta'], 't');
    expect(choice).toBe('alpha');
    expect(ch.sent[0]).toContain('Pick one');
    expect(ch.sent[0]).toContain('1. alpha');
    expect(ch.sent[0]).toContain('2. beta');
  });
});

// Compile-time guard: a no-op ChannelMessage reference keeps the import used and
// ensures the message shape stays in scope for future parity assertions.
const _shape: Partial<ChannelMessage> = {};
void _shape;
