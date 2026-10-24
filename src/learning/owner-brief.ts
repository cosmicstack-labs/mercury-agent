/**
 * The owner brief: the two stable prompt sections that tell the chat model
 * who it works for and how to work with them, built from the belief store
 * (docs/owner-model.md §3.5, ADR-026).
 *
 *   ## About {owner}            — stated facts, preferences, goals, projects,
 *                                 people; inferred ones are hedged
 *   ## How to work with {owner} — the working traits turned into instructions
 *
 * Both are regenerated only when the beliefs change (the reflection pass or
 * a per-turn operation), never per turn, so the provider's prompt cache
 * holds. The same text is written to ~/.mercury/soul/owner.md so the owner
 * can read it; lines they add under "## My notes" are read back by the
 * reflection pass as owner-stated facts.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getMercuryHome } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { SCOPED_DIMENSIONS, TRAIT_DIMENSIONS, type Belief, type BeliefStore } from '../memory/beliefs.js';

export interface OwnerSections {
  about: string;
  howToWork: string;
}

/** Stored in belief_meta under `brief` by the reflection pass. */
export interface StoredBrief extends OwnerSections {
  /** When the reflection wrote it. */
  at: number;
  /** `beliefStateSignature()` at that moment; the deterministic build wins once a belief changes. */
  sig: string;
}

export const OWNER_FILE = 'owner.md';
export const OWNER_NOTES_HEADING = '## My notes';
/** ~4 chars per token: the About section is capped at ~400 tokens, How-to-work at ~250. */
const ABOUT_MAX_CHARS = 1600;
/** How many unverified beliefs the About section may show when nothing is held yet. */
const ABOUT_FALLBACK_LIMIT = 20;
/** Below this many held beliefs the About section pads itself with candidates. */
const ABOUT_MIN_SURE = 6;
const HOW_MAX_CHARS = 1000;
const MAX_NOTE_LINES = 40;

type Usable = Belief & { confidence: number };

// ── sections ─────────────────────────────────────────────────────────────

/**
 * Build both sections. Prefers the reflection's brief (belief_meta `brief`)
 * when it is fresher than the last belief change; otherwise builds them
 * deterministically from the usable beliefs (confirmed first, then held;
 * candidates are never shown).
 */
export function buildOwnerSections(beliefs: BeliefStore, ownerName: string, now = Date.now()): OwnerSections {
  const usable = beliefs.usable(now);
  // Little or nothing held yet (a fresh install, or the first days after an
  // upgrade): the "About" section pads with the strongest candidates, each hedged,
  // so the model is not blind to what it has read. "How to work" stays
  // empty until a trait has actually been held — unverified instructions
  // would be worse than none.
  const forAbout = usable.length >= ABOUT_MIN_SURE ? usable : beliefs.strongest(ABOUT_FALLBACK_LIMIT, now);
  const brief = readStoredBrief(beliefs);
  if (brief && brief.sig === beliefStateSignature(beliefs)) {
    const about = brief.about.trim().slice(0, ABOUT_MAX_CHARS * 2);
    const howToWork = brief.howToWork.trim().slice(0, HOW_MAX_CHARS * 2);
    if (about || howToWork) return { about: about || aboutFromBeliefs(forAbout), howToWork: howToWork || howToWorkFromBeliefs(usable, ownerName) };
  }
  return { about: aboutFromBeliefs(forAbout), howToWork: howToWorkFromBeliefs(usable, ownerName) };
}

export function readStoredBrief(beliefs: BeliefStore): StoredBrief | null {
  const raw = beliefs.getMeta('brief');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredBrief>;
    if (typeof parsed.about !== 'string' || typeof parsed.howToWork !== 'string' || typeof parsed.at !== 'number' || typeof parsed.sig !== 'string') return null;
    return { about: parsed.about, howToWork: parsed.howToWork, at: parsed.at, sig: parsed.sig };
  } catch {
    return null;
  }
}

/** Call after every belief change of the pass has been applied: the brief is valid for exactly this state. */
export function storeBrief(beliefs: BeliefStore, brief: OwnerSections, at = Date.now()): void {
  const sig = beliefStateSignature(beliefs);
  beliefs.setMeta('brief', JSON.stringify({ about: brief.about.trim(), howToWork: brief.howToWork.trim(), at, sig } satisfies StoredBrief));
}

