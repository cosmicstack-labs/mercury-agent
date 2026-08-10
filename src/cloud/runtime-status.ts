import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getMercuryHome } from '../utils/config.js';

function statusPath(): string {
  return join(getMercuryHome(), 'cloud-online.json');
}

export function markCloudRuntimeOnline(agentId: string, mode: 'daemon' | 'foreground'): void {
  writeFileSync(statusPath(), JSON.stringify({ agentId, mode, pid: process.pid, connectedAt: Date.now() }), {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

export function clearCloudRuntimeOnline(ownerPid?: number): void {
  if (ownerPid !== undefined && existsSync(statusPath())) {
    try {
      const status = JSON.parse(readFileSync(statusPath(), 'utf-8')) as { pid?: number };
      if (status.pid !== ownerPid) return;
    } catch {
      return;
    }
  }
  try { unlinkSync(statusPath()); } catch {}
}

export function isCloudRuntimeOnline(agentId: string, mode?: 'daemon' | 'foreground'): boolean {
  if (!existsSync(statusPath())) return false;
  try {
    const status = JSON.parse(readFileSync(statusPath(), 'utf-8')) as { agentId?: string; mode?: string; pid?: number };
    if (status.agentId !== agentId || !status.pid || (mode && status.mode !== mode)) return false;
    process.kill(status.pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitForCloudRuntimeOnline(
  agentId: string,
  timeoutMs = 20_000,
  mode?: 'daemon' | 'foreground',
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isCloudRuntimeOnline(agentId, mode)) return true;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return false;
}
