/**
 * Smart router for browser backend selection (Policy 3).
 *
 * Decision order:
 *   1. Permission check — domain must be in the browserDomains allowlist (PermissionManager).
 *      Sensitive domains require Local; if Local unavailable, the tool fails clearly.
 *   2. Sensitive-domain override — forces Local regardless of explicit override.
 *   3. Explicit `backend` parameter from the LLM (honors user/agent choice, subject to step 2).
 *   4. Signal-based:
 *        - no internet / no API key / Cloud budget exhausted → Local
 *        - no Local installed → Cloud (if available)
 *   5. User default from config (browserUse.defaultBackend, default 'cloud').
 *
 * Returns the chosen backend name and a human-readable reason that's surfaced
 * to the LLM in tool output so it can reason about why a particular backend ran.
 */

import type { BackendName, BrowserBackend } from './backends/base.js';
import { extractHost, looksLikeSensitiveHost } from './backends/base.js';
import { getBrowserSessionManager } from './session.js';
import type { PermissionManager } from '../permissions.js';
import { loadConfig } from '../../utils/config.js';
import { logger } from '../../utils/logger.js';

export interface RouteDecision {
  backend: BackendName;
  reason: string;
}

export interface RouteOptions {
  url: string;
  explicit?: BackendName;
  permissions: PermissionManager;
  /** Async hook that asks the user to approve the domain. Returns true if approved. */
  approveDomain?: (host: string, sensitive: boolean) => Promise<boolean>;
}

export async function chooseBackend(opts: RouteOptions): Promise<{ decision: RouteDecision; backend: BrowserBackend } | { error: string }> {
  const host = extractHost(opts.url);
  if (!host) return { error: `Invalid URL: ${opts.url}` };

  const sensitive = looksLikeSensitiveHost(host);

  // Step 1 — permission check
  const allowed = await checkDomainPermission(opts.permissions, host, sensitive, opts.approveDomain);
  if (!allowed) {
    return { error: `Permission denied for domain ${host}. Use approve_url_scope to allow it.` };
  }

  const mgr = getBrowserSessionManager();
  const cloud = mgr.getCloudBackend();
  const local = mgr.getLocalBackend();
  const cloudOk = cloud ? await cloud.isAvailable() : { ok: false as const, reason: 'BROWSER_USE_API_KEY not configured' };
  const localOk = await local.isAvailable();

  // Step 2 — sensitive domain forces Local
  if (sensitive) {
    if (localOk.ok) {
      return { backend: local, decision: { backend: 'local', reason: `sensitive domain (${host}) → forced Local` } };
    }
    return {
      error: `Domain ${host} is treated as sensitive and must use the local browser, but Local is unavailable: ${localOk.reason}. Run \`mercury browser install\` to enable it, or remove ${host} from the sensitive list if you accept routing it through Cloud.`,
    };
  }

  // Step 3 — explicit override
  if (opts.explicit === 'cloud') {
    if (cloudOk.ok && cloud) return { backend: cloud, decision: { backend: 'cloud', reason: 'explicit override' } };
    return { error: `Cloud backend requested but unavailable: ${'reason' in cloudOk ? cloudOk.reason : 'unknown'}` };
  }
  if (opts.explicit === 'local') {
    if (localOk.ok) return { backend: local, decision: { backend: 'local', reason: 'explicit override' } };
    return { error: `Local backend requested but unavailable: ${localOk.reason}` };
  }

  // Step 4 — signal-based selection
  if (!cloudOk.ok && localOk.ok) {
    return { backend: local, decision: { backend: 'local', reason: `cloud unavailable (${'reason' in cloudOk ? cloudOk.reason : 'unknown'}) → fallback to local` } };
  }
  if (cloudOk.ok && cloud && !localOk.ok) {
    return { backend: cloud, decision: { backend: 'cloud', reason: 'local unavailable, cloud configured' } };
  }
  if (!cloudOk.ok && !localOk.ok) {
    return {
      error: `Both backends unavailable. Cloud: ${'reason' in cloudOk ? cloudOk.reason : 'unknown'}. Local: ${localOk.reason}. Configure one with \`mercury browser auth\` (cloud) or \`mercury browser install\` (local).`,
    };
  }

  // Step 5 — user default
  const def = readDefaultBackend();
  if (def === 'local' && localOk.ok) return { backend: local, decision: { backend: 'local', reason: 'user default' } };
  if (cloud && cloudOk.ok) return { backend: cloud, decision: { backend: 'cloud', reason: 'user default' } };
  // Fallback chain — should be unreachable given checks above but defensive:
  if (localOk.ok) return { backend: local, decision: { backend: 'local', reason: 'final fallback' } };
  return { error: 'No browser backend available.' };
}

function readDefaultBackend(): BackendName {
  try {
    const raw = loadConfig().browserUse?.defaultBackend;
    return raw === 'local' ? 'local' : 'cloud';
  } catch {
    return 'cloud';
  }
}

async function checkDomainPermission(
  permissions: PermissionManager,
  host: string,
  sensitive: boolean,
  approveDomain?: (host: string, sensitive: boolean) => Promise<boolean>,
): Promise<boolean> {
  if (isDomainAllowed(permissions, host)) return true;
  if (!approveDomain) {
    logger.warn({ host }, 'No approveDomain handler — denying browser navigation to new domain');
    return false;
  }
  const ok = await approveDomain(host, sensitive);
  if (ok) addAllowedDomain(permissions, host);
  return ok;
}

/**
 * Domain allowlist storage lives on the PermissionManager's manifest under
 * `capabilities.browser.allowedDomains`. Suffix-matched so approving
 * `example.com` also covers subdomains.
 */
export function isDomainAllowed(permissions: PermissionManager, host: string): boolean {
  const list = permissions.getManifest().capabilities.browser?.allowedDomains ?? [];
  const h = host.toLowerCase();
  for (const entry of list) {
    const e = entry.toLowerCase();
    if (h === e || h.endsWith('.' + e)) return true;
  }
  return false;
}

export function addAllowedDomain(permissions: PermissionManager, host: string): void {
  const m = permissions.getManifest();
  if (!m.capabilities.browser) m.capabilities.browser = { enabled: true, allowedDomains: [] };
  if (!Array.isArray(m.capabilities.browser.allowedDomains)) m.capabilities.browser.allowedDomains = [];
  const h = host.toLowerCase();
  if (!m.capabilities.browser.allowedDomains.includes(h)) {
    m.capabilities.browser.allowedDomains.push(h);
    permissions.save();
    logger.info({ host: h }, 'Domain added to browser allowlist');
  }
}
