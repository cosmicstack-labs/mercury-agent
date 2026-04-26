import { describe, expect, it } from 'vitest';
import { getDefaultConfig } from './config.js';
import { isProviderConfigured } from './config.js';

describe('Z.ai provider configuration', () => {
  it('includes zai in the default config', () => {
    const config = getDefaultConfig();
    expect(config.providers.zai).toBeDefined();
    expect(config.providers.zai.name).toBe('zai');
    expect(config.providers.zai.model).toBe('glm-5.1');
    expect(config.providers.zai.enabled).toBe(true);
  });

  it('uses the general endpoint by default', () => {
    delete process.env.ZAI_CODING_PLAN_ENABLED;
    delete process.env.ZAI_BASE_URL;
    const config = getDefaultConfig();
    expect(config.providers.zai.baseUrl).toBe('https://api.z.ai/api/paas/v4');
  });

  it('switches to coding plan endpoint when ZAI_CODING_PLAN_ENABLED=true', () => {
    process.env.ZAI_CODING_PLAN_ENABLED = 'true';
    delete process.env.ZAI_CODING_PLAN_BASE_URL;
    const config = getDefaultConfig();
    expect(config.providers.zai.baseUrl).toBe('https://api.z.ai/api/coding/paas/v4');
    delete process.env.ZAI_CODING_PLAN_ENABLED;
  });

  it('respects custom ZAI_CODING_PLAN_BASE_URL', () => {
    process.env.ZAI_CODING_PLAN_ENABLED = 'true';
    process.env.ZAI_CODING_PLAN_BASE_URL = 'https://custom.endpoint/v1';
    const config = getDefaultConfig();
    expect(config.providers.zai.baseUrl).toBe('https://custom.endpoint/v1');
    delete process.env.ZAI_CODING_PLAN_ENABLED;
    delete process.env.ZAI_CODING_PLAN_BASE_URL;
  });

  it('respects custom ZAI_BASE_URL when coding plan is disabled', () => {
    process.env.ZAI_CODING_PLAN_ENABLED = 'false';
    process.env.ZAI_BASE_URL = 'https://my-proxy.example.com/v1';
    const config = getDefaultConfig();
    expect(config.providers.zai.baseUrl).toBe('https://my-proxy.example.com/v1');
    delete process.env.ZAI_CODING_PLAN_ENABLED;
    delete process.env.ZAI_BASE_URL;
  });

  it('is not configured when API key is empty', () => {
    delete process.env.ZAI_API_KEY;
    const config = getDefaultConfig();
    expect(isProviderConfigured(config.providers.zai)).toBe(false);
  });

  it('is configured when API key is set', () => {
    process.env.ZAI_API_KEY = 'test-key-1234567890abcdef';
    const config = getDefaultConfig();
    expect(isProviderConfigured(config.providers.zai)).toBe(true);
    delete process.env.ZAI_API_KEY;
  });

  it('respects ZAI_MODEL override', () => {
    process.env.ZAI_MODEL = 'glm-4-plus';
    const config = getDefaultConfig();
    expect(config.providers.zai.model).toBe('glm-4-plus');
    delete process.env.ZAI_MODEL;
  });

  it('does not leak API key in baseUrl', () => {
    process.env.ZAI_API_KEY = 'secret-key-should-not-appear';
    const config = getDefaultConfig();
    expect(config.providers.zai.baseUrl).not.toContain('secret-key');
    delete process.env.ZAI_API_KEY;
  });
});

describe('Web Panel configuration', () => {
  it('defaults to disabled', () => {
    delete process.env.WEB_PANEL_ENABLED;
    const config = getDefaultConfig();
    expect(config.channels.webPanel.enabled).toBe(false);
  });

  it('defaults to localhost', () => {
    delete process.env.WEB_PANEL_HOST;
    const config = getDefaultConfig();
    expect(config.channels.webPanel.host).toBe('127.0.0.1');
  });

  it('defaults to port 3977', () => {
    delete process.env.WEB_PANEL_PORT;
    const config = getDefaultConfig();
    expect(config.channels.webPanel.port).toBe(3977);
  });

  it('defaults to empty auth token', () => {
    delete process.env.WEB_PANEL_AUTH_TOKEN;
    const config = getDefaultConfig();
    expect(config.channels.webPanel.authToken).toBe('');
  });

  it('defaults to no remote access', () => {
    delete process.env.WEB_PANEL_ALLOW_REMOTE;
    const config = getDefaultConfig();
    expect(config.channels.webPanel.allowRemote).toBe(false);
  });
});

describe('Discord configuration', () => {
  it('defaults to disabled', () => {
    delete process.env.DISCORD_ENABLED;
    const config = getDefaultConfig();
    expect(config.channels.discord.enabled).toBe(false);
  });

  it('defaults to empty bot token', () => {
    delete process.env.DISCORD_BOT_TOKEN;
    const config = getDefaultConfig();
    expect(config.channels.discord.botToken).toBe('');
  });

  it('defaults to empty allowlists', () => {
    delete process.env.DISCORD_ALLOWED_USER_IDS;
    delete process.env.DISCORD_ALLOWED_CHANNEL_IDS;
    delete process.env.DISCORD_ADMIN_USER_IDS;
    const config = getDefaultConfig();
    expect(config.channels.discord.allowedUserIds).toEqual([]);
    expect(config.channels.discord.allowedChannelIds).toEqual([]);
    expect(config.channels.discord.adminUserIds).toEqual([]);
  });

  it('parses comma-separated user IDs', () => {
    process.env.DISCORD_ALLOWED_USER_IDS = '123,456,789';
    const config = getDefaultConfig();
    expect(config.channels.discord.allowedUserIds).toEqual(['123', '456', '789']);
    delete process.env.DISCORD_ALLOWED_USER_IDS;
  });

  it('defaults DMs to disabled', () => {
    delete process.env.DISCORD_ALLOW_DMS;
    const config = getDefaultConfig();
    expect(config.channels.discord.allowDms).toBe(false);
  });

  it('defaults global commands to disabled', () => {
    delete process.env.DISCORD_USE_GLOBAL_COMMANDS;
    const config = getDefaultConfig();
    expect(config.channels.discord.useGlobalCommands).toBe(false);
  });
});
