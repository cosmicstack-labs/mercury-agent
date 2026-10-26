/**
 * The owner-facing side of the Owner Model (ADR-026, docs/owner-model.md §3.6):
 * what Mercury learned, what it believes, what is contested, and the verbs
 * the owner uses to confirm / correct / forget — as plain text for any chat.
 *
 * Everything here is pure text in, text out, so the CLI, Telegram, Signal,
 * Discord and the menus all share one implementation. Numbers in
 * `/memory confirm <n>` refer to the LAST list printed in that chat; the
 * caller keeps that list in `listings` (one entry per chat).
 */
import type { Belief, BeliefStore, BeliefStatus } from '../../memory/beliefs.js';
import { TRAIT_DIMENSIONS, SCOPED_DIMENSIONS } from '../../memory/beliefs.js';

const DAY = 86_400_000;
export const DEFAULT_LEARNED_DAYS = 7;

/** Plain-language undo right after a `☿ Noted:` line. */
export const FORGET_THAT_RE = /^(forget that|don'?t remember that|undo that)[.!]?$/i;

export interface BeliefCommandDeps {
  beliefs: BeliefStore;
  /** Per-chat numbering of the last printed list: index → belief id, or `a|b` for a contested pair. */
  listings: Map<string, string[]>;
  /** Per-chat id of the belief announced by the last `☿ Noted:` line. */
  lastNoted?: Map<string, string>;
  now?: () => number;
}

// ── formatting ───────────────────────────────────────────────────────────

export function relativeTime(at: number, now = Date.now()): string {
  const diff = Math.max(0, now - at);
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < DAY) return `${Math.round(diff / 3_600_000)}h ago`;
  if (diff < 30 * DAY) return `${Math.round(diff / DAY)}d ago`;
  return `${Math.round(diff / (30 * DAY))}mo ago`;
}

function tag(store: BeliefStore, b: Belief, now: number): string {
  return `[${b.status} ${store.confidence(b, now).toFixed(2)}]`;
}

