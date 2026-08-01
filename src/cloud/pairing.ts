import type { PairingResult, TokenRefreshResult } from './types.js';
import os from 'node:os';
import { createHash } from 'node:crypto';

let cachedMachineId: string | null = null;

export type PairingFailureDetails = {
  code?: string;
  tier?: string;
  used?: number;
  limit?: number;
  nextTier?: string | null;
  upgradeUrl?: string;
};

export class PairingFailureError extends Error {
  constructor(message: string, public readonly details: PairingFailureDetails = {}) {
    super(message);
    this.name = 'PairingFailureError';
  }
}

export function getMachineId(): string {
  if (cachedMachineId) return cachedMachineId;

  const raw = [
    os.hostname(),
    os.platform(),
    os.arch(),
    os.userInfo().username,
  ].join('|');

  cachedMachineId = createHash('sha256').update(raw).digest('hex').slice(0, 32);
  return cachedMachineId;
}

export function getHostname(): string {
  return os.hostname();
}

export async function startPairingFlow(
  apiUrl: string,
  email?: string
): Promise<{ code: string; pairingUrl: string }> {
  const machineId = getMachineId();
  const host = getHostname();

  const res = await fetch(`${apiUrl}/v1/auth/terminal/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, machineId, hostname: host }),
  });

  if (!res.ok) {
    throw new Error(`Pairing request failed: ${res.status} ${res.statusText}`);
  }

  return (await res.json()) as { code: string; pairingUrl: string };
}

export async function pollPairingComplete(
  apiUrl: string,
  code: string,
  timeoutMs: number = 300_000,
  intervalMs: number = 1_500
): Promise<PairingResult> {
  const deadline = Date.now() + timeoutMs;
  let consecutiveErrors = 0;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${apiUrl}/v1/auth/terminal/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });

      if (res.status === 200) {
        consecutiveErrors = 0;
        const data = await res.json() as PairingResult & PairingFailureDetails & { status?: string; error?: string };

        // Success — has tokens and agentId
        if (data.jwt && data.refreshToken && data.agentId) {
          return data;
        }

        // Check for explicit failure from the server
        if (data.status === 'failed' && data.error) {
          throw new PairingFailureError(data.error, data);
        }

        // 200 with pending/approved/completing — keep polling
        await sleep(intervalMs);
        continue;
      }

      if (res.status === 202) {
        // Pending — keep polling
        consecutiveErrors = 0;
        await sleep(intervalMs);
        continue;
      }

      if (res.status === 404) {
        throw new Error('Pairing code not found or expired. Run `mercury cloud connect` again.');
      }

      // Non-404 error (401, 403, 500, etc.) — retry a few times, then fail
      consecutiveErrors++;
      if (consecutiveErrors >= 5) {
        const errBody = await res.json().catch(() => ({}));
        const msg = (errBody as any)?.message || `Server returned ${res.status}`;
        throw new Error(`Pairing failed after repeated errors: ${msg}`);
      }
    } catch (err) {
      // Re-throw explicit errors (not found, failed, etc.)
      if (err instanceof PairingFailureError || err instanceof Error && (err.message.includes('not found') || err.message.includes('Pairing failed'))) {
        throw err;
      }

      // Network errors — retry with backoff
      consecutiveErrors++;
      if (consecutiveErrors >= 10) {
        throw new Error(`Pairing failed: network errors — ${(err as Error).message}`);
      }
    }

    await sleep(intervalMs);
  }

  throw new Error('Pairing timed out — the browser approval was not completed in time. Run `mercury cloud connect` again.');
}

const REFRESH_RESULT_REUSE_MS = 5 * 60 * 1000;
const refreshRequests = new Map<string, { promise: Promise<TokenRefreshResult>; reusableUntil: number }>();

export function refreshToken(
  apiUrl: string,
  currentRefreshToken: string
): Promise<TokenRefreshResult> {
  const now = Date.now();
  for (const [key, entry] of refreshRequests) {
    if (entry.reusableUntil <= now) refreshRequests.delete(key);
  }

  // Refresh tokens are single-use. Every cloud consumer in this process must
  // share the same rotation result rather than racing the auth endpoint.
  const key = `${apiUrl}\0${currentRefreshToken}`;
  const existing = refreshRequests.get(key);
  if (existing) return existing.promise;

  const entry = {
    promise: performTokenRefresh(apiUrl, currentRefreshToken),
    reusableUntil: Number.POSITIVE_INFINITY,
  };
  refreshRequests.set(key, entry);
  void entry.promise.then(
    () => { entry.reusableUntil = Date.now() + REFRESH_RESULT_REUSE_MS; },
    () => { refreshRequests.delete(key); },
  );
  return entry.promise;
}

async function performTokenRefresh(apiUrl: string, currentRefreshToken: string): Promise<TokenRefreshResult> {
  const res = await fetch(`${apiUrl}/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: currentRefreshToken }),
  });

  if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`);
  return (await res.json()) as TokenRefreshResult;
}

/**
 * Redeem a long-lived agent API key for a fresh JWT + refresh-token pair.
 * This is the self-recovery path used when the refresh token has expired or
 * been consumed: the agent API key never expires (only rotation via re-pair
 * or agent deletion invalidates it), so a paired agent can always come back
 * online without a browser re-pair.
 */
export async function redeemAgentApiKey(
  apiUrl: string,
  agentApiKey: string
): Promise<TokenRefreshResult & { agentId: string }> {
  const res = await fetch(`${apiUrl}/v1/auth/agent/redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: agentApiKey }),
  });

  if (!res.ok) throw new Error(`Agent key redeem failed: ${res.status}`);
  return (await res.json()) as TokenRefreshResult & { agentId: string };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