/** The latest `updated_at` among live beliefs (0 when there are none). */
export function lastBeliefChange(beliefs: BeliefStore): number {
  const latest = beliefs.list({ statuses: ['candidate', 'held', 'confirmed', 'contested', 'retired'], limit: 1 })[0];
  return latest?.updatedAt ?? 0;
}

/** A cheap signature of the beliefs themselves: status counts and the last change. */
export function beliefStateSignature(beliefs: BeliefStore): string {
  const counts = beliefs.counts();
  return `${Object.values(counts).join(',')}|${lastBeliefChange(beliefs)}`;
}

/**
 * A cheap signature of everything the sections depend on: the beliefs and
 * the stored brief. Recompute the sections only when it changes.
 */
export function beliefSignature(beliefs: BeliefStore): string {
  const brief = beliefs.getMeta('brief');
  return `${beliefStateSignature(beliefs)}|${brief ? brief.length : 0}`;
}

/** Memoised `buildOwnerSections`: one instance per agent, keyed on the belief signature. */
export function createOwnerSectionsMemo(): (beliefs: BeliefStore, ownerName: string) => OwnerSections | null {
  let signature = '';
  let cached: OwnerSections | null = null;
  return (beliefs, ownerName) => {
    let sig: string;
    try {
      sig = `${ownerName}|${beliefSignature(beliefs)}`;
    } catch (err) {
      logger.debug({ err: (err as Error).message }, 'belief signature failed');
      return cached;
    }
    if (sig === signature && cached) return cached;
    try {
      const sections = buildOwnerSections(beliefs, ownerName);
      cached = sections.about || sections.howToWork ? sections : null;
      signature = sig;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'owner sections build failed');
    }
    return cached;
  };
}

const ABOUT_KINDS: Array<{ kind: Belief['kind']; label: string }> = [
  { kind: 'fact', label: 'Facts' },
  { kind: 'preference', label: 'Preferences' },
  { kind: 'goal', label: 'Goals' },
  { kind: 'project', label: 'Projects' },
  { kind: 'relationship', label: 'People' },
  { kind: 'situation', label: 'Right now' },
];

/** Confirmed/owner-stated first, then held; strongest first within each. */
function ordered(usable: Usable[]): Usable[] {
  const rank = (b: Usable) => (b.ownerStated || b.status === 'confirmed' ? 0 : 1);
  return [...usable].sort((a, b) => rank(a) - rank(b) || b.confidence - a.confidence);
}

function aboutFromBeliefs(usable: Usable[]): string {
  const lines: string[] = [];
  let chars = 0;
  for (const { kind, label } of ABOUT_KINDS) {
    const items = ordered(usable.filter((b) => b.kind === kind));
    if (items.length === 0) continue;
    const group: string[] = [];
    for (const b of items) {
      const line = aboutLine(b);
      if (chars + line.length > ABOUT_MAX_CHARS) break;
      group.push(line);
      chars += line.length + 1;
    }
    if (group.length === 0) break;
    lines.push(`${label}:`, ...group);
  }
  return lines.join('\n');
}

function aboutLine(b: Usable): string {
  const stated = b.ownerStated || b.status === 'confirmed';
  const where = contextPhrase(b.context);
  const text = sentence(b.statement) + (where ? ` (${where.trim()})` : '');
  if (stated) return `- ${text}`;
  return `- ${text} — seems so, not confirmed`;
}

