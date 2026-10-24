/**
 * Telling the owner what Mercury learned (docs/owner-model.md §3.6).
 *
 * One short line at most per turn, only when a belief changes how Mercury
 * behaves; a contested pair becomes a question instead, asked at most once a
 * day. Trivia (facts, episodes, candidates) is never announced.
 */
import type { ApplyResult, Belief, BeliefStore } from '../memory/beliefs.js';
import path from 'node:path';

export const ASK_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const ANNOUNCED_CHANGES: ReadonlySet<ApplyResult['change']> = new Set(['now-held', 'confirmed', 'replaced', 'contested']);

export interface AnnounceOptions {
  beliefs: Pick<BeliefStore, 'contested' | 'getMeta' | 'setMeta'>;
  now?: number;
}

const TRAIT_PHRASES: Record<string, Record<string, string>> = {
  brevity: { terse: "you'd rather I keep replies short", balanced: 'you want replies of moderate length', thorough: "you'd rather I answer thoroughly" },
  autonomy: { 'ask-first': 'you want me to ask before acting', 'ask-when-risky': 'you want me to ask only before risky actions', 'just-do-it': "you'd rather I just run things without asking" },
  'decision-style': { options: "you'd rather see options", recommendation: 'you want a recommendation, not a menu', 'decide-for-me': "you'd rather I just decide" },
  formality: { casual: 'you prefer a casual tone', neutral: 'you prefer a neutral tone', formal: 'you prefer a formal tone' },
  'feedback-style': { blunt: 'you correct me bluntly', explains: 'you explain when you correct me', 'silent-redo': 'you redo things rather than correct me' },
  rhythm: { morning: "you're usually around in the morning", daytime: "you're usually around during the day", evening: "you're usually around in the evening", 'late-night': "you're usually around late at night" },
};

const THIRD_TO_SECOND: Array<[RegExp, string]> = [
  [/^prefers\b/i, 'prefer'], [/^likes\b/i, 'like'], [/^dislikes\b/i, 'dislike'], [/^wants\b/i, 'want'], [/^needs\b/i, 'need'],
  [/^uses\b/i, 'use'], [/^works\b/i, 'work'], [/^is\b/i, 'are'], [/^has\b/i, 'have'], [/^does\b/i, 'do'], [/^avoids\b/i, 'avoid'],
  [/^expects\b/i, 'expect'], [/^hates\b/i, 'hate'], [/^lives\b/i, 'live'], [/^runs\b/i, 'run'], [/^keeps\b/i, 'keep'],
];

function contextPhrase(context: string): string {
  if (!context || context === '*') return '';
  if (context.startsWith('project:')) return ` in ${path.basename(context.slice('project:'.length)) || 'that project'}`;
  if (context.startsWith('channel:')) return ` on ${context.slice('channel:'.length)}`;
  if (context.startsWith('domain:')) return ` for ${context.slice('domain:'.length)}`;
  if (context.startsWith('time:')) return ` in the ${context.slice('time:'.length).replace('-', ' ')}`;
  return ` (${context})`;
}

/** The belief in plain second-person language, for a one-line note. */
export function restate(b: Pick<Belief, 'kind' | 'dimension' | 'level' | 'statement' | 'context'>): string {
  const ctx = contextPhrase(b.context);
  if (b.kind === 'trait' && b.dimension && b.level) {
    const fixed = TRAIT_PHRASES[b.dimension]?.[b.level];
    if (fixed) return `${fixed}${ctx}`;
    const colon = b.dimension.indexOf(':');
    const base = colon > 0 ? b.dimension.slice(0, colon) : b.dimension;
    const domain = colon > 0 ? b.dimension.slice(colon + 1) : '';
    if (base === 'expertise') {
      const phrase = b.level === 'expert' ? `you're an expert in ${domain}` : b.level === 'novice' ? `you're new to ${domain}` : `you're competent in ${domain}`;
      return `${phrase}${ctx}`;
    }
    if (base === 'risk') return `you're ${b.level} about ${domain}${ctx}`;
  }
  let s = b.statement.trim().replace(/[.。]+$/, '');
  const owner = /^(the\s+)?(owner|user)\s+/i;
  if (owner.test(s)) {
    s = s.replace(owner, '');
    for (const [re, to] of THIRD_TO_SECOND) if (re.test(s)) { s = s.replace(re, to); break; }
    s = `you ${s.charAt(0).toLowerCase()}${s.slice(1)}`;
  } else {
    s = `${s.charAt(0).toLowerCase()}${s.slice(1)}`;
  }
  return `${s}${ctx}`;
}

function askedRecently(beliefs: AnnounceOptions['beliefs'], id: string, now: number): boolean {
  const iso = beliefs.getMeta(`asked:${id}`);
  if (!iso) return false;
  const at = Date.parse(iso);
  return Number.isFinite(at) && now - at < ASK_COOLDOWN_MS;
}

function question(a: Belief, b: Belief | null): string {
  return b
    ? `☿ I've noticed ${restate(a)} but also ${restate(b)}. Which should I go with?`
    : `☿ I've noticed ${restate(a)}, but I'm no longer sure. Is that still right?`;
}

/** Ask about a contested pair now (marks both as asked); null when it was asked within the last day. */
function askContested(beliefs: AnnounceOptions['beliefs'], a: Belief, b: Belief | null, now: number): string | null {
  if (askedRecently(beliefs, a.id, now) || (b && askedRecently(beliefs, b.id, now))) return null;
  const iso = new Date(now).toISOString();
  beliefs.setMeta(`asked:${a.id}`, iso);
  if (b) beliefs.setMeta(`asked:${b.id}`, iso);
  return question(a, b);
}

/**
 * The one line to append after a reply, or null. Contested results become a
 * question; otherwise the first behaviour-changing result becomes a note.
 */
export function composeLearnedNote(results: ReadonlyArray<ApplyResult | null>, opts: AnnounceOptions): string | null {
  const now = opts.now ?? Date.now();
  const changing = results.filter((r): r is ApplyResult => !!r && r.behaviorChanging && ANNOUNCED_CHANGES.has(r.change));
  if (changing.length === 0) return null;
  for (const r of changing) {
    if (r.change !== 'contested') continue;
    const pair = opts.beliefs.contested().find((p) => p.a.id === r.belief.id || p.b?.id === r.belief.id);
    const a = pair?.a ?? r.belief;
    const b = pair ? pair.b : null;
    const q = askContested(opts.beliefs, a, b, now);
    if (q) return q;
  }
  const noted = changing.find((r) => r.change !== 'contested');
  if (!noted) return null;
  return `☿ Noted: ${restate(noted.belief)}. Say "forget that" to undo.`;
}

/**
 * The contested question the extractor should know about: the pair asked in
 * the last day (the owner may be answering it now), else the oldest pair not
 * yet asked. Does not mark anything as asked; composeLearnedNote does that.
 */
export function pendingQuestion(beliefs: AnnounceOptions['beliefs'], now = Date.now()): string | null {
  const pairs = beliefs.contested().slice().sort((x, y) => x.a.updatedAt - y.a.updatedAt);
  const asked = pairs.find(({ a, b }) => askedRecently(beliefs, a.id, now) || (b && askedRecently(beliefs, b.id, now)));
  if (asked) return question(asked.a, asked.b);
  const next = pairs[0];
  return next ? question(next.a, next.b) : null;
}
