import { Hono } from 'hono';
import { audit } from '../../security/audit.js';
import { requireOwner } from '../owner-gate.js';
import { originOf, principalLabel, principalOf } from '../middleware.js';
import { peekPluginManager } from '../../plugins/manager.js';
import { isEditableVoiceProvider, listVoiceProviders, saveVoiceKey, voiceProviderInfo } from '../../plugins/voice-providers.js';
import { voiceCapabilities } from './mobile-voice.js';
import { logger } from '../../utils/logger.js';

/**
 * Voice providers (Settings → Voice on the phone and Desktop), no plugin needed:
 *
 *   GET /api/voice/providers
 *     → { providers: [{ id, name, env, uses, set, source, hint?, canEdit, note? }], capabilities }
 *   PUT /api/voice/providers/:id  { apiKey: string | null }
 *     → { ok, verified, message?, provider, capabilities } | 400/409 { ok: false, error }
 *     → 428 { approvalRequired, approvalId, code } from another device, until the owner allows it
 *
 * Keys live in Mercury's shared key store under the Optimus plugin's env
 * names (plugins/voice-providers.ts), so Optimus and these screens edit the
 * same keys. Responses never carry a key; the audit log never does either.
 */
const voiceProviders = new Hono();

voiceProviders.get('/api/voice/providers', (c) =>
  c.json({ providers: listVoiceProviders(), capabilities: voiceCapabilities() }, 200, { 'Cache-Control': 'no-store' }));

voiceProviders.put('/api/voice/providers/:id', async (c) => {
  const id = c.req.param('id');
  if (id === 'openai') return c.json({ ok: false, verified: false, error: 'The OpenAI key is your OpenAI model\'s. Change it in Settings → Models.' }, 400);
  if (!isEditableVoiceProvider(id)) return c.json({ ok: false, verified: false, error: 'Unknown voice provider.' }, 404);
  const body = (await c.req.json().catch(() => null)) as { apiKey?: unknown } | null;
  if (!body || !('apiKey' in body) || (body.apiKey !== null && typeof body.apiKey !== 'string')) {
    return c.json({ ok: false, verified: false, error: 'apiKey must be a string, or null to remove the key.' }, 400);
  }
  const info = voiceProviderInfo(id);
  const removing = body.apiKey === null || (body.apiKey as string).trim() === '';
  // Set on the computer: nothing to approve, it can't be changed from here.
  if (info.source === 'env') {
    return c.json({ ok: false, verified: false, error: `${info.name}'s key is set on the computer (${info.env} in ~/.mercury/.env), which always wins. Change or remove it there.`, envSet: true }, 409);
  }
  // A key is a credential the owner pays for: from another device, the owner approves.
  const wait = requireOwner(c, { id: `voice.key:${id}`, title: removing ? `Remove the ${info.name} voice key` : `Set the ${info.name} voice key` });
  if (wait) return wait;

  const result = await saveVoiceKey(id, removing ? null : (body.apiKey as string));
  if (!result.ok) return c.json({ ok: false, verified: result.verified, error: result.error }, result.status as 400 | 409);

  const origin = originOf(c);
  audit(removing ? 'voice.key.removed' : 'voice.key.set', {
    who: principalLabel(principalOf(c)),
    ip: origin.clientIpKnown ? origin.clientIp : undefined,
    detail: `${info.name} (${info.env})${!removing && result.verified ? ', checked' : ''}`,
  });
  // Plugins (Optimus) read keys at start: restart the ones that use this one.
  const manager = peekPluginManager();
  if (manager && info.env) {
    manager.secretChanged(info.env).catch((err: unknown) => logger.warn({ err: err instanceof Error ? err.message : String(err), env: info.env }, 'Could not restart plugins after a voice key change'));
  }
  return c.json({
    ok: true, verified: result.verified, ...(result.message ? { message: result.message } : {}),
    provider: voiceProviderInfo(id), capabilities: voiceCapabilities(),
  }, 200, { 'Cache-Control': 'no-store' });
});

export default voiceProviders;
