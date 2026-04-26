import { describe, expect, it } from 'vitest';
import { DiscordChannel } from './discord.js';
import { WebPanelChannel } from './web-panel.js';

describe('DiscordChannel access control', () => {
  const baseConfig = () => ({
    channels: {
      discord: {
        enabled: true,
        botToken: 'test-token',
        clientId: 'test-client-id',
        guildId: 'test-guild-id',
        allowedUserIds: ['user-1', 'user-2'],
        allowedChannelIds: ['channel-1'],
        adminUserIds: ['admin-1'],
        useGlobalCommands: false,
        allowDms: false,
      },
      telegram: { enabled: false, botToken: '', admins: [], members: [], pending: [] },
      webPanel: { enabled: false, host: '127.0.0.1', port: 3977, authToken: '', allowRemote: false },
    },
    identity: { name: 'Test', owner: 'Test' },
    providers: { default: 'deepseek' },
    github: { username: '', email: '', defaultOwner: '', defaultRepo: '' },
    memory: { shortTermMaxMessages: 20, secondBrain: { enabled: false, maxRecords: 50 } },
    heartbeat: { intervalMinutes: 60 },
    tokens: { dailyBudget: 1000000 },
  });

  it('allows users in the allowedUserIds list', () => {
    const channel = new DiscordChannel(baseConfig() as any);
    expect((channel as any).isAllowed('user-1')).toBe(true);
    expect((channel as any).isAllowed('user-2')).toBe(true);
  });

  it('allows admin users even if not in allowedUserIds', () => {
    const channel = new DiscordChannel(baseConfig() as any);
    expect((channel as any).isAllowed('admin-1')).toBe(true);
  });

  it('rejects users not in any allowlist', () => {
    const channel = new DiscordChannel(baseConfig() as any);
    expect((channel as any).isAllowed('unknown-user')).toBe(false);
  });

  it('falls back to admin-only when allowedUserIds is empty', () => {
    const cfg = baseConfig();
    cfg.channels.discord.allowedUserIds = [];
    const channel = new DiscordChannel(cfg as any);
    expect((channel as any).isAllowed('admin-1')).toBe(true);
    expect((channel as any).isAllowed('random-user')).toBe(false);
  });

  it('splits long messages to fit Discord limits', () => {
    const channel = new DiscordChannel(baseConfig() as any);
    const longText = 'a'.repeat(5000);
    const chunks = (channel as any).splitForDiscord(longText, 2000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
    expect(chunks.join('')).toBe(longText);
  });

  it('returns single chunk for short messages', () => {
    const channel = new DiscordChannel(baseConfig() as any);
    const chunks = (channel as any).splitForDiscord('short message', 2000);
    expect(chunks).toEqual(['short message']);
  });
});

describe('WebPanelChannel security', () => {
  it('refuses to start on 0.0.0.0 without auth token and allowRemote', async () => {
    const config = {
      channels: {
        webPanel: {
          enabled: true,
          host: '0.0.0.0',
          port: 3977,
          authToken: '',
          allowRemote: false,
        },
        discord: { enabled: false, botToken: '', clientId: '', guildId: '', allowedUserIds: [], allowedChannelIds: [], adminUserIds: [], useGlobalCommands: false, allowDms: false },
        telegram: { enabled: false, botToken: '', admins: [], members: [], pending: [] },
      },
      identity: { name: 'Test', owner: 'Test' },
      providers: { default: 'deepseek' },
      github: { username: '', email: '', defaultOwner: '', defaultRepo: '' },
      memory: { shortTermMaxMessages: 20, secondBrain: { enabled: false, maxRecords: 50 } },
      heartbeat: { intervalMinutes: 60 },
      tokens: { dailyBudget: 1000000 },
    };
    const channel = new WebPanelChannel(config as any);
    await expect(channel.start()).rejects.toThrow();
  });

  it('does not expose secrets in status response', () => {
    const config = {
      channels: {
        webPanel: {
          enabled: false,
          host: '127.0.0.1',
          port: 3977,
          authToken: 'super-secret-token',
          allowRemote: false,
        },
        discord: { enabled: false, botToken: '', clientId: '', guildId: '', allowedUserIds: [], allowedChannelIds: [], adminUserIds: [], useGlobalCommands: false, allowDms: false },
        telegram: { enabled: false, botToken: 'telegram-secret', admins: [], members: [], pending: [] },
      },
      identity: { name: 'Test', owner: 'Test' },
      providers: { default: 'deepseek', zai: { apiKey: 'zai-secret-key' } },
      github: { username: '', email: '', defaultOwner: '', defaultRepo: '' },
      memory: { shortTermMaxMessages: 20, secondBrain: { enabled: false, maxRecords: 50 } },
      heartbeat: { intervalMinutes: 60 },
      tokens: { dailyBudget: 1000000 },
    };
    const channel = new WebPanelChannel(config as any);
    const status = (channel as any).getStatus();
    const statusStr = JSON.stringify(status);
    expect(statusStr).not.toContain('super-secret-token');
    expect(statusStr).not.toContain('telegram-secret');
    expect(statusStr).not.toContain('zai-secret-key');
  });
});
