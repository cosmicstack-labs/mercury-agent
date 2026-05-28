/**
 * Browser-Use Cloud API key management.
 *
 * Source of truth for the key, in priority order:
 *   1. process.env.BROWSER_USE_API_KEY
 *   2. ~/.mercury/mercury.yaml → browserUse.apiKey  (set at runtime via setApiKey)
 *
 * Keys start with `bu_`. Get one at https://cloud.browser-use.com/settings?tab=api-keys&new=1
 *
 * Note: Unlike GitHub / ChatGPT, browser-use Cloud uses a static API key — there is
 * no OAuth or device flow. The user pastes it once and it's stored in their config.
 */

import { loadConfig, saveConfig } from '../utils/config.js';
import { logger } from '../utils/logger.js';

const BROWSER_USE_API_BASE = 'https://api.browser-use.com/api/v3';
const SIGNUP_URL = 'https://cloud.browser-use.com/settings?tab=api-keys&new=1';

export interface BrowserUseAuthState {
  hasKey: boolean;
  source: 'env' | 'config' | 'none';
  /** Last few chars of the key for display ("…abc1"). Never the full key. */
  keyHint?: string;
}

export function getBrowserUseApiKey(): string {
  const fromEnv = (process.env.BROWSER_USE_API_KEY ?? '').trim();
  if (fromEnv) return fromEnv;
  const cfg = loadConfig();
  return (cfg.browserUse?.apiKey ?? '').trim();
}

export function getBrowserUseAuthState(): BrowserUseAuthState {
  const fromEnv = (process.env.BROWSER_USE_API_KEY ?? '').trim();
  if (fromEnv) {
    return { hasKey: true, source: 'env', keyHint: '…' + fromEnv.slice(-4) };
  }
  const cfg = loadConfig();
  const fromCfg = (cfg.browserUse?.apiKey ?? '').trim();
  if (fromCfg) {
    return { hasKey: true, source: 'config', keyHint: '…' + fromCfg.slice(-4) };
  }
  return { hasKey: false, source: 'none' };
}

export function isBrowserUseConfigured(): boolean {
  return getBrowserUseApiKey().length > 0;
}

/**
 * Persist the key to the Mercury config file. The `browserUse` section is now
 * part of the strict MercuryConfig schema so no loose casts are needed.
 */
export function setBrowserUseApiKey(apiKey: string): void {
  const trimmed = apiKey.trim();
  if (!trimmed) throw new Error('API key is empty');
  if (!trimmed.startsWith('bu_')) {
    throw new Error('Browser-Use API keys start with "bu_". Get one at ' + SIGNUP_URL);
  }
  const cfg = loadConfig();
  cfg.browserUse = { ...cfg.browserUse, apiKey: trimmed };
  saveConfig(cfg);
  logger.info({ keyHint: '…' + trimmed.slice(-4) }, 'Browser-Use Cloud API key saved');
}

export function clearBrowserUseApiKey(): void {
  const cfg = loadConfig();
  if (cfg.browserUse?.apiKey) {
    cfg.browserUse = { ...cfg.browserUse, apiKey: '' };
    saveConfig(cfg);
  }
}

/**
 * Optional connectivity / key validity check. Calls the cheap /billing/account
 * endpoint which is account-scoped and returns balance.
 */
export async function validateBrowserUseApiKey(apiKey?: string): Promise<{ ok: true; balance?: string } | { ok: false; reason: string }> {
  const key = (apiKey ?? getBrowserUseApiKey()).trim();
  if (!key) return { ok: false, reason: 'No API key configured' };
  try {
    const resp = await fetch(`${BROWSER_USE_API_BASE}/billing/account`, {
      headers: { 'X-Browser-Use-API-Key': key },
    });
    if (resp.status === 401 || resp.status === 403) return { ok: false, reason: 'API key rejected by browser-use Cloud' };
    if (!resp.ok) return { ok: false, reason: `HTTP ${resp.status} ${resp.statusText}` };
    const body = (await resp.json().catch(() => ({}))) as { credit_balance?: number | string; balance?: number | string };
    const balance = body.credit_balance ?? body.balance;
    return { ok: true, balance: balance != null ? String(balance) : undefined };
  } catch (err: any) {
    return { ok: false, reason: err?.message ?? 'network error' };
  }
}

export { SIGNUP_URL as BROWSER_USE_SIGNUP_URL };
