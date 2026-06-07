import { Hono } from 'hono';
import { RelayClient, validateUsernameLocal } from '../../relay/client.js';
import { loadConfig, saveConfig } from '../../utils/config.js';

let relayClient: RelayClient | null = null;

export function setRelayClientForRelay(client: RelayClient | null): void {
  relayClient = client;
}

/** Called from index.ts when a new RelayClient is created at runtime (e.g. after first-time setup). */
export function getRelayClient(): RelayClient | null {
  return relayClient;
}

const relayRoutes = new Hono();

/**
 * Build the channels array and resolve display name from config,
 * mirroring what the CLI does during registration.
 */
function getRegistrationContext(explicitDisplayName?: string) {
  const config = loadConfig();
  const channels: Array<{ type: string; id: string }> = [];

  // Add Telegram channel if configured
  const tgAdmins = config.channels?.telegram?.admins;
  if (tgAdmins && tgAdmins.length > 0) {
    channels.push({ type: 'telegram', id: String(tgAdmins[0].userId) });
  }

  // Web channel
  channels.push({ type: 'web', id: 'web' });

  // Resolve display name:
  // 1. Explicit from user input
  // 2. identity.owner from config (set during mercury doctor)
  // 3. Telegram firstName from first admin
  let displayName = explicitDisplayName?.trim() || '';
  if (!displayName && config.identity?.owner) {
    displayName = config.identity.owner;
  }
  if (!displayName && tgAdmins && tgAdmins.length > 0 && tgAdmins[0].firstName) {
    displayName = tgAdmins[0].firstName;
  }

  return { channels, displayName: displayName || undefined };
}

// ── Status ──────────────────────────────────────────────────────
relayRoutes.get('/api/relay/status', (c) => {
  const config = loadConfig();
  const relayConfig = config.relay ?? {};
  const tgAdmins = config.channels?.telegram?.admins;
  const tgAdmin = tgAdmins && tgAdmins.length > 0 ? tgAdmins[0] : null;

  return c.json({
    enabled: relayConfig.enabled !== false,
    url: relayConfig.url || 'wss://relay.cosmicstack.org/v1/ws',
    username: relayConfig.username || '',
    registered: relayClient ? relayClient.isRegistered() : !!(relayConfig.apiKey),
    connected: relayClient?.isConnected() ?? false,
    reconnecting: relayClient?.isReconnecting() ?? false,
    available: relayClient !== null,
    telegram: tgAdmin ? {
      userId: tgAdmin.userId,
      username: tgAdmin.username || null,
      firstName: tgAdmin.firstName || null,
    } : null,
    ownerName: config.identity?.owner || null,
  });
});

// ── Connect ─────────────────────────────────────────────────────
relayRoutes.post('/api/relay/connect', async (c) => {
  if (!relayClient) {
    return c.json({ error: 'Relay client not initialised. Configure relay settings first.' }, 503);
  }
  if (!relayClient.isRegistered()) {
    return c.json({ error: 'Not registered on relay. Register first.' }, 400);
  }
  if (relayClient.isConnected()) {
    return c.json({ connected: true, message: 'Already connected' });
  }

  // Validate key first
  const keyStatus = await relayClient.validateApiKey();
  if (keyStatus === 'invalid') {
    relayClient.clearRegistration();
    return c.json({ error: 'API key is invalid. Registration has been cleared — please re-register.' }, 401);
  }
  if (keyStatus === 'unreachable') {
    return c.json({ error: 'Cannot reach relay server. Try again later.' }, 502);
  }

  const ok = await relayClient.connect();
  return c.json({ connected: ok, message: ok ? 'Connected to relay' : 'Failed to connect' });
});

// ── Disconnect ──────────────────────────────────────────────────
relayRoutes.post('/api/relay/disconnect', (c) => {
  if (!relayClient) {
    return c.json({ error: 'Relay client not initialised.' }, 503);
  }
  relayClient.disconnect();
  return c.json({ connected: false, message: 'Disconnected from relay' });
});

// ── Check username availability ─────────────────────────────────
relayRoutes.post('/api/relay/check-username', async (c) => {
  const body = await c.req.json<{ username: string }>();
  const username = (body.username || '').toLowerCase().trim();

  const local = validateUsernameLocal(username);
  if (!local.valid) {
    return c.json({ available: false, error: local.error });
  }

  // Need a relay client instance (even unregistered) to make the HTTP call
  if (!relayClient) {
    return c.json({ error: 'Relay client not initialised.' }, 503);
  }

  const result = await relayClient.checkUsername(username);
  return c.json(result);
});

