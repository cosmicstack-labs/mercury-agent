import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SecondBrainDB, isBetterSqlite3Available } from '../../memory/second-brain-db.js';
import { BeliefStore } from '../../memory/beliefs.js';
import {
  FORGET_THAT_RE,
  type BeliefCommandDeps,
  handleBeliefCommand,
  formatCounts,
  relativeTime,
} from './memory-commands.js';
import { handleChatCommand } from './chat-command.js';

/**
 * Owner Model (ADR-026) chat surface: /memory learned|beliefs|contested,
 * confirm / forget / correct / settle by list number, /forget <text>, and the
 * plain "forget that" after a `☿ Noted:` line.
 */

const sqliteAvailable = isBetterSqlite3Available();
const dirs: string[] = [];
const dbs: SecondBrainDB[] = [];
const DAY = 86_400_000;

function make(): { store: BeliefStore; deps: BeliefCommandDeps } {
  const dir = mkdtempSync(join(tmpdir(), 'mercury-memcmd-'));
  dirs.push(dir);
  const db = new SecondBrainDB(join(dir, 'sb.db'));
  db.init();
  dbs.push(db);
  const store = new BeliefStore(db.connection, 'user:owner');
  store.init();
  return { store, deps: { beliefs: store, listings: new Map(), lastNoted: new Map() } };
}

/** A held preference supported from two sessions, with a human excerpt. */
function heldPreference(store: BeliefStore, statement: string, excerpt: string, at = Date.now()) {
  const r = store.apply({ op: 'create', kind: 'preference', statement, excerpt, sessionId: 's1' }, at)!;
  store.apply({ op: 'support', beliefId: r.belief.id, excerpt, sessionId: 's2' }, at + 1);
  return store.get(r.belief.id)!;
}

