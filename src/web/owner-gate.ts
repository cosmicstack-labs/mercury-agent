import type { Context } from 'hono';
import { audit } from '../security/audit.js';
import { ownerApprovals } from '../security/owner-approvals.js';
import { isThisComputer, originOf, principalKey, principalLabel, principalOf } from './middleware.js';

/**
 * Sensitive actions from a remote device: things that could outlive the
 * device's access or hand out secrets (a shell, Allow All, a new channel
 * admin, Cloud sign-in, a skill from a URL…). On this computer they just
 * run. From anywhere else they wait for the owner: the first call returns
 * 428 with an approval id and code; once the owner allows it (on their
 * messaging channel, the CLI or Mercury Desktop here), the client repeats the
 * call with `X-Mercury-Approval: <id>`, which works once, for that device
 * and that action.
 */

export const ACTION_APPROVAL_TTL_MS = 10 * 60_000;
const MAX_OPEN_PER_DEVICE = 3;

/** Where approvals reach the owner ("Telegram", "this computer"), for the message the device shows. */
let routes: () => string[] = () => ['this computer'];
export function setApprovalRoutes(fn: () => string[]): void { routes = fn; }
export function approvalRoutes(): string[] {
  try { return routes(); } catch { return ['this computer']; }
}

export function whereToApprove(): string {
  const r = approvalRoutes();
  return r.length > 1 ? `${r.slice(0, -1).join(', ')} or ${r[r.length - 1]}` : r[0] ?? 'this computer';
}

export interface SensitiveAction {
  /** Stable id: what the grant is for ("terminal.exec", "permissions.allow-all"). */
  id: string;
  /** For the owner, in plain words: "Run a shell command". */
  title: string;
  detail?: string;
}

/** Null = go ahead; otherwise the response to return (428 waiting for the owner, 403 denied). */
export function requireOwner(c: Context, action: SensitiveAction): Response | null {
  if (isThisComputer(c)) return null;
  const principal = principalOf(c);
  const key = principalKey(principal) ?? 'unknown';
  const who = principalLabel(principal);
  const ip = originOf(c).clientIpKnown ? originOf(c).clientIp : undefined;
  const approvals = ownerApprovals();
  const presented = c.req.header('x-mercury-approval');
  if (presented) {
    if (approvals.consume(presented, { principal: key, action: action.id })) {
      audit('action.allowed', { who, ip, detail: action.title });
      return null;
    }
    const known = approvals.get(presented);
    if (known && known.status === 'denied') return c.json({ error: `The owner said no to: ${action.title}.`, approvalDenied: true }, 403);
    if (known && known.status === 'pending') return c.json({ error: `Still waiting for the owner to approve: ${action.title}.`, approvalRequired: true, approvalId: known.id, code: known.code, where: whereToApprove() }, 428);
  }
  // Asking again (a retry, a double click) reuses the question already waiting:
  // a device can't flood the owner's phone. Three open questions per device at most.
  const scope = { principal: key, action: action.id };
  const open = approvals.pendingFor(scope);
  if (!open && approvals.pendingCount(key) >= MAX_OPEN_PER_DEVICE) {
    return c.json({ error: 'Too many questions are waiting for the owner from this device. Wait for an answer first.', tooManyApprovals: true }, 429);
  }
  const a = open ?? approvals.request({ kind: 'action', title: action.title, detail: action.detail, who, ip, scope }, ACTION_APPROVAL_TTL_MS);
  if (!open) audit('action.requested', { who, ip, detail: action.title });
  return c.json({
    error: `Waiting for the owner to approve: ${action.title}. Approve it on ${whereToApprove()} (code ${a.code}), then try again.`,
    approvalRequired: true,
    approvalId: a.id,
    code: a.code,
    where: whereToApprove(),
    expiresAt: a.expiresAt,
  }, 428);
}
