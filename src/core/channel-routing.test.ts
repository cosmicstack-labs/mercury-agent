import { describe, expect, it } from 'vitest';
import { pickOutboundChannelType } from './channel-routing.js';

describe('pickOutboundChannelType', () => {
  it('prefers the current ready channel', () => {
    expect(
      pickOutboundChannelType({
        currentChannelType: 'feishu',
        readyChannels: ['cli', 'feishu'],
        fallbackChannel: 'cli',
      }),
    ).toBe('feishu');
  });

  it('falls back to the notification channel when the current channel is not ready', () => {
    expect(
      pickOutboundChannelType({
        currentChannelType: 'feishu',
        readyChannels: ['cli'],
        fallbackChannel: 'cli',
      }),
    ).toBe('cli');
  });
});
