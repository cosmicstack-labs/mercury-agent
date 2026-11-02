import { randomBytes, randomInt } from 'node:crypto';

/**
 * Asking the owner. A new device wants to pair, or a remote device wants to
 * do something that could outlive its access (a shell, Allow All, a new
 * channel admin, Cloud sign-in…). The question goes to every place the
 * owner is (their connected messaging channel, this computer's CLI and
 * Mercury Desktop), carries a short code, and is answered once, by the owner:
 * never by the device that asked. Nobody answering in time is a "no".
 */

export type ApprovalKind = 'pair' | 'action';
export type ApprovalStatus = 'pending' | 'allowed' | 'denied' | 'expired';

export interface OwnerApproval {
  id: string;
  /** Short code the owner can type ("approve K7Q2M") — no 0/O/1/I. */
  code: string;
  kind: ApprovalKind;
  /** "New device: Salman's iPhone", "Run a shell command". */
  title: string;
  detail?: string;
  /** The device (or "browser", "cloud") asking. */
  who: string;
  ip?: string;
  at: number;
  expiresAt: number;
  status: ApprovalStatus;
  decidedBy?: string;
  /** For actions: what the grant is good for (one use). */
  scope?: { principal: string; action: string };
  consumed?: boolean;
}

type Listener = (a: OwnerApproval, change: 'new' | 'decided') => void;

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const KEEP_DECIDED_MS = 15 * 60_000;

export class OwnerApprovals {
  private items = new Map<string, OwnerApproval>();
  private waiters = new Map<string, Array<(s: ApprovalStatus) => void>>();
  private listeners = new Set<Listener>();

  constructor(private readonly now: () => number = Date.now) {}

  onChange(l: Listener): () => void {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  }

  private emit(a: OwnerApproval, change: 'new' | 'decided'): void {
    for (const l of this.listeners) { try { l({ ...a }, change); } catch { /* a listener's problem */ } }
  }

  private newCode(): string {
    const taken = new Set([...this.items.values()].filter((a) => a.status === 'pending').map((a) => a.code));
    for (;;) {
      const code = Array.from({ length: 5 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
      if (!taken.has(code)) return code;
    }
  }

  request(input: Pick<OwnerApproval, 'kind' | 'title' | 'who'> & Partial<Pick<OwnerApproval, 'detail' | 'ip' | 'scope'>>, ttlMs: number): OwnerApproval {
    this.sweep();
    const at = this.now();
    const a: OwnerApproval = { ...input, id: randomBytes(9).toString('base64url'), code: this.newCode(), at, expiresAt: at + ttlMs, status: 'pending' };
    this.items.set(a.id, a);
    const timer = setTimeout(() => this.expire(a.id), ttlMs);
    timer.unref?.();
    this.emit(a, 'new');
    return { ...a };
  }

  private expire(id: string): void {
    const a = this.items.get(id);
    if (!a || a.status !== 'pending') return;
    a.status = 'expired';
    a.decidedBy = 'timeout';
    this.settle(a);
  }

  private settle(a: OwnerApproval): void {
    for (const w of this.waiters.get(a.id) ?? []) w(a.status);
    this.waiters.delete(a.id);
    this.emit(a, 'decided');
  }

  /** By id or by its code (case-insensitive). Null when there's no such pending question. */
  find(idOrCode: string): OwnerApproval | null {
    const key = idOrCode.trim();
    const a = this.items.get(key) ?? [...this.items.values()].find((x) => x.status === 'pending' && x.code === key.toUpperCase());
    return a ? { ...a } : null;
  }

  decide(idOrCode: string, decision: 'allow' | 'deny', by: string): OwnerApproval | null {
    const found = this.find(idOrCode);
    const a = found ? this.items.get(found.id) : undefined;
    if (!a || a.status !== 'pending') return null;
    if (this.now() > a.expiresAt) { this.expire(a.id); return null; }
    a.status = decision === 'allow' ? 'allowed' : 'denied';
    a.decidedBy = by;
    this.settle(a);
    return { ...a };
  }

  /** Resolves when it's decided (or expires). */
  wait(id: string): Promise<ApprovalStatus> {
    const a = this.items.get(id);
    if (!a) return Promise.resolve('expired');
    if (a.status !== 'pending') return Promise.resolve(a.status);
    return new Promise((resolve) => this.waiters.set(id, [...(this.waiters.get(id) ?? []), resolve]));
  }

  /** An allowed action approval, used once, by the principal and for the action it was asked for. */
  consume(id: string, scope: { principal: string; action: string }): boolean {
    const a = this.items.get(id);
    if (!a || a.kind !== 'action' || a.status !== 'allowed' || a.consumed) return false;
    if (!a.scope || a.scope.principal !== scope.principal || a.scope.action !== scope.action) return false;
    if (this.now() > a.expiresAt + KEEP_DECIDED_MS) return false;
    a.consumed = true;
    return true;
  }

  /** A question this principal already has waiting for this action (asking again doesn't ask again). */
  pendingFor(scope: { principal: string; action: string }): OwnerApproval | null {
    const a = [...this.items.values()].find((x) => x.status === 'pending' && x.scope?.principal === scope.principal && x.scope?.action === scope.action && this.now() <= x.expiresAt);
    return a ? { ...a } : null;
  }

  /** How many questions this principal has waiting. */
  pendingCount(principal: string): number {
    return [...this.items.values()].filter((x) => x.status === 'pending' && x.scope?.principal === principal && this.now() <= x.expiresAt).length;
  }

  pending(): OwnerApproval[] {
    this.sweep();
    return [...this.items.values()].filter((a) => a.status === 'pending').sort((x, y) => x.at - y.at).map((a) => ({ ...a }));
  }

  get(id: string): OwnerApproval | null {
    const a = this.items.get(id);
    return a ? { ...a } : null;
  }

  private sweep(): void {
    const t = this.now();
    for (const [id, a] of this.items) if (a.status !== 'pending' && t - a.expiresAt > KEEP_DECIDED_MS) this.items.delete(id);
  }
}

/**
 * Ask and wait (for callers that can wait: Mercury Cloud's commands). True
 * only when the owner allowed it in time.
 */
export async function askOwner(input: { title: string; who: string; detail?: string }, ttlMs = 10 * 60_000): Promise<boolean> {
  const approvals = ownerApprovals();
  const a = approvals.request({ kind: 'action', ...input, scope: { principal: input.who, action: input.title } }, ttlMs);
  return (await approvals.wait(a.id)) === 'allowed';
}

let shared: OwnerApprovals | null = null;
export function ownerApprovals(): OwnerApprovals {
  shared ??= new OwnerApprovals();
  return shared;
}

/** Test hook. */
export function _setOwnerApprovals(a: OwnerApprovals | null): void {
  shared = a;
}
