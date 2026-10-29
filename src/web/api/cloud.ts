import { Hono } from 'hono';
import { getActiveProviders, isProviderConfigured, loadConfig, updateConfig, type MercuryConfig, type ProviderName } from '../../utils/config.js';
import { isChatModelId } from '../../utils/provider-models.js';
import { MERCURY_CLOUD_API_URL, MERCURY_CLOUD_WS_URL } from '../../cloud/endpoints.js';
import { PairingFailureError, pollPairingComplete, startPairingFlow } from '../../cloud/pairing.js';
import { clearCloudTokenStore, getCloudTokenStore } from '../../cloud/token-store.js';
import { clearCloudRuntimeOnline } from '../../cloud/runtime-status.js';
import { isCloudRuntimeOnline } from '../../cloud/runtime-status.js';
import { spawnDetachedRestart } from '../../cli/daemon.js';
import type { PairingResult } from '../../cloud/types.js';
import { logger } from '../../utils/logger.js';

/**
 * Mercury Cloud from any client: is it working, and sign in again when the
 * session has expired, without a terminal.
 *
 *   GET    /api/cloud/status    paired? chat key working? agent session online, offline or signed out?
 *   POST   /api/cloud/signin    start browser pairing → { code, pairingUrl }; the runtime waits for approval
 *   GET    /api/cloud/signin    pairing progress: pending | done | failed
 *   DELETE /api/cloud/signin    stop waiting
 *   POST   /api/cloud/enabled   { enabled } — use Cloud for chat or not (stay signed in either way)
 *   POST   /api/cloud/signout   forget the Cloud sign-in on this computer, then restart
 *
 * A finished sign-in saves the new credentials and restarts the runtime so
 * the agent connection and the provider both start fresh with them.
 */

type Fetch = typeof fetch;
let doFetch: Fetch = (...args) => fetch(...args);
let restart: () => boolean = spawnDetachedRestart;
let poll: typeof pollPairingComplete = pollPairingComplete;
let start: typeof startPairingFlow = startPairingFlow;
/** Test seams. */
export function setCloudTestHooks(h: { fetch?: Fetch; restart?: () => boolean; poll?: typeof pollPairingComplete; start?: typeof startPairingFlow }): void {
  if (h.fetch) doFetch = h.fetch;
  if (h.restart) restart = h.restart;
  if (h.poll) poll = h.poll;
  if (h.start) start = h.start;
}

type SessionState = 'online' | 'offline' | 'signed-out' | 'off';

interface ChatProbe { ok: boolean; models: string[]; error: string | null; at: number; key: string }
let chatProbe: ChatProbe | null = null;

