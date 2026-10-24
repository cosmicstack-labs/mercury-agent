import { describe, expect, it, vi } from 'vitest';
import { WebChannel } from '../../channels/web.js';
import { handleChatCommand } from './chat-command.js';

/**
 * Pickers on the owner's own screens. Since 1.3.1 the default launch attaches
 * to the runtime, which talks over the web channel — so a picker that was
 * only offered to the CLI channel was a picker nobody saw.
 */

type Agent = import('../agent.js').Agent;

function sseChannel(sessionId: string): { channel: WebChannel; events: Array<{ type: string; data: Record<string, unknown> }>; sent: string[] } {
  const channel = new WebChannel('Mercury');
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  channel.addSSEClient({
    enqueue(value: Uint8Array) {
      const text = new TextDecoder().decode(value);
      const type = /event: (\S+)/.exec(text)?.[1];
      const data = /data: (.+)/.exec(text)?.[1];
      if (type && data) events.push({ type, data: JSON.parse(data) as Record<string, unknown> });
    },
    close() {},
  } as unknown as ReadableStreamDefaultController, sessionId);
  const sent: string[] = [];
  const realSend = channel.send.bind(channel);
  channel.send = async (content: string, targetId?: string, elapsedMs?: number) => { sent.push(content); await realSend(content, targetId, elapsedMs); };
  return { channel, events, sent };
}

function agentWith(channel: WebChannel, switchSessionProvider: (name: string) => Promise<{ ok: boolean; message: string }>): Agent {
  const providers = {
    anthropic: { name: 'anthropic', enabled: true, apiKey: 'k', model: 'claude-haiku-4-5' },
    openai: { name: 'openai', enabled: true, apiKey: 'k', model: 'gpt-4.1-mini' },
    default: 'anthropic',
  };
  return {
    config: { providers },
    providers: { getDefault: () => ({ name: 'anthropic', model: 'claude-haiku-4-5' }) },
    channels: { get: () => channel },
    capabilities: { getChatCommandContext: () => ({ config: () => ({ providers }) }) },
    switchSessionProvider,
  } as unknown as Agent;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('/model on the attached terminal (web channel)', () => {
  it('lists the models, then offers an arrow-key picker and switches to the pick', async () => {
    const { channel, events, sent } = sseChannel('sess-1');
    const switched = vi.fn(async (name: string) => ({ ok: true, message: `✓ Switched to ${name}` }));
    const done = handleChatCommand(agentWith(channel, switched), '/model', 'web', 'sess-1');
    await tick();

    expect(sent[0]).toContain('**Session Models**');
    expect(sent[0]).toContain('anthropic · claude-haiku-4-5 ← current');
    const prompt = events.find((e) => e.type === 'choice_prompt');
    expect(prompt?.data.question).toBe('Switch session model?');
    const options = prompt?.data.options as Array<{ value: string; label: string }>;
    expect(options.map((o) => o.label)).toEqual([
      'anthropic · claude-haiku-4-5 (current)',
      'openai · gpt-4.1-mini',
      'Open doctor instructions',
      'Keep current model',
    ]);

    expect(channel.resolveChoice(String(prompt!.data.id), '1', 'sess-1')).toBe(true);
    expect(await done).toBe(true);
    expect(switched).toHaveBeenCalledWith('openai');
    expect(sent.at(-1)).toBe('✓ Switched to openai');
  });

  it('Esc on the picker changes nothing — the first option is never taken by default', async () => {
    const { channel, events } = sseChannel('sess-1');
    const switched = vi.fn(async (name: string) => ({ ok: true, message: name }));
    const done = handleChatCommand(agentWith(channel, switched), '/model', 'web', 'sess-1');
    await tick();
    const id = String(events.find((e) => e.type === 'choice_prompt')!.data.id);
    expect(channel.cancelInteraction(id, 'sess-1')).toBe(true);
    expect(await done).toBe(true);
    expect(switched).not.toHaveBeenCalled();
  });

  it('with no attached screen for that session there is no picker, just the list', async () => {
    const { channel, events } = sseChannel('other-session');
    const switched = vi.fn(async (name: string) => ({ ok: true, message: name }));
    expect(await handleChatCommand(agentWith(channel, switched), '/model', 'web', 'sess-1')).toBe(true);
    expect(events.find((e) => e.type === 'choice_prompt')).toBeUndefined();
    expect(switched).not.toHaveBeenCalled();
  });
});