// ── Register ────────────────────────────────────────────────────
relayRoutes.post('/api/relay/register', async (c) => {
  if (!relayClient) {
    return c.json({ error: 'Relay client not initialised. Enable relay in settings first.' }, 503);
  }
  if (relayClient.isRegistered()) {
    return c.json({ error: 'Already registered. Deregister first to re-register.' }, 400);
  }

  const body = await c.req.json<{ username: string; displayName?: string }>();
  const username = (body.username || '').toLowerCase().trim();

  const local = validateUsernameLocal(username);
  if (!local.valid) {
    return c.json({ error: local.error }, 400);
  }

  try {
    const ctx = getRegistrationContext(body.displayName);
    const result = await relayClient.register(username, ctx.displayName, ctx.channels);
    // Auto-connect after registration
    const connected = await relayClient.connect();
    return c.json({
      success: true,
      username: result.user.username,
      displayName: result.user.display_name,
      recovered: result.recovered,
      connected,
    });
  } catch (err: any) {
    return c.json({ error: err.message || 'Registration failed' }, 400);
  }
});

// ── Recover account ─────────────────────────────────────────────
relayRoutes.post('/api/relay/recover', async (c) => {
  if (!relayClient) {
    return c.json({ error: 'Relay client not initialised.' }, 503);
  }

  const body = await c.req.json<{ username: string; displayName?: string }>();
  const username = (body.username || '').toLowerCase().trim();

  const local = validateUsernameLocal(username);
  if (!local.valid) {
    return c.json({ error: local.error }, 400);
  }

  try {
    const ctx = getRegistrationContext(body.displayName);
    const result = await relayClient.recover(username, ctx.displayName, ctx.channels);
    const connected = await relayClient.connect();
    return c.json({
      success: true,
      username: result.user.username,
      displayName: result.user.display_name,
      connected,
    });
  } catch (err: any) {
    return c.json({ error: err.message || 'Recovery failed' }, 400);
  }
});

// ── Validate API key ────────────────────────────────────────────
relayRoutes.get('/api/relay/validate', async (c) => {
  if (!relayClient) {
    return c.json({ status: 'unavailable' });
  }
  const status = await relayClient.validateApiKey();
  return c.json({ status }); // 'valid' | 'invalid' | 'unreachable'
});

// ── Deregister (delete account + clear local) ───────────────────
relayRoutes.post('/api/relay/deregister', async (c) => {
  if (!relayClient) {
    return c.json({ error: 'Relay client not initialised.' }, 503);
  }
  if (!relayClient.isRegistered()) {
    return c.json({ error: 'Not registered.' }, 400);
  }

  try {
    await relayClient.deregister();
    return c.json({ success: true, message: 'Account deleted and local registration cleared.' });
  } catch (err: any) {
    return c.json({ error: err.message || 'Deregister failed' }, 500);
  }
});

// ── Update relay config (url, enabled) ──────────────────────────
relayRoutes.put('/api/relay/config', async (c) => {
  const body = await c.req.json<{ url?: string; enabled?: boolean }>();
  const config = loadConfig();

  if (!config.relay) {
    config.relay = {};
  }

  let changed = false;

  if (typeof body.enabled === 'boolean' && body.enabled !== (config.relay.enabled !== false)) {
    config.relay.enabled = body.enabled;
    changed = true;
  }

  if (body.url && body.url !== config.relay.url) {
    config.relay.url = body.url.trim();
    changed = true;
  }

  if (changed) {
    saveConfig(config);
  }

  return c.json({
    success: true,
    relay: {
      enabled: config.relay.enabled !== false,
      url: config.relay.url || 'wss://relay.cosmicstack.org/v1/ws',
      username: config.relay.username || '',
    },
    restartRequired: changed,
  });
});

// ── Lookup channel (check if device is linked) ──────────────────
relayRoutes.post('/api/relay/lookup-channel', async (c) => {
  if (!relayClient) {
    return c.json({ error: 'Relay client not initialised.' }, 503);
  }
  const body = await c.req.json<{ type: string; id: string }>();
  const result = await relayClient.lookupChannel(body.type, body.id);
  return c.json(result);
});

// ── Search users (prefix autocomplete) ──────────────────────────
relayRoutes.post('/api/relay/search-users', async (c) => {
  if (!relayClient) {
    return c.json({ error: 'Relay client not initialised.' }, 503);
  }
  if (!relayClient.isRegistered()) {
    return c.json({ users: [] });
  }
  const body = await c.req.json<{ query: string; limit?: number }>();
  const query = (body.query || '').toLowerCase().trim();
  if (!query) {
    return c.json({ users: [] });
  }
  try {
    const users = await relayClient.searchUsers(query, body.limit);
    return c.json({ users });
  } catch {
    return c.json({ users: [] });
  }
});

export default relayRoutes;