/** Trait levels as instructions. `ctx` is the context phrase (" in /repo", "" for everywhere). */
const TRAIT_INSTRUCTIONS: Record<string, Record<string, (ctx: string) => string>> = {
  brevity: {
    terse: (c) => `Keep replies short${c}; lead with the result and skip preamble.`,
    balanced: (c) => `Keep replies moderate${c}: the result first, detail only where it matters.`,
    thorough: (c) => `Give thorough replies${c}: include the reasoning and the detail.`,
  },
  autonomy: {
    'ask-first': (c) => `Ask before acting${c}; confirm the plan first.`,
    'ask-when-risky': (c) => `Act without asking on reversible steps${c}; ask before anything risky or irreversible.`,
    'just-do-it': (c) => `Just do it${c}: don't ask for confirmation on routine steps, report when done.`,
  },
  'decision-style': {
    options: (c) => `Present options with trade-offs${c} rather than a single answer.`,
    recommendation: (c) => `Give one recommendation with the reason${c}, not a menu.`,
    'decide-for-me': (c) => `Decide and act${c}; mention the choice briefly.`,
  },
  formality: {
    casual: (c) => `A casual tone is fine${c}.`,
    neutral: (c) => `Keep a neutral, plain tone${c}.`,
    formal: (c) => `Keep a formal tone${c}.`,
  },
  'feedback-style': {
    blunt: () => `They correct bluntly; treat it as information and move on without long apologies.`,
    explains: () => `They explain their corrections; acknowledge the reason and apply it.`,
    'silent-redo': () => `They tend to redo things rather than complain; check briefly that a result fits before going far.`,
  },
  rhythm: {
    morning: () => `Usually active in the morning; send proactive messages then, not late in the day.`,
    daytime: () => `Usually active during the day; keep proactive messages to working hours.`,
    evening: () => `Usually active in the evening; proactive messages fit then, not in the morning.`,
    'late-night': () => `Often active late at night; don't assume mornings are a good time to reach them.`,
  },
  expertise: {
    novice: (d) => `New to ${d}: explain from the basics and avoid unexplained jargon.`,
    competent: (d) => `Competent in ${d}: skip the basics, spell out the non-obvious steps.`,
    expert: (d) => `Expert in ${d}: no explanations of basics, assume fluency.`,
  },
  risk: {
    cautious: (d) => `Always confirm before ${d}.`,
    normal: (d) => `Confirm ${d} only when it is irreversible or costly.`,
    bold: (d) => `Don't hold up ${d} for confirmation unless something looks wrong.`,
  },
};

