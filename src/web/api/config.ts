import { Hono } from 'hono';
import { loadConfig, saveConfig } from '../../utils/config.js';

const config = new Hono();

config.get('/api/config', (c) => {
  const cfg = loadConfig();
  return c.json({
    identity: cfg.identity,
    defaultProvider: cfg.providers.default,
    tokenBudget: cfg.tokens.dailyBudget,
    heartbeatInterval: cfg.heartbeat.intervalMinutes,
    telegramEnabled: cfg.channels.telegram.enabled,
    secondBrainEnabled: cfg.memory.secondBrain.enabled,
  });
});

config.put('/api/config', async (c) => {
  const body = await c.req.json();
  const cfg = loadConfig();
  if (body.identity) {
    if (body.identity.name !== undefined) cfg.identity.name = body.identity.name;
    if (body.identity.owner !== undefined) cfg.identity.owner = body.identity.owner;
  }
  if (body.defaultProvider !== undefined) cfg.providers.default = body.defaultProvider;
  if (body.tokenBudget !== undefined) cfg.tokens.dailyBudget = body.tokenBudget;
  saveConfig(cfg);
  return c.json({ success: true });
});

export default config;