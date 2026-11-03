import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getMercuryHome } from '../utils/config.js';

/**
 * The security log: who paired, who was approved, denied, revoked or
 * expired, remote sensitive actions and their answers, remote-access
 * changes. `~/.mercury/security/audit.jsonl`, owner-only, kept to ~1 MB
 * (the previous file is kept once as audit.1.jsonl).
 */

export type AuditKind =
  | 'pair.requested' | 'pair.approved' | 'pair.denied' | 'pair.expired' | 'pair.local'
  | 'device.revoked' | 'device.expired' | 'device.new-location' | 'device.blocked'
  | 'action.requested' | 'action.allowed' | 'action.denied'
  | 'remote.changed' | 'login.failed' | 'login.locked' | 'password.changed'
  | 'update.started';

export interface AuditEntry {
  at: string;
  kind: AuditKind;
  /** Who it was about: a device name/id, "browser", "cloud". */
  who?: string;
  ip?: string;
  detail?: string;
  /** Who decided: "cli", "desktop", "telegram", "timeout"… */
  by?: string;
}

const MAX_BYTES = 1_000_000;

export function auditPath(): string {
  return join(getMercuryHome(), 'security', 'audit.jsonl');
}

export function audit(kind: AuditKind, fields: Omit<AuditEntry, 'at' | 'kind'> = {}): void {
  try {
    const path = auditPath();
    const dir = join(getMercuryHome(), 'security');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (existsSync(path) && statSync(path).size > MAX_BYTES) renameSync(path, join(dir, 'audit.1.jsonl'));
    const entry: AuditEntry = { at: new Date().toISOString(), kind, ...fields };
    appendFileSync(path, `${JSON.stringify(entry)}\n`, { encoding: 'utf-8', mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* best effort */ }
  } catch { /* the log must never break a request */ }
}

/** The newest entries first. */
export function readAudit(limit = 50): AuditEntry[] {
  try {
    const lines = readFileSync(auditPath(), 'utf-8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).reverse().map((l) => JSON.parse(l) as AuditEntry);
  } catch {
    return [];
  }
}