const INSTRUCTION_SHAPE = /^(always|never|don't|do not|never|ask |prefer|use |avoid|keep |no |only |stop |please )/i;

function howToWorkFromBeliefs(usable: Usable[], ownerName: string): string {
  const lines: string[] = [];
  let chars = 0;
  const push = (line: string): boolean => {
    if (chars + line.length > HOW_MAX_CHARS) return false;
    lines.push(line);
    chars += line.length + 1;
    return true;
  };
  // One instruction per (dimension, context), best belief wins.
  const seen = new Set<string>();
  for (const b of ordered(usable.filter((t) => t.kind === 'trait' && t.dimension && t.level))) {
    const key = `${b.dimension}|${b.context}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const text = traitInstruction(b);
    if (!text) continue;
    const hedged = b.ownerStated || b.status === 'confirmed' ? text : `${text} (observed so far)`;
    if (!push(`- ${hedged}`)) break;
  }
  // Confirmed preferences that already read as instructions.
  for (const b of ordered(usable.filter((p) => p.kind === 'preference' && (p.ownerStated || p.status === 'confirmed') && INSTRUCTION_SHAPE.test(p.statement)))) {
    const where = contextPhrase(b.context);
    if (!push(`- ${sentence(b.statement)}${where ? ` (${where.trim()})` : ''}`)) break;
  }
  if (lines.length === 0) return '';
  return lines.join('\n').replace(/\{owner\}/g, ownerName);
}

export function traitInstruction(b: Pick<Belief, 'dimension' | 'level' | 'context' | 'statement'>): string | null {
  if (!b.dimension || !b.level) return null;
  const [base, scope] = splitDimension(b.dimension);
  const table = TRAIT_INSTRUCTIONS[base];
  const make = table?.[b.level];
  if (!make) {
    // Dimensions without a table (e.g. `values`): the statement itself, as an instruction.
    return b.statement ? sentence(b.statement) : null;
  }
  if (base === 'expertise' || base === 'risk') return make(scope || 'this');
  return make(contextPhrase(b.context));
}

function splitDimension(dimension: string): [string, string] {
  const i = dimension.indexOf(':');
  return i === -1 ? [dimension, ''] : [dimension.slice(0, i), dimension.slice(i + 1)];
}

/** `project:/x` → " in /x"; `channel:telegram` → " on telegram"; `domain:x` → " for x"; `*` → "". */
export function contextPhrase(context: string): string {
  if (!context || context === '*') return '';
  const [kind, value] = splitDimension(context);
  if (!value) return ` in ${kind}`;
  switch (kind) {
    case 'project': return ` in ${value}`;
    case 'channel': return ` on ${value}`;
    case 'domain': return ` for ${value}`;
    case 'time': return ` ${value}`;
    default: return ` (${context})`;
  }
}

function sentence(s: string): string {
  const t = s.trim().replace(/\s+/g, ' ');
  if (!t) return '';
  const capped = t[0].toUpperCase() + t.slice(1);
  return /[.!?]$/.test(capped) ? capped.slice(0, -1) : capped;
}

/** Does any dimension/level pair exist? Used by the reflection validator. */
export function isKnownTrait(dimension: string, level: string): boolean {
  const [base, scope] = splitDimension(dimension);
  if (base in TRAIT_DIMENSIONS && !scope) return (TRAIT_DIMENSIONS[base as keyof typeof TRAIT_DIMENSIONS] as readonly string[]).includes(level);
  if (base in SCOPED_DIMENSIONS && scope) return (SCOPED_DIMENSIONS[base as keyof typeof SCOPED_DIMENSIONS] as readonly string[]).includes(level);
  return false;
}

// ── owner.md ─────────────────────────────────────────────────────────────

export function ownerFilePath(home = getMercuryHome()): string {
  return join(home, 'soul', OWNER_FILE);
}

/**
 * Write ~/.mercury/soul/owner.md: the two sections plus whatever the owner
 * wrote under "## My notes" (kept verbatim across rewrites).
 */
export function writeOwnerFile(sections: OwnerSections, ownerName: string, opts: { home?: string; now?: Date } = {}): string {
  const path = ownerFilePath(opts.home);
  const notes = readOwnerNotes({ home: opts.home });
  const when = (opts.now ?? new Date()).toISOString().slice(0, 16).replace('T', ' ');
  const body = [
    `# ${ownerName}`,
    '',
    `<!-- Generated by Mercury from its beliefs about you (last reflection ${when} UTC).`,
    '     Everything above "## My notes" is rewritten at every reflection; edits there are lost.',
    '     Lines you add under "## My notes" are read back at the next reflection as facts you stated',
    '     (they become confirmed beliefs). Use /memory in chat to confirm, correct or forget a belief. -->',
    '',
    `## About ${ownerName}`,
    '',
    sections.about.trim() || '_Nothing held yet._',
    '',
    `## How to work with ${ownerName}`,
    '',
    sections.howToWork.trim() || '_Nothing held yet._',
    '',
    OWNER_NOTES_HEADING,
    '',
    ...(notes.length ? notes.map((n) => `- ${n}`) : ['<!-- One fact per line, e.g. "- I prefer answers in British English." -->']),
    '',
  ].join('\n');
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body, 'utf-8');
  return path;
}

/** Lines the owner wrote under "## My notes" in owner.md (bullets stripped, comments and blanks dropped). */
export function readOwnerNotes(opts: { home?: string } = {}): string[] {
  const path = ownerFilePath(opts.home);
  if (!existsSync(path)) return [];
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch {
    return [];
  }
  return parseOwnerNotes(text);
}

export function parseOwnerNotes(text: string): string[] {
  const stripped = text.replace(/<!--[\s\S]*?-->/g, '');
  const idx = stripped.indexOf(OWNER_NOTES_HEADING);
  if (idx === -1) return [];
  const section = stripped.slice(idx + OWNER_NOTES_HEADING.length);
  const out: string[] = [];
  for (const raw of section.split('\n')) {
    if (/^#{1,6}\s/.test(raw)) break;
    const line = raw.replace(/^\s*[-*•]\s+/, '').trim();
    if (!line || line.length < 4) continue;
    out.push(line.slice(0, 200));
    if (out.length >= MAX_NOTE_LINES) break;
  }
  return out;
}
