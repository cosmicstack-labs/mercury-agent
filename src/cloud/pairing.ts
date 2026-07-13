import type { PairingResult, TokenRefreshResult } from './types.js';
import { hostname } from 'node:os';
import { createHash } from 'node:crypto';

let cachedMachineId: string | null = null;

export function getMachineId(): string {
  if (cachedMachineId) return cachedMachineId;

  const os = require('node:os') as typeof import('node:os');
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
  return hostname();
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
  intervalMs: number = 3_000
): Promise<PairingResult> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${apiUrl}/v1/auth/terminal/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });

      if (res.status === 200) {
        const data = await res.json() as PairingResult & { status?: string };
        if (data.status === 'pending' || !data.jwt) {
          await sleep(intervalMs);
          continue;
        }
        return data;
      }

      if (res.status === 202) {
        await sleep(intervalMs);
        continue;
      }

      if (res.status === 404) {
        throw new Error('Pairing code not found or expired');
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('not found')) {
        throw err;
      }
    }

    await sleep(intervalMs);
  }

  throw new Error('Pairing timed out — try again');
}

export async function refreshToken(
  apiUrl: string,
  currentRefreshToken: string
): Promise<TokenRefreshResult> {
  const res = await fetch(`${apiUrl}/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: currentRefreshToken }),
  });

  if (!res.ok) {
    throw new Error(`Token refresh failed: ${res.status}`);
  }

  return (await res.json()) as TokenRefreshResult;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}