function excerptFor(store: BeliefStore, b: Belief): string {
  const ev = store.evidenceFor(b.id, 3).find((e) => e.kind !== 'migration' && e.kind !== 'acted-on-ok' && e.kind !== 'reflection' && e.excerpt.length > 0);
  if (!ev) return '';
  const text = ev.excerpt.replace(/\s+/g, ' ').trim();
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

/** `1. [held 0.72] Prefers one command — learned 2d ago (from: "just run pandoc")` */
export function formatLearnedLine(store: BeliefStore, n: number, b: Belief, now: number): string {
  const excerpt = excerptFor(store, b);
  const from = excerpt ? ` (from: "${excerpt}")` : '';
  const verb = b.status === 'confirmed' && b.ownerStated ? 'stated' : 'learned';
  return `${n}. ${tag(store, b, now)} ${b.statement} — ${verb} ${relativeTime(b.updatedAt, now)}${from}`;
}

/** `Beliefs: 12 held, 3 confirmed, 5 candidate, 1 contested, 2 retired` */
export function formatCounts(counts: Record<BeliefStatus, number>): string {
  return `Beliefs: ${counts.held} held, ${counts.confirmed} confirmed, ${counts.candidate} candidate, ${counts.contested} contested, ${counts.retired} retired`;
}

function dimensionLabel(dimension: string): string {
  const [base, scope] = dimension.split(':', 2);
  const levels = (TRAIT_DIMENSIONS as Record<string, readonly string[]>)[base] ?? (SCOPED_DIMENSIONS as Record<string, readonly string[]>)[base];
  const name = scope ? `${base} (${scope})` : base;
  return levels ? `${name}: ${levels.join(' / ')}` : name;
}

function contextLabel(context: string): string {
  return context === '*' ? 'everywhere' : context;
}

// ── views ────────────────────────────────────────────────────────────────

/** The "what I learned" view: a numbered list the owner can act on. */
export function renderLearned(deps: BeliefCommandDeps, channelId: string, days = DEFAULT_LEARNED_DAYS, limit = 20): string {
  const now = deps.now?.() ?? Date.now();
  const recent = deps.beliefs.recentlyLearned(now - days * DAY, limit);
  if (recent.length === 0) {
    deps.listings.delete(channelId);
    return `Nothing learned in the last ${days} day${days === 1 ? '' : 's'}.`;
  }
  const lines = [`What I learned in the last ${days} day${days === 1 ? '' : 's'}:`, ''];
  recent.forEach((b, i) => lines.push(formatLearnedLine(deps.beliefs, i + 1, b, now)));
  deps.listings.set(channelId, recent.map((b) => b.id));
  lines.push('', 'Reply /memory confirm <n>, /memory forget <n> or /memory correct <n> <what is true>.');
  return lines.join('\n');
}

/** The "what I believe about you" view: traits by dimension, then confirmed and held preferences. */
export function renderBeliefs(deps: BeliefCommandDeps, channelId: string): string {
  const now = deps.now?.() ?? Date.now();
  const live = deps.beliefs.list({ statuses: ['held', 'confirmed', 'contested'] });
  const traits = live.filter((b) => b.kind === 'trait' && b.dimension);
  const prefs = live.filter((b) => b.kind !== 'trait')
    .sort((a, b) => Number(b.status === 'confirmed') - Number(a.status === 'confirmed') || deps.beliefs.confidence(b, now) - deps.beliefs.confidence(a, now));
  if (traits.length === 0 && prefs.length === 0) {
    deps.listings.delete(channelId);
    return 'I hold no beliefs about you yet. They form as we work together; say /memory learned to watch them arrive.';
  }
  const ids: string[] = [];
  const lines: string[] = ['What I believe about you:'];
  if (traits.length > 0) {
    const byDimension = new Map<string, Belief[]>();
    for (const t of traits) {
      const list = byDimension.get(t.dimension!) ?? [];
      list.push(t);
      byDimension.set(t.dimension!, list);
    }
    lines.push('', 'How you work:');
    for (const [dimension, list] of [...byDimension.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`  ${dimensionLabel(dimension)}`);
      for (const t of list.sort((a, b) => deps.beliefs.confidence(b, now) - deps.beliefs.confidence(a, now))) {
        ids.push(t.id);
        lines.push(`  ${ids.length}. ${tag(deps.beliefs, t, now)} ${t.level} — ${contextLabel(t.context)}${t.statement && t.statement !== t.level ? `: ${t.statement}` : ''}`);
      }
    }
  }
  if (prefs.length > 0) {
    lines.push('', 'Facts and preferences:');
    for (const p of prefs.slice(0, 40)) {
      ids.push(p.id);
      const ctx = p.context === '*' ? '' : ` (${p.context})`;
      lines.push(`  ${ids.length}. ${tag(deps.beliefs, p, now)} ${p.statement}${ctx}`);
    }
  }
  deps.listings.set(channelId, ids);
  lines.push('', 'Reply /memory confirm <n>, /memory forget <n> or /memory correct <n> <what is true>.');
  return lines.join('\n');
}

/** Contested pairs the owner can settle. */
export function renderContested(deps: BeliefCommandDeps, channelId: string): string {
  const now = deps.now?.() ?? Date.now();
  const pairs = deps.beliefs.contested();
  if (pairs.length === 0) {
    deps.listings.delete(channelId);
    return 'Nothing is contested right now.';
  }
  const ids: string[] = [];
  const lines = ['Contested — the evidence points both ways:', ''];
  pairs.forEach(({ a, b }, i) => {
    ids.push(b ? `${a.id}|${b.id}` : a.id);
    const where = a.dimension ? `${dimensionLabel(a.dimension).split(':')[0]}, ${contextLabel(a.context)}` : contextLabel(a.context);
    lines.push(`${i + 1}. ${where}`);
    lines.push(`   a) ${tag(deps.beliefs, a, now)} ${a.statement}`);
    if (b) lines.push(`   b) ${tag(deps.beliefs, b, now)} ${b.statement}`);
    else lines.push('   b) neither — the evidence against it is from you');
  });
  deps.listings.set(channelId, ids);
  lines.push('', 'Reply /memory settle <n> a|b to pick the one that is true, or /memory forget <n> to drop it.');
  return lines.join('\n');
}

// ── verbs ────────────────────────────────────────────────────────────────

function pick(deps: BeliefCommandDeps, channelId: string, nText: string): { ids: string[]; n: number } | string {
  const listing = deps.listings.get(channelId);
  if (!listing || listing.length === 0) return 'No list to pick from. Say /memory learned, /memory beliefs or /memory contested first.';
  const n = Number.parseInt(nText, 10);
  if (!Number.isInteger(n) || n < 1 || n > listing.length) return `Pick a number between 1 and ${listing.length} from the last list.`;
  return { ids: listing[n - 1].split('|'), n };
}

function quote(s: string): string {
  return `"${s.replace(/\s+/g, ' ').trim()}"`;
}

export function confirmNth(deps: BeliefCommandDeps, channelId: string, nText: string): string {
  const picked = pick(deps, channelId, nText);
  if (typeof picked === 'string') return picked;
  const b = deps.beliefs.confirm(picked.ids[0], deps.now?.());
  return b ? `Confirmed: ${quote(b.statement)}. I will act on it until you say otherwise.` : 'That belief is gone already.';
}

export function forgetNth(deps: BeliefCommandDeps, channelId: string, nText: string): string {
  const picked = pick(deps, channelId, nText);
  if (typeof picked === 'string') return picked;
  const forgotten: string[] = [];
  for (const id of picked.ids) {
    const b = deps.beliefs.get(id);
    if (b && b.status !== 'forgotten' && deps.beliefs.forget(id, deps.now?.())) forgotten.push(b.statement);
  }
  if (forgotten.length === 0) return 'That belief is gone already.';
  return `Forgotten: ${forgotten.map(quote).join(' and ')}.`;
}

export function correctNth(deps: BeliefCommandDeps, channelId: string, nText: string, statement: string): string {
  const picked = pick(deps, channelId, nText);
  if (typeof picked === 'string') return picked;
  const text = statement.trim();
  if (text.length < 3) return 'Usage: /memory correct <n> <what is actually true>';
  const target = deps.beliefs.get(picked.ids[0]);
  if (!target || target.status === 'forgotten') return 'That belief is gone already.';
  const result = deps.beliefs.apply({ op: 'correction', beliefId: target.id, statement: text, excerpt: text, evidenceKind: 'owner' }, deps.now?.());
  if (!result) return 'I could not apply that correction.';
  return `Corrected. I now hold ${quote(result.belief.statement)} instead of ${quote(target.statement)}.`;
}

export function settleNth(deps: BeliefCommandDeps, channelId: string, nText: string, side: string): string {
  const picked = pick(deps, channelId, nText);
  if (typeof picked === 'string') return picked;
  const which = side.trim().toLowerCase();
  if (which !== 'a' && which !== 'b') return 'Usage: /memory settle <n> a|b';
  const [aId, bId] = picked.ids;
  if (!bId) {
    // A lone contested belief: "a" keeps it, "b" drops it.
    if (which === 'a') return confirmById(deps, aId);
    const a = deps.beliefs.get(aId);
    return a && deps.beliefs.forget(aId, deps.now?.()) ? `Forgotten: ${quote(a.statement)}.` : 'That belief is gone already.';
  }
  const winnerId = which === 'a' ? aId : bId;
  const loserId = which === 'a' ? bId : aId;
  const winner = deps.beliefs.get(winnerId);
  if (!winner || winner.status === 'forgotten') return 'That belief is gone already.';
  deps.beliefs.settle(winnerId, loserId, deps.now?.());
  return `Settled: ${quote(winner.statement)} stands; the other is retired.`;
}

function confirmById(deps: BeliefCommandDeps, id: string): string {
  const b = deps.beliefs.confirm(id, deps.now?.());
  return b ? `Confirmed: ${quote(b.statement)}. I will act on it until you say otherwise.` : 'That belief is gone already.';
}

/** Best live match for free text (the `/forget <text>` and `forget_memory` paths). */
export function findBeliefByText(store: BeliefStore, text: string): Belief | null {
  const live = (b: Belief) => b.status !== 'forgotten' && b.status !== 'retired';
  const hits = store.findSimilar(text, undefined, 8).filter(live);
  if (hits.length > 0) return hits[0];
  // FTS needs a word of 4+ letters; fall back to a substring scan for short queries.
  const needle = text.toLowerCase().trim();
  if (needle.length < 2) return null;
  return store.list({ limit: 500 }).find((b) => b.statement.toLowerCase().includes(needle)) ?? null;
}

export function forgetByText(deps: BeliefCommandDeps, text: string): string {
  const query = text.trim();
  if (!query) return 'Usage: /forget <what to forget>';
  const b = findBeliefByText(deps.beliefs, query);
  if (!b) return `I hold nothing matching ${quote(query)}.`;
  deps.beliefs.forget(b.id, deps.now?.());
  return `Forgotten: ${quote(b.statement)}.`;
}

/** "forget that" right after a `☿ Noted:` line. Null when there is nothing to undo. */
export function forgetLastNoted(deps: BeliefCommandDeps, channelId: string): string | null {
  const id = deps.lastNoted?.get(channelId);
  if (!id) return null;
  deps.lastNoted!.delete(channelId);
  const b = deps.beliefs.get(id);
  if (!b || b.status === 'forgotten') return 'Already forgotten.';
  deps.beliefs.forget(id, deps.now?.());
  return `Forgotten: ${quote(b.statement)}.`;
}

// ── dispatch ─────────────────────────────────────────────────────────────

export const MEMORY_SUBCOMMAND_HELP = [
  'Memory commands:',
  '  /memory learned [days]      what I learned recently',
  '  /memory beliefs             what I believe about you, with confidence',
  '  /memory contested           beliefs the evidence disputes',
  '  /memory confirm <n>         yes, that is right',
  '  /memory forget <n>          drop it for good',
  '  /memory correct <n> <text>  replace it with what is true',
  '  /memory settle <n> a|b      pick the side of a contested pair',
  '  /forget <text>              forget the belief that best matches',
].join('\n');

/**
 * Handle one chat message if it is a belief command. Returns the reply, or
 * null when the message is not one of ours (the caller falls through).
 */
export function handleBeliefCommand(deps: BeliefCommandDeps, channelId: string, content: string): string | null {
  const trimmed = content.trim();
  const lower = trimmed.toLowerCase();

  if (FORGET_THAT_RE.test(trimmed)) return forgetLastNoted(deps, channelId);

  if (lower === '/forget' || lower.startsWith('/forget ')) return forgetByText(deps, trimmed.slice('/forget'.length));

  if (!lower.startsWith('/memory ')) return null;
  const rest = trimmed.slice('/memory'.length).trim();
  const [sub = '', ...args] = rest.split(/\s+/);
  switch (sub.toLowerCase()) {
    case 'learned': {
      const days = args[0] ? Number.parseInt(args[0], 10) : DEFAULT_LEARNED_DAYS;
      if (!Number.isInteger(days) || days < 1 || days > 365) return 'Usage: /memory learned [days 1-365]';
      return renderLearned(deps, channelId, days);
    }
    case 'beliefs': case 'believe': case 'believes': return renderBeliefs(deps, channelId);
    case 'contested': return renderContested(deps, channelId);
    case 'confirm': return args[0] ? confirmNth(deps, channelId, args[0]) : 'Usage: /memory confirm <n>';
    case 'forget': return args[0] ? forgetNth(deps, channelId, args[0]) : 'Usage: /memory forget <n>';
    case 'correct': return args[0] ? correctNth(deps, channelId, args[0], args.slice(1).join(' ')) : 'Usage: /memory correct <n> <what is true>';
    case 'settle': return args[0] && args[1] ? settleNth(deps, channelId, args[0], args[1]) : 'Usage: /memory settle <n> a|b';
    case 'help': return MEMORY_SUBCOMMAND_HELP;
    default: return null;
  }
}