// Close before removing: Windows refuses to unlink an open database file.
afterEach(() => {
  while (dbs.length) { try { dbs.pop()!.close(); } catch { /* already closed */ } }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe.skipIf(!sqliteAvailable)('memory commands (ADR-026)', () => {
  it('/memory learned lists recent beliefs numbered, with status, confidence, age and excerpt', () => {
    const { store, deps } = make();
    heldPreference(store, 'Prefers one command over many manual steps', 'just run pandoc');
    // The store stamps updated_at with the wall clock, so look back from two days later.
    deps.now = () => Date.now() + 2 * DAY;
    const out = handleBeliefCommand(deps, 'chat-1', '/memory learned')!;
    expect(out).toMatch(/^What I learned in the last 7 days:/);
    expect(out).toMatch(/1\. \[held 0\.\d\d\] Prefers one command over many manual steps — learned 2d ago \(from: "just run pandoc"\)/);
    expect(deps.listings.get('chat-1')).toHaveLength(1);
  });

  it('/memory learned <days> narrows the window and says so when empty', () => {
    const { store, deps } = make();
    heldPreference(store, 'Likes short replies', 'keep it short');
    deps.now = () => Date.now() + 10 * DAY;
    expect(handleBeliefCommand(deps, 'c', '/memory learned 3')).toBe('Nothing learned in the last 3 days.');
    expect(handleBeliefCommand(deps, 'c', '/memory learned 30')).toContain('Likes short replies');
    expect(handleBeliefCommand(deps, 'c', '/memory learned 0')).toMatch(/^Usage/);
  });

  it('/memory confirm <n> refers to the last list printed in that chat', () => {
    const { store, deps } = make();
    const a = heldPreference(store, 'Prefers dark mode everywhere', 'dark mode please');
    handleBeliefCommand(deps, 'chat-1', '/memory learned');
    expect(handleBeliefCommand(deps, 'chat-2', '/memory confirm 1')).toMatch(/^No list to pick from/);
    expect(handleBeliefCommand(deps, 'chat-1', '/memory confirm 9')).toMatch(/between 1 and 1/);
    const out = handleBeliefCommand(deps, 'chat-1', '/memory confirm 1')!;
    expect(out).toBe('Confirmed: "Prefers dark mode everywhere". I will act on it until you say otherwise.');
    expect(store.get(a.id)!.status).toBe('confirmed');
    expect(store.get(a.id)!.ownerStated).toBe(true);
  });

  it('/memory forget <n> and /memory correct <n> <text> act on the numbered belief', () => {
    const { store, deps } = make();
    const a = heldPreference(store, 'Works mostly in Python', 'my python scripts');
    const b = heldPreference(store, 'Likes bullet lists', 'use bullets');
    const listing = handleBeliefCommand(deps, 'c', '/memory learned')!;
    const order = deps.listings.get('c')!;
    expect(listing).toContain('1. ');
    const nOf = (id: string) => order.indexOf(id) + 1;
    expect(handleBeliefCommand(deps, 'c', `/memory forget ${nOf(b.id)}`)).toBe('Forgotten: "Likes bullet lists".');
    expect(store.get(b.id)!.status).toBe('forgotten');
    const corrected = handleBeliefCommand(deps, 'c', `/memory correct ${nOf(a.id)} Works mostly in TypeScript`)!;
    expect(corrected).toBe('Corrected. I now hold "Works mostly in TypeScript" instead of "Works mostly in Python".');
    const old = store.get(a.id)!;
    expect(old.status).toBe('retired');
    const replacement = store.get(old.supersededBy!)!;
    expect(replacement.status).toBe('confirmed');
    expect(replacement.ownerStated).toBe(true);
  });

  it('/forget <text> forgets the best-matching live belief and confirms back', () => {
    const { store, deps } = make();
    heldPreference(store, 'Prefers dark mode everywhere', 'dark mode');
    const keep = heldPreference(store, 'Works at Cosmic Stack', 'cosmic stack');
    expect(handleBeliefCommand(deps, 'c', '/forget dark mode')).toBe('Forgotten: "Prefers dark mode everywhere".');
    expect(store.list().map((b) => b.id)).toEqual([keep.id]);
    expect(handleBeliefCommand(deps, 'c', '/forget dark mode')).toBe('I hold nothing matching "dark mode".');
    expect(handleBeliefCommand(deps, 'c', '/forget')).toMatch(/^Usage/);
  });

  it('"forget that" right after a ☿ Noted: line forgets the noted belief, once', () => {
    const { store, deps } = make();
    const noted = heldPreference(store, 'Wants Mercury to just run things in this repo', 'stop asking');
    deps.lastNoted!.set('tg:1', noted.id);
    expect(FORGET_THAT_RE.test("Don't remember that.")).toBe(true);
    expect(handleBeliefCommand(deps, 'tg:1', 'forget that')).toBe('Forgotten: "Wants Mercury to just run things in this repo".');
    expect(store.get(noted.id)!.status).toBe('forgotten');
    expect(deps.lastNoted!.has('tg:1')).toBe(false);
    // Nothing noted (or already undone): not our message — the model answers.
    expect(handleBeliefCommand(deps, 'tg:1', 'forget that')).toBeNull();
    expect(handleBeliefCommand(deps, 'tg:2', 'undo that')).toBeNull();
  });

  it('/memory beliefs groups traits by dimension and numbers everything for confirm/forget', () => {
    const { store, deps } = make();
    const t = store.apply({ op: 'owner_stated', kind: 'trait', dimension: 'brevity', level: 'terse', statement: 'Wants short replies', excerpt: 'shorter', sessionId: 's1' })!;
    heldPreference(store, 'Always asks before publishing', 'ask me first');
    const out = handleBeliefCommand(deps, 'c', '/memory beliefs')!;
    expect(out).toContain('How you work:');
    expect(out).toContain('brevity: terse / balanced / thorough');
    expect(out).toMatch(/1\. \[confirmed 0\.\d\d\] terse — everywhere: Wants short replies/);
    expect(out).toContain('Facts and preferences:');
    expect(out).toMatch(/2\. \[held 0\.\d\d\] Always asks before publishing/);
    expect(deps.listings.get('c')![0]).toBe(t.belief.id);
  });

  it('/memory contested shows pairs and /memory settle <n> a|b confirms one and retires the other', () => {
    const { store, deps } = make();
    const now = Date.now();
    // A held trait, then a disagreeing level from another session: both become contested.
    const a = store.apply({ op: 'create', kind: 'trait', dimension: 'autonomy', level: 'just-do-it', statement: 'Just runs things', excerpt: 'go', sessionId: 's1' }, now)!;
    store.apply({ op: 'support', beliefId: a.belief.id, excerpt: 'go on', sessionId: 's2' }, now + 1);
    const b = store.apply({ op: 'create', kind: 'trait', dimension: 'autonomy', level: 'ask-first', statement: 'Wants to be asked first', excerpt: 'ask me', sessionId: 's3' }, now + 2)!;
    expect(store.get(a.belief.id)!.status).toBe('contested');
    const out = handleBeliefCommand(deps, 'c', '/memory contested')!;
    expect(out).toContain('a) ');
    expect(out).toContain('b) ');
    expect(out).toContain('/memory settle <n> a|b');
    expect(handleBeliefCommand(deps, 'c', '/memory settle 1 x')).toMatch(/^Usage/);
    const settled = handleBeliefCommand(deps, 'c', '/memory settle 1 b')!;
    expect(settled).toMatch(/^Settled: ".+" stands; the other is retired\.$/);
    const statuses = [store.get(a.belief.id)!.status, store.get(b.belief.id)!.status].sort();
    expect(statuses).toEqual(['confirmed', 'retired']);
    expect(handleBeliefCommand(deps, 'c', '/memory contested')).toBe('Nothing is contested right now.');
  });

  it('unknown /memory subcommands and bare /memory are not ours', () => {
    const { deps } = make();
    expect(handleBeliefCommand(deps, 'c', '/memory')).toBeNull();
    expect(handleBeliefCommand(deps, 'c', '/memory whatever')).toBeNull();
    expect(handleBeliefCommand(deps, 'c', 'hello')).toBeNull();
    expect(handleBeliefCommand(deps, 'c', '/memory help')).toContain('/memory learned [days]');
  });

  it('formats the honest counts and relative times', () => {
    expect(formatCounts({ candidate: 5, held: 12, confirmed: 3, contested: 1, retired: 2, forgotten: 9 }))
      .toBe('Beliefs: 12 held, 3 confirmed, 5 candidate, 1 contested, 2 retired');
    const now = Date.now();
    expect(relativeTime(now, now)).toBe('just now');
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5m ago');
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(relativeTime(now - 2 * DAY, now)).toBe('2d ago');
  });

  it('the chat dispatcher routes /memory learned, /forget and "forget that" and sends plain text', async () => {
    const { store, deps } = make();
    const noted = heldPreference(store, 'Prefers one command over many manual steps', 'just run pandoc');
    const sent: string[] = [];
    const channel = { send: async (text: string) => { sent.push(text); } };
    const agent = {
      channels: { get: () => channel },
      capabilities: { getChatCommandContext: () => ({ config: () => ({ memory: {} }) }) },
      userMemory: { beliefs: store },
      lastBeliefListing: deps.listings,
      lastNotedBeliefId: new Map<string, string>([['tg:7', noted.id]]),
    } as unknown as import('../agent.js').Agent;

    expect(await handleChatCommand(agent, '/memory learned', 'telegram', 'tg:7')).toBe(true);
    expect(sent.at(-1)).toContain('1. [held ');
    expect(sent.at(-1)).not.toContain('**');
    expect(await handleChatCommand(agent, '/memory confirm 1', 'telegram', 'tg:7')).toBe(true);
    expect(sent.at(-1)).toMatch(/^Confirmed: /);
    expect(await handleChatCommand(agent, 'forget that', 'telegram', 'tg:7')).toBe(true);
    expect(sent.at(-1)).toBe('Forgotten: "Prefers one command over many manual steps".');
    // Nothing left to undo: fall through to the model.
    expect(await handleChatCommand(agent, 'forget that', 'telegram', 'tg:7')).toBe(false);
    expect(await handleChatCommand(agent, '/forget pandoc', 'telegram', 'tg:7')).toBe(true);
    expect(sent.at(-1)).toBe('I hold nothing matching "pandoc".');
    expect(await handleChatCommand(agent, '/memory bogus', 'telegram', 'tg:7')).toBe(true);
    expect(sent.at(-1)).toContain('Memory commands:');
  });
});
