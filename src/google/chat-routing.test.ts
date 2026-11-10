import { describe, expect, it, vi } from 'vitest';

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateText: vi.fn(), streamText: vi.fn() };
});

vi.mock('./chat-command.js', () => ({ handleGoogleCommand: vi.fn(async () => {}) }));

import { Agent } from '../core/agent.js';
import { logger } from '../utils/logger.js';
import { handleGoogleCommand } from './chat-command.js';
import type { ChannelMessage } from '../types/channel.js';

describe('/google in the agent', () => {
  it('is handled before any model turn, and the pasted address is never logged', () => {
    const channel = { type: 'telegram', send: vi.fn(async () => {}) };
    const agent = Object.create(Agent.prototype) as Agent;
    Object.assign(agent, {
      channels: { getChannelForMessage: () => channel, get: () => channel },
      pendingPersonaFor: null,
      pendingPersonaChannelId: null,
      messageQueue: [],
    });
    const info = vi.spyOn(logger, 'info');
    const content = '/google connect http://localhost:51234/?code=4%2F0AsecretCode';
    const msg = { id: 'm1', channelId: 'telegram:42', channelType: 'telegram', senderId: '7', senderRole: 'admin', content, timestamp: Date.now() } as ChannelMessage;

    agent.enqueueMessage(msg);

    expect(handleGoogleCommand).toHaveBeenCalledWith(content, msg, channel);
    expect((agent as unknown as { messageQueue: unknown[] }).messageQueue).toEqual([]);
    expect(JSON.stringify(info.mock.calls)).not.toContain('secretCode');
    expect(JSON.stringify(info.mock.calls)).not.toContain('localhost');
    info.mockRestore();
  });
});
