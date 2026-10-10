import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateText: vi.fn(), streamText: vi.fn() };
});

import { Agent } from './agent.js';
import { handleBotsCommand } from './commands/bots-command.js';
import { BotManager } from '../bots/bot-manager.js';
import { BotStore } from '../bots/store.js';
import { getDefaultConfig, type MercuryConfig } from '../utils/config.js';
import type { ChannelMessage } from '../types/channel.js';
import { tierPermissionsFile } from '../bots/permission-tiers.js';

/**
 * Bot onboarding from a chat that has no bot thread (Telegram, web, Discord):
 * the same persona → permissions → fleet → budget flow as the TUI, with every
 * reply addressed to the chat that asked and every choice offered as a
 * channel-native prompt (buttons on Telegram). Before this, `/bots create`
 * on Telegram sent the whole flow to `bot:<id>`, which Telegram cannot
 * resolve — the owner saw nothing after "onboarded".
 */

const CHAT = 'telegram:4242';

function telegramMessage(content: string): ChannelMessage {
  return { id: `m-${Math.random().toString(36).slice(2)}`, channelId: CHAT, channelType: 'telegram', senderId: '7', senderRole: 'admin', content, timestamp: Date.now() } as ChannelMessage;
}

describe('bot onboarding from Telegram (no bot thread)', () => {
  let root: string;
  let manager: BotManager;
  let agent: Agent;
  let sent: Array<{ target: string | undefined; text: string }>;
  let choices: Array<{ question: string; options: string[] }>;
  let answers: string[];
  let channel: { type: string; send: (text: string, target?: string) => Promise<void> };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mercury-onboard-'));
    const config = getDefaultConfig() as MercuryConfig;
    const providers = { get: () => undefined, getDefault: () => ({ name: 'stub', getModelInstance: () => ({}), getModel: () => 'stub' }) } as never;
    manager = new BotManager({ config, providers, tokenBudget: { recordUsage: () => {}, getRemaining: () => 1e6, getStatusText: () => '', getUsagePercentage: () => 0 } as never, store: new BotStore(join(root, 'bots')), userMemoryFactory: () => null });
    sent = [];
    choices = [];
    answers = [];
    channel = { type: 'telegram', send: async (text, target) => { sent.push({ target, text }); } };
    // A bare Agent: only the onboarding state machine, nothing else constructed.
    agent = Object.create(Agent.prototype) as Agent;
    Object.assign(agent, {
      botManager: manager,
      config,
      providers,
      channels: { getChannelForMessage: () => channel, get: () => channel },
      pendingPersonaFor: null,
      pendingPersonaChannelId: null,
      pendingPersonaNewlyCreated: false,
      pendingBudgetFor: null,
      presentChoice: vi.fn(async (question: string, options: string[]) => {
        choices.push({ question, options });
        const pick = answers.shift();
        return options.find(o => pick && o.startsWith(pick)) ?? options[0];
      }),
    });
  });

  afterEach(() => {
    manager.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('create → persona → permissions → fleet → budget, every reply in the asking chat, every choice a prompt', async () => {
    await handleBotsCommand(agent, '/bots create scout "Scout" "Finds leads"', telegramMessage('/bots create scout "Scout" "Finds leads"'), channel);
    expect(agent.pendingPersonaFor).toBe('scout');
    expect(agent.pendingPersonaChannelId).toBe(CHAT);
    expect(sent.at(-1)?.target).toBe(CHAT);
    expect(sent.at(-1)?.text).toMatch(/next message here/);

    // The owner answers: as-is persona, Operator tier, solo, light budget.
    answers = ['Save as-is', 'Operator', 'Solo', 'Light'];
    agent.enqueueMessage(telegramMessage('You are Scout. You find B2B leads and report them as a table.'));
    await vi.waitFor(() => expect(choices).toHaveLength(4));
    await vi.waitFor(() => expect(sent.some(s => /is ready/.test(s.text))).toBe(true));

    expect(choices.map(c => c.options[0])).toEqual([
      expect.stringMatching(/^Convert to template/),
      'Read-only (recommended default)',
      'Solo bot',
      expect.stringMatching(/^Standard/),
    ]);
    // Buttons are short: the tier descriptions live in the question, not the labels.
    expect(choices[1].options.every(o => o.length <= 60)).toBe(true);
    expect(choices[1].question).toContain('Builder');

    expect(manager.store.readPersona('scout')).toContain('You are Scout');
    expect(manager.store.readPermissions('scout')).toEqual(tierPermissionsFile('operator'));
    expect(manager.store.get('scout')?.fleetRole ?? 'solo').not.toBe('lead');
    expect(manager.store.get('scout')?.autonomy?.dailyTokenBudget).toBe(1_000_000);

    // Nothing went to a TUI-only thread.
    expect(sent.every(s => s.target === CHAT)).toBe(true);
    expect(agent.pendingPersonaFor).toBeNull();
    expect(agent.pendingBudgetFor).toBeNull();
  });

  it('a lead choice promotes the bot; /skip keeps the starter persona; a slash command cancels capture', async () => {
    await handleBotsCommand(agent, '/bots create lead "Lead" "Runs a crew"', telegramMessage('/bots create lead "Lead" "Runs a crew"'), channel);
    answers = ['Save as-is', 'Read-only', "Lead a fleet — I'll", 'No cap'];
    agent.enqueueMessage(telegramMessage('You lead a research crew.'));
    await vi.waitFor(() => expect(sent.some(s => /is ready/.test(s.text))).toBe(true));
    expect(manager.store.get('lead')?.fleetRole).toBe('lead');
    expect(manager.store.get('lead')?.autonomy?.dailyTokenBudget).toBe(0);

    await handleBotsCommand(agent, '/bots create quiet "Quiet" "x"', telegramMessage('/bots create quiet "Quiet" "x"'), channel);
    agent.enqueueMessage(telegramMessage('/skip'));
    expect(agent.pendingPersonaFor).toBeNull();
    expect(sent.at(-1)?.text).toMatch(/Keeping the starter persona/);

    await handleBotsCommand(agent, '/bots create moved "Moved" "x"', telegramMessage('/bots create moved "Moved" "x"'), channel);
    expect(agent.pendingPersonaFor).toBe('moved');
    agent.enqueueMessage(telegramMessage('/bots cost'));
    expect(agent.pendingPersonaFor).toBeNull();
    expect(agent.pendingPersonaChannelId).toBeNull();
  });
});