async function probeChat(config: MercuryConfig, fresh: boolean): Promise<ChatProbe> {
  const key = config.providers.mercuryCloud.apiKey;
  const apiUrl = config.cloud.apiUrl || MERCURY_CLOUD_API_URL;
  if (!fresh && chatProbe && chatProbe.key === key && Date.now() - chatProbe.at < 30_000) return chatProbe;
  let result: ChatProbe;
  try {
    const res = await doFetch(`${apiUrl}/v1/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as { data?: Array<{ id: string; available?: boolean }> };
      const rows = Array.isArray(body.data) ? body.data : [];
      const allowed = rows.filter((m) => m.available !== false).map((m) => m.id).filter(isChatModelId);
      result = { ok: true, models: allowed, error: null, at: Date.now(), key };
    } else {
      result = { ok: false, models: [], error: res.status === 401 || res.status === 403 ? 'Mercury Cloud no longer accepts this sign-in.' : `Mercury Cloud answered ${res.status}.`, at: Date.now(), key };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result = { ok: false, models: [], error: /timeout|abort/i.test(msg) ? "Mercury Cloud didn't answer in 10 seconds." : `Couldn't reach Mercury Cloud: ${msg}`, at: Date.now(), key };
  }
  chatProbe = result;
  return result;
}

function sessionState(config: MercuryConfig): SessionState {
  if (!config.cloud.enabled || !config.cloud.agentId) return 'off';
  if (isCloudRuntimeOnline(config.cloud.agentId)) return 'online';
  if (getCloudTokenStore()?.isSignedOut()) return 'signed-out';
  if (!config.cloud.refreshToken && !config.cloud.agentApiKey) return 'signed-out';
  return 'offline';
}

const cloud = new Hono();

cloud.get('/api/cloud/status', async (c) => {
  const config = loadConfig();
  const paired = !!(config.cloud.enabled && config.cloud.agentId);
  const provider = config.providers.mercuryCloud;
  const chat = provider.apiKey ? await probeChat(config, c.req.query('fresh') === '1') : null;
  const session = sessionState(config);
  const model = provider.model;
  const auth = getCloudTokenStore()?.getAuthState();
  // What the owner should do next, in order of importance.
  const action = !paired && !provider.apiKey ? 'sign-in'
    : chat && !chat.ok ? 'sign-in'
    : session === 'signed-out' ? 'sign-in'
    : !isChatModelId(model) || (chat?.ok && chat.models.length > 0 && !chat.models.includes(model)) ? 'pick-model'
    : null;
  return c.json({
    paired,
    enabled: provider.enabled,
    isDefault: config.providers.default === 'mercuryCloud',
    tier: config.cloud.tier || null,
    model,
    modelOk: isChatModelId(model) && (!chat?.ok || chat.models.length === 0 || chat.models.includes(model)),
    chat: chat ? { ok: chat.ok, models: chat.models, error: chat.error } : { ok: false, models: [], error: 'Not signed in.' },
    session,
    sessionError: auth?.error ?? null,
    selfRecovers: !!config.cloud.agentApiKey,
    action,
    signin: pairing ? publicPairing() : null,
  });
});

// ── Sign in (browser pairing) ────────────────────────────────────────────────

interface Pairing { code: string; pairingUrl: string; status: 'pending' | 'done' | 'failed'; error: string | null; upgradeUrl: string | null; startedAt: number; cancelled: boolean }
let pairing: Pairing | null = null;

function publicPairing() {
  if (!pairing) return null;
  const { code, pairingUrl, status, error, upgradeUrl } = pairing;
  return { code, pairingUrl, status, error, upgradeUrl };
}

cloud.post('/api/cloud/signin', async (c) => {
  if (pairing?.status === 'pending' && Date.now() - pairing.startedAt < 290_000) return c.json(publicPairing());
  const config = loadConfig();
  const apiUrl = config.cloud.apiUrl || MERCURY_CLOUD_API_URL;
  let started: { code: string; pairingUrl: string };
  try {
    started = await start(apiUrl, undefined);
  } catch (err) {
    return c.json({ error: `Couldn't start sign-in: ${err instanceof Error ? err.message : String(err)}` }, 502);
  }
  const current: Pairing = { ...started, status: 'pending', error: null, upgradeUrl: null, startedAt: Date.now(), cancelled: false };
  pairing = current;
  void poll(apiUrl, started.code).then((result) => {
    if (current.cancelled) return;
    finishSignIn(result);
    current.status = 'done';
    chatProbe = null;
    // Fresh credentials: restart so the agent connection and provider start clean.
    setTimeout(() => { if (!restart()) logger.error('Signed in to Mercury Cloud, but could not restart; run `mercury restart`'); }, 300);
  }).catch((err) => {
    if (current.cancelled) return;
    current.status = 'failed';
    current.error = err instanceof Error ? err.message : String(err);
    if (err instanceof PairingFailureError) current.upgradeUrl = err.details.upgradeUrl ?? null;
  });
  return c.json(publicPairing());
});

cloud.get('/api/cloud/signin', (c) => c.json(publicPairing() ?? { status: 'none' }));

cloud.delete('/api/cloud/signin', (c) => {
  if (pairing && pairing.status === 'pending') pairing.cancelled = true;
  pairing = null;
  return c.json({ ok: true });
});

/** Another working provider to fall back on, if any (Cloud can't be turned off or signed out of when it's the only one). */
function otherProvider(config: MercuryConfig): ProviderName | null {
  const other = getActiveProviders(config).find((p) => p.name !== 'mercuryCloud');
  return other ? (other.name as ProviderName) : null;
}

let reload: (() => Promise<unknown>) | null = null;
/** How a change reaches the running agent without a restart (registered by the runtime). */
export function setCloudReload(fn: (() => Promise<unknown>) | null): void { reload = fn; }

cloud.post('/api/cloud/enabled', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { enabled?: unknown };
  if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled must be true or false' }, 400);
  const config = loadConfig();
  if (body.enabled && !config.providers.mercuryCloud.apiKey) return c.json({ error: 'Sign in to Mercury Cloud first.' }, 409);
  const fallback = otherProvider(config);
  if (!body.enabled && !fallback) {
    return c.json({ error: 'Mercury Cloud is the only model connected. Connect another provider below before turning it off, or Mercury would have nothing to think with.', needsOther: true }, 409);
  }
  updateConfig((latest) => {
    latest.providers.mercuryCloud.enabled = body.enabled as boolean;
    if (!body.enabled && latest.providers.default === 'mercuryCloud' && fallback) latest.providers.default = fallback;
  });
  chatProbe = null;
  try { await reload?.(); } catch (err) { logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Applying the Cloud change failed; it applies on restart'); }
  return c.json({ ok: true, enabled: body.enabled, default: loadConfig().providers.default });
});

cloud.post('/api/cloud/signout', (c) => {
  const config = loadConfig();
  const fallback = otherProvider(config);
  updateConfig((latest) => {
    latest.cloud.enabled = false;
    latest.cloud.jwt = '';
    latest.cloud.refreshToken = '';
    latest.cloud.agentId = '';
    latest.cloud.agentApiKey = '';
    latest.cloud.accessKey = '';
    latest.providers.mercuryCloud.enabled = false;
    latest.providers.mercuryCloud.apiKey = '';
    if (latest.providers.default === 'mercuryCloud' && fallback) latest.providers.default = fallback;
  });
  clearCloudTokenStore();
  clearCloudRuntimeOnline();
  chatProbe = null;
  if (pairing) { pairing.cancelled = true; pairing = null; }
  // Restart so the agent connection and every cached Cloud token are gone for good.
  // With no other provider, Mercury comes back in setup mode and asks for one.
  setTimeout(() => { if (!restart()) logger.error('Signed out of Mercury Cloud, but could not restart; run `mercury restart`'); }, 300);
  return c.json({ ok: true, restarting: true, fallback, setupNext: !fallback });
});

/** Save new Cloud credentials, the same way `mercury cloud connect` does, keeping a good model choice. */
export function finishSignIn(result: PairingResult): void {
  updateConfig((latest) => {
    const previous = latest.cloud;
    latest.cloud = {
      ...previous,
      enabled: true,
      apiUrl: previous.apiUrl || MERCURY_CLOUD_API_URL,
      wsUrl: previous.wsUrl || MERCURY_CLOUD_WS_URL,
      jwt: result.jwt,
      refreshToken: result.refreshToken,
      agentId: result.agentId,
      tier: result.tier || previous.tier || 'free',
      // The long-lived recovery key. Without it an expired session can't heal itself.
      agentApiKey: result.apiKey || (result.agentId === previous.agentId ? previous.agentApiKey : ''),
      accessKey: result.accessKey || '',
    };
    const p = latest.providers.mercuryCloud;
    p.apiKey = latest.cloud.accessKey || latest.cloud.jwt;
    p.enabled = true;
    if (!p.model || !isChatModelId(p.model)) p.model = 'mercury-mini';
    // Quick start: Cloud becomes the default unless another working default is already chosen.
    const def = latest.providers[latest.providers.default];
    if (latest.providers.default === 'mercuryCloud' || !def || !isProviderConfigured(def)) latest.providers.default = 'mercuryCloud';
  });
}

export default cloud;
