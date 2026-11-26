/**
 * What the owner's phones missed (ADR-046): calls nobody answered and
 * notifications sent while no phone was live. The app fetches this when it
 * comes to the foreground (GET /api/devices/me/missed), shows each item, and
 * acknowledges them; one acknowledgement clears it for every phone.
 *
 * `~/.mercury/reach/missed.json`, owner-only, newest 50 kept.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { reachDir, type Urgency } from './settings.js';

export interface MissedItem {
  id: string;
  kind: 'call' | 'notification';
  title: string;
  body: string;
  urgency: Urgency;
  /** The chat it is about, when there is one. */
  threadId?: string;
  at: string;
}

const MAX_ITEMS = 50;

function path(): string {
  return join(reachDir(), 'missed.json');
}

export function listMissed(): MissedItem[] {
  try {
    if (!existsSync(path())) return [];
    const raw = JSON.parse(readFileSync(path(), 'utf-8')) as unknown;
    return Array.isArray(raw) ? raw.filter((x): x is MissedItem => !!x && typeof x === 'object' && typeof (x as MissedItem).id === 'string') : [];
  } catch {
    return [];
  }
}

function save(items: MissedItem[]): void {
  mkdirSync(reachDir(), { recursive: true, mode: 0o700 });
  const tmp = `${path()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(items.slice(-MAX_ITEMS), null, 2), { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmp, path());
}

export function addMissed(item: Omit<MissedItem, 'id' | 'at'> & { at?: string }): MissedItem {
  const full: MissedItem = {
    ...item,
    id: `m${randomBytes(6).toString('hex')}`,
    title: item.title.slice(0, 120),
    body: item.body.slice(0, 1000),
    at: item.at ?? new Date().toISOString(),
  };
  try { save([...listMissed(), full]); } catch { /* the fallback message still goes */ }
  return full;
}

/** Acknowledge items by id, or every item with "all"; how many went. */
export function ackMissed(ids: string[] | 'all'): number {
  const items = listMissed();
  const keep = ids === 'all' ? [] : items.filter((i) => !ids.includes(i.id));
  const n = items.length - keep.length;
  if (n) save(keep);
  return n;
}
