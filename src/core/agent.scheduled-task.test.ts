import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChannelMessage, ChannelType } from '../types/channel.js';
import { logger } from '../utils/logger.js';
import { Agent } from './agent.js';
import type { ScheduledTaskManifest } from './scheduler.js';

type AgentHarness = {
  enqueueMessage(message: ChannelMessage): void;
  handleScheduledTask(manifest: ScheduledTaskManifest): Promise<void>;
  processInternalPrompt(prompt: string, channelId?: string, channelType?: ChannelType): Promise<void>;
};

function createAgentHarness(): AgentHarness {
  return Object.create(Agent.prototype) as AgentHarness;
}

function createManifest(overrides: Partial<ScheduledTaskManifest> = {}): ScheduledTaskManifest {
  return {
    id: 'scheduled-task',
    description: 'Process scheduled task',
    createdAt: '2026-04-25T00:00:00.000Z',
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Agent scheduled-task runtime path', () => {
  it('keeps no-op inbox-patrol startup silent through handleScheduledTask', async () => {
    const agent = createAgentHarness();
    const processSpy = vi.spyOn(agent, 'processInternalPrompt').mockResolvedValue(undefined);

    await agent.handleScheduledTask(createManifest({
      id: 'inbox-patrol-noop',
      description: 'Process Jarvis Paperclip inbox every 30min',
      skillName: 'inbox-patrol',
    }));

    expect(processSpy).toHaveBeenCalledTimes(1);
    expect(processSpy).toHaveBeenCalledWith(
      'Scheduled task triggered. Invoke the skill "inbox-patrol" using the use_skill tool and follow its instructions.',
      undefined,
      undefined,
    );

    const [prompt] = processSpy.mock.calls[0]!;
    expect(prompt).not.toContain('Scheduled task started');
    expect(prompt).not.toContain('All actions auto-approved');
  });

  it('preserves downstream prompt and routing for actionable scheduled work', async () => {
    const agent = createAgentHarness();
    const processSpy = vi.spyOn(agent, 'processInternalPrompt').mockResolvedValue(undefined);

    await agent.handleScheduledTask(createManifest({
      id: 'inbox-patrol-actionable',
      description: 'Escalate the inbox item that needs Leo',
      prompt: 'Leo needs a decision on this Paperclip inbox item.',
      skillName: 'inbox-patrol',
      sourceChannelId: 'telegram:1044412428',
      sourceChannelType: 'telegram',
    }));

    expect(processSpy).toHaveBeenCalledWith(
      'Leo needs a decision on this Paperclip inbox item. Invoke the skill "inbox-patrol" using the use_skill tool and follow its instructions.',
      'telegram:1044412428',
      'telegram',
    );
  });

  it('falls back to the description when no prompt or skill is provided', async () => {
    const agent = createAgentHarness();
    const processSpy = vi.spyOn(agent, 'processInternalPrompt').mockResolvedValue(undefined);

    await agent.handleScheduledTask(createManifest({
      id: 'description-fallback',
      description: 'Sweep stale tasks',
    }));

    expect(processSpy).toHaveBeenCalledWith(
      'Execute scheduled task: Sweep stale tasks',
      undefined,
      undefined,
    );
  });

  it('builds an internal system message by default in processInternalPrompt', async () => {
    const agent = createAgentHarness();
    const enqueueSpy = vi.fn<(message: ChannelMessage) => void>();
    agent.enqueueMessage = enqueueSpy;

    await agent.processInternalPrompt('Check the Paperclip inbox.');

    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSpy).toHaveBeenCalledWith(expect.objectContaining({
      channelId: 'internal',
      channelType: 'internal',
      senderId: 'system',
      content: 'Check the Paperclip inbox.',
    }));
  });

  it('preserves an explicit channel route in processInternalPrompt', async () => {
    const agent = createAgentHarness();
    const enqueueSpy = vi.fn<(message: ChannelMessage) => void>();
    agent.enqueueMessage = enqueueSpy;

    await agent.processInternalPrompt(
      'Leo needs a decision on the inbox escalation.',
      'telegram:1044412428',
      'telegram',
    );

    expect(enqueueSpy).toHaveBeenCalledWith(expect.objectContaining({
      channelId: 'telegram:1044412428',
      channelType: 'telegram',
      senderId: 'system',
      content: 'Leo needs a decision on the inbox escalation.',
    }));
  });

  it('logs runtime failures instead of emitting a startup banner', async () => {
    const agent = createAgentHarness();
    const runtimeError = new Error('Paperclip inbox unavailable');
    vi.spyOn(agent, 'processInternalPrompt').mockRejectedValue(runtimeError);
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    await expect(agent.handleScheduledTask(createManifest({
      id: 'inbox-patrol-error',
      description: 'Process Jarvis Paperclip inbox every 30min',
      skillName: 'inbox-patrol',
    }))).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        err: runtimeError,
        task: 'inbox-patrol-error',
      }),
      'Scheduled task execution failed',
    );
  });
});
