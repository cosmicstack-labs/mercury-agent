import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { audit } from './audit.js';

export const PAIR_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const PAIR_CODE_LENGTH = 25;
export const PAIR_CODE_TTL_MS = 5 * 60_000;
const KEEP_ENDED_MS = 15 * 60_000;

export interface PairedDevice {
  name: string;
  platform: string;
}

export type PairOutcome =
  | { status: 'paired'; device: PairedDevice }
  | { status: 'expired' | 'replaced' | 'cancelled' };

export interface PairCodeShown {
  id: string;
  code: string;
  display: string;
  address: string;
  url: string;
  expiresAt: number;
}

interface ActiveCode {
  id: string;
  hash: Buffer;
  by: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

const sha = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

export function normalizePairCode(input: string): string {
  return input.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

export function groupPairCode(code: string): string {
  return code.match(/.{1,5}/g)?.join('-') ?? code;
}

export function pairLink(address: string, code: string): string {
  return `mercury://pair?u=${encodeURIComponent(address).replace(/%3A/gi, ':').replace(/%2F/gi, '/')}&c=${code}`;
}

export class PairCodes {
  private active: ActiveCode | null = null;
  private ended = new Map<string, { outcome: PairOutcome; at: number }>();
  private waiters = new Map<string, Array<(o: PairOutcome) => void>>();
  private readonly decoy = sha(randomBytes(32).toString('hex'));

  constructor(private readonly now: () => number = Date.now, private readonly ttlMs = PAIR_CODE_TTL_MS) {}

  create(address: string, by: string): PairCodeShown {
    this.expireIfDue();
    this.sweep();
    if (this.active) this.end({ status: 'replaced' });
    const code = Array.from({ length: PAIR_CODE_LENGTH }, () => PAIR_CODE_ALPHABET[randomInt(PAIR_CODE_ALPHABET.length)]).join('');
    const id = randomBytes(9).toString('base64url');
    const expiresAt = this.now() + this.ttlMs;
    const timer = setTimeout(() => { if (this.active?.id === id) this.end({ status: 'expired' }); }, this.ttlMs);
    timer.unref?.();
    this.active = { id, hash: sha(code), by, expiresAt, timer };
    audit('pair.code.created', { by, detail: `for ${address}` });
    return { id, code, display: groupPairCode(code), address, url: pairLink(address, code), expiresAt };
  }

  match(presented: string): { id: string; by: string } | null {
    this.expireIfDue();
    const live = this.active;
    const same = timingSafeEqual(sha(normalizePairCode(presented)), live ? live.hash : this.decoy);
    return live && same ? { id: live.id, by: live.by } : null;
  }

  redeemed(id: string, device: PairedDevice, ip?: string): boolean {
    if (this.active?.id !== id) return false;
    this.end({ status: 'paired', device });
    audit('pair.code.redeemed', { who: device.name, ip, detail: `on ${device.platform}` });
    return true;
  }

  cancel(): boolean {
    this.expireIfDue();
    if (!this.active) return false;
    this.end({ status: 'cancelled' });
    return true;
  }

  status(id: string): 'waiting' | PairOutcome | null {
    this.expireIfDue();
    if (this.active?.id === id) return 'waiting';
    return this.ended.get(id)?.outcome ?? null;
  }

  wait(id: string): Promise<PairOutcome> {
    const now = this.status(id);
    if (now === null) return Promise.resolve({ status: 'expired' });
    if (now !== 'waiting') return Promise.resolve(now);
    return new Promise((resolve) => this.waiters.set(id, [...(this.waiters.get(id) ?? []), resolve]));
  }

  private expireIfDue(): void {
    if (this.active && this.now() > this.active.expiresAt) this.end({ status: 'expired' });
  }

  private end(outcome: PairOutcome): void {
    const a = this.active;
    if (!a) return;
    this.active = null;
    clearTimeout(a.timer);
    this.ended.set(a.id, { outcome, at: this.now() });
    if (outcome.status === 'expired') audit('pair.code.expired', { detail: `(not used in ${Math.round(this.ttlMs / 60_000)} minutes)` });
    if (outcome.status === 'replaced') audit('pair.code.expired', { detail: '(replaced by a new code)' });
    if (outcome.status === 'cancelled') audit('pair.code.expired', { detail: '(cancelled)' });
    for (const w of this.waiters.get(a.id) ?? []) w(outcome);
    this.waiters.delete(a.id);
  }

  private sweep(): void {
    const t = this.now();
    for (const [id, e] of this.ended) if (t - e.at > KEEP_ENDED_MS) this.ended.delete(id);
  }
}

let shared: PairCodes | null = null;

export function pairCodes(): PairCodes {
  shared ??= new PairCodes();
  return shared;
}

export function _setPairCodes(p: PairCodes | null): void {
  shared = p;
}
