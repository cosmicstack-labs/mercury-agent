/**
 * The reflection pass: the slow, "sleep-time" learning loop
 * (docs/owner-model.md §3.4, ADR-026).
 *
 * Runs from the heartbeat (every 60 min) when at least one session has a new
 * owner message since the last pass, and at shutdown. It reads the owner's
 * messages since the watermark, cheap behavioural statistics computed here
 * in code, and the current trait beliefs, and asks the model ONCE for belief
 * operations, merges, contested pairs and a fresh owner brief. Everything it
 * returns is validated strictly; anything malformed is dropped. Then the
 * store's decay pass runs and owner.md is rewritten.
 *
 * Assistant text is never an input: only the owner's own turns, tool traces
 * (what Mercury did) and permission answers.
 */
import { parseJsonLenient } from './json.js';
import { looksLikeIdentity, looksLikeSecret, ownerWords } from './text.js';
import { generateText } from 'ai';
import { logger } from '../utils/logger.js';
import type { Session, SessionMessage } from '../sessions/types.js';
import type { BeliefKind, BeliefOperation, BeliefStore, BeliefTimescale, EvidenceKind } from '../memory/beliefs.js';
import { TRAIT_DIMENSIONS, SCOPED_DIMENSIONS } from '../memory/beliefs.js';
import { buildOwnerSections, isKnownTrait, readOwnerNotes, storeBrief, writeOwnerFile, type OwnerSections } from './owner-brief.js';

// ── types ────────────────────────────────────────────────────────────────

export interface OwnerTurn {
  sessionId: string;
  at: number;
  channel: string;
  cwd?: string;
  content: string;
}

export interface ReflectionStats {
  sessions: Array<{ id: string; title: string; channel: string; ownerMessages: number; firstAt: number; lastAt: number }>;
  ownerMessages: number;
  medianOwnerLength: number;
  /** Owner messages per local hour of day, 24 buckets. */
  hourHistogram: number[];
  toolsUsed: Record<string, number>;
  corrections: number;
  brevityAsks: { shorter: number; longer: number };
  permissionAnswers: { allowed: number; denied: number; always: number };
}

export interface ReflectionOutput {
  ops: BeliefOperation[];
  merges: Array<{ keepId: string; mergeId: string }>;
  contested: Array<{ aId: string; bId: string }>;
  brief: OwnerSections | null;
}

export interface ReflectionDeps {
  beliefs: BeliefStore;
  sessions: { list(options?: { includeArchived?: boolean }): Session[] };
  providers: { getDefault(): { name: string; getModel(): string; getModelInstance(): unknown } };
  tokenBudget: {
    canAfford(estimatedTokens: number): boolean;
    recordUsage(entry: { provider: string; model: string; inputTokens: number; outputTokens: number; totalTokens: number; channelType: string; agentId?: string }): void;
  };
  learningPaused: () => boolean;
  ownerName: string;
  agentId?: string;
  /** Where owner.md lives (tests); defaults to the Mercury home. */
  home?: string;
  /** Test seam: replaces the model call. */
  generate?: (input: { system: string; prompt: string; maxOutputTokens: number }) => Promise<{ text: string; usage?: { inputTokens?: number; outputTokens?: number } }>;
  /** Test seam: local hour of a timestamp (defaults to Date#getHours). */
  hourOf?: (at: number) => number;
}

export interface ReflectionResult {
  ran: boolean;
  reason?: 'paused' | 'nothing-new' | 'budget' | 'model-error' | 'invalid-output';
  turns: number;
  applied: number;
  merged: number;
  contested: number;
  retired: number;
  notesApplied: number;
  brief: boolean;
}

export const REFLECTION_COST_TOKENS = 6000;
export const REFLECTION_MAX_OUTPUT = 3000;
const TURNS_TOKEN_CAP = 6000;
const TURN_MAX_CHARS = 600;
const MAX_TRAIT_LINES = 60;
const MAX_OTHER_LINES = 50;
const WATERMARK_KEY = 'reflection_watermark';
const LAST_RUN_KEY = 'reflection_last_run';
const NOTES_HASH_KEY = 'owner_notes_hash';

const OP_NAMES = new Set<BeliefOperation['op']>(['create', 'support', 'contradict', 'owner_stated', 'correction']);
const KINDS = new Set<BeliefKind>(['fact', 'preference', 'trait', 'situation', 'relationship', 'goal', 'project', 'episode']);
const TIMESCALES = new Set<BeliefTimescale>(['stable', 'situational', 'episodic']);
const CONTEXT_SHAPE = /^(\*|project:.{1,200}|channel:[a-z0-9-]{1,32}|domain:[a-z0-9 _./-]{1,60}|time:[a-z-]{1,24})$/i;

// ── the prompt ───────────────────────────────────────────────────────────

const TRAIT_TABLE = [
  ...Object.entries(TRAIT_DIMENSIONS).map(([d, levels]) => `  ${d}: ${levels.join(' | ')}`),
  ...Object.entries(SCOPED_DIMENSIONS).map(([d, levels]) => `  ${d}:<domain>: ${levels.join(' | ')}   (e.g. ${d}:typescript)`),
].join('\n');

export const REFLECTION_SYSTEM_PROMPT = `You are the reflection pass of a personal AI agent. Between sessions you review what the agent's OWNER wrote and did, and you refine the agent's beliefs about how to work with them. You see only the owner's own messages (never the agent's replies), statistics computed from the sessions, and the beliefs the agent currently holds.

Your output is ONE JSON object and nothing else (no prose, no markdown fences):
{
  "ops": [ <belief operation>, ... ],
  "merges": [ { "keepId": "<id>", "mergeId": "<id>" }, ... ],
  "contested": [ { "aId": "<id>", "bId": "<id>" }, ... ],
  "brief": { "about": "<text>", "howToWork": "<text>" }
}

Belief operations (all fields are strings unless noted):
- { "op": "create", "kind": "<kind>", "statement": "<claim, 12-200 chars>", "context": "<context>", "excerpt": "<what the owner wrote or did that shows it, <=200 chars>", "dimension"?: "<trait dimension>", "level"?: "<trait level>", "detail"?: "<text>", "weight"?: 0.5-2 }
- { "op": "support", "beliefId": "<id>", "excerpt": "<new evidence>", "weight"?: 0.5-2 }
- { "op": "contradict", "beliefId": "<id>", "excerpt": "<counter-evidence>", "weight"?: 0.5-2 }
- { "op": "owner_stated", "kind": "<kind>", "statement": "<claim>", "context": "<context>", "excerpt": "<the owner's words>" }   ONLY for something the owner said explicitly about themselves or how they want the agent to work.
- { "op": "correction", "beliefId": "<id>", "statement": "<the corrected claim>", "excerpt": "<the owner's words>" }   ONLY when the owner explicitly corrected something the agent believed.

Kinds: fact | preference | trait | situation | relationship | goal | project.
Trait dimensions and their only allowed levels (kind must be "trait", and both "dimension" and "level" are required):
${TRAIT_TABLE}
Contexts: "*" (everywhere), "project:<cwd>", "channel:<type>" (cli, telegram, whatsapp, discord, slack, web, voice), "domain:<topic>".

Rules:
1. Only what the evidence shows. Every op cites an excerpt the owner actually wrote or an action they actually took. If the messages show nothing new, output empty arrays.
2. Prefer fewer, stronger beliefs. Support an existing belief rather than creating a near-duplicate; list true duplicates in "merges" (keep the better-worded, better-supported one).
3. A trait you infer from this batch alone is a candidate: create it with weight 1 unless the pattern repeats across several sessions (then weight up to 2). Hedge in the brief ("seems to", "so far").
4. "contested": two existing beliefs that cannot both be true in the same context. Do not create a new trait level that contradicts a held one on the same dimension and context; contradict the old one instead, with the evidence.
5. Never infer personality types (MBTI, Big Five, enneagram), health, religion, politics, sexuality, ethnicity, or anything about a third person beyond what the owner said. Never record passwords, codes, API keys, tokens, card or account numbers, even if the owner pasted them. Never speculate about mood as a stable trait; a passing state is kind "situation".
6. The brief is for the agent's system prompt. "about": <= 300 words, what the owner does, works on, prefers and cares about; stated facts plainly, inferred ones hedged. "howToWork": <= 180 words of direct instructions derived from the held traits and confirmed preferences (reply length, when to ask before acting and where, options vs a recommendation, tone, what to explain and what to assume per domain, what always needs confirmation, when not to disturb). Address the agent ("Keep replies short…"). Write instructions in plain terms; never quote the statistics (no character counts, percentages, session or message counts, or clock times) and never repeat channel mechanics (how voice replies are formatted is already handled elsewhere). Leave both empty strings when nothing is held.
8. At most 12 operations and 6 merges per pass: the strongest, best-evidenced ones.
9. Refer to the owner by name or as "they"; never assume gender, age or location unless the owner stated it. Their name, email and handles are in Mercury's configuration already; never create a belief that only states who they are or how to reach them.
7. Statements are about the owner, written in the third person without their name ("Prefers…", "Works on…"). Excerpts are quotes or short descriptions of actions, never your own reasoning.`;

export function buildReflectionPrompt(input: {
  ownerName: string;
  turns: OwnerTurn[];
  stats: ReflectionStats;
  traits: string;
  others: string;
  since: number;
  now: number;
}): string {
  const window = input.since > 0 ? `${iso(input.since)} to ${iso(input.now)}` : `everything up to ${iso(input.now)}`;
  const s = input.stats;
  const histogram = describeHours(s.hourHistogram);
  const lengthWord = s.medianOwnerLength === 0 ? 'none' : s.medianOwnerLength < 30 ? 'very short (a few words)' : s.medianOwnerLength < 90 ? 'short (a sentence)' : s.medianOwnerLength < 300 ? 'medium (a paragraph)' : 'long (several paragraphs)';
  const tools = Object.entries(s.toolsUsed).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([t, n]) => `${t}×${n}`).join(', ') || 'none';
  const sessions = s.sessions.slice(0, 20).map((x) => `- ${x.id.slice(0, 8)} [${x.channel}] "${x.title.slice(0, 60)}": ${x.ownerMessages} owner messages, ${iso(x.firstAt)} → ${iso(x.lastAt)}`).join('\n') || '- none';
  return `Owner: ${input.ownerName}. Window: ${window}.

## Statistics (computed, not inferred)
Sessions with new owner messages: ${s.sessions.length}; owner messages: ${s.ownerMessages}; typical owner message: ${lengthWord}.
When the owner writes (local time): ${histogram}
Tools the agent used (from traces): ${tools}
Corrections by the owner (regex, approximate): ${s.corrections}; asks for shorter replies: ${s.brevityAsks.shorter}; asks for more detail: ${s.brevityAsks.longer}.
Permission answers: allowed ${s.permissionAnswers.allowed}, denied ${s.permissionAnswers.denied}, "always/allow all" ${s.permissionAnswers.always}.
Sessions:
${sessions}

## Current trait beliefs (id | dimension=level | context | support/against | status)
${input.traits || '(none)'}

## Other beliefs the agent holds (id | kind | status | statement)
${input.others || '(none)'}

## The owner's messages, most recent first ([time channel session cwd])
${formatOwnerTurns(input.turns) || '(none)'}

Output the JSON object now.`;
}

// ── collection and statistics ────────────────────────────────────────────

const CORRECTION_RE = /^(no[,.!\s]|nope\b|wrong\b|not that\b|that'?s not\b|that is not\b|i meant\b|i said\b|i asked\b|undo\b|revert\b|redo\b|stop\b|don'?t do that\b)|\b(that'?s|that is) (not what|wrong|not it)\b|\bnot what i (asked|meant|wanted|said)\b|\bwhy did you\b|\bi didn'?t (ask|say|want)\b|\btoo (long|verbose|much)\b/i;
const SHORTER_RE = /\b(shorter|too long|too verbose|tl;?dr|be brief|briefer|more concise|less detail|just the (answer|result|command)|stop explaining)\b/i;
const LONGER_RE = /\b(more detail|elaborate|expand on|too short|explain (more|further|why)|walk me through)\b/i;
const TRACE_LINE_RE = /^- ([a-z0-9_:.-]+)/i;

/** Owner turns, tool traces and permission answers newer than `since`, across all sessions. */
export function collectSince(sessions: Session[], since: number): { turns: OwnerTurn[]; traces: SessionMessage[]; permissions: SessionMessage[]; sessions: Session[] } {
  const turns: OwnerTurn[] = [];
  const traces: SessionMessage[] = [];
  const permissions: SessionMessage[] = [];
  const touched: Session[] = [];
  for (const session of sessions) {
    if (session.updatedAt <= since) continue;
    let any = false;
    for (const m of session.messages) {
      if (m.timestamp <= since) continue;
      const channel = typeof m.metadata?.channelType === 'string' ? m.metadata.channelType : 'unknown';
      if (m.role === 'user' && m.kind === 'message') {
        if (channel === 'internal') continue;
        const content = ownerWords(m.content);
        if (!content || content.startsWith('/')) continue;
        const cwd = typeof m.metadata?.workCwd === 'string' ? m.metadata.workCwd : typeof m.metadata?.cwd === 'string' ? m.metadata.cwd : undefined;
        turns.push({ sessionId: session.id, at: m.timestamp, channel, ...(cwd ? { cwd } : {}), content });
        any = true;
      } else if (m.kind === 'tool-call') {
        traces.push(m);
      } else if (m.kind === 'permission') {
        permissions.push(m);
      }
    }
    if (any) touched.push(session);
  }
  turns.sort((a, b) => b.at - a.at);
  return { turns, traces, permissions, sessions: touched };
}

export function computeStatistics(
  collected: { turns: OwnerTurn[]; traces: SessionMessage[]; permissions: SessionMessage[]; sessions: Session[] },
  hourOf: (at: number) => number = (at) => new Date(at).getHours(),
): ReflectionStats {
  const { turns, traces, permissions } = collected;
  const bySession = new Map<string, { count: number; first: number; last: number; channel: string }>();
  for (const t of turns) {
    const cur = bySession.get(t.sessionId) ?? { count: 0, first: t.at, last: t.at, channel: t.channel };
    cur.count++;
    cur.first = Math.min(cur.first, t.at);
    cur.last = Math.max(cur.last, t.at);
    bySession.set(t.sessionId, cur);
  }
  const sessions = collected.sessions.map((s) => {
    const x = bySession.get(s.id) ?? { count: 0, first: s.createdAt, last: s.updatedAt, channel: 'unknown' };
    return { id: s.id, title: s.title, channel: x.channel, ownerMessages: x.count, firstAt: x.first, lastAt: x.last };
  });
  const lengths = turns.map((t) => t.content.length).sort((a, b) => a - b);
  const medianOwnerLength = lengths.length === 0 ? 0 : lengths.length % 2 ? lengths[(lengths.length - 1) / 2] : Math.round((lengths[lengths.length / 2 - 1] + lengths[lengths.length / 2]) / 2);
  const hourHistogram = new Array<number>(24).fill(0);
  for (const t of turns) {
    const h = hourOf(t.at);
    if (h >= 0 && h < 24) hourHistogram[h]++;
  }
  const toolsUsed: Record<string, number> = {};
  for (const m of traces) {
    for (const line of m.content.split('\n')) {
      const match = TRACE_LINE_RE.exec(line);
      if (!match || match[1] === '…') continue;
      toolsUsed[match[1]] = (toolsUsed[match[1]] ?? 0) + 1;
    }
  }
  let corrections = 0;
  const brevityAsks = { shorter: 0, longer: 0 };
  for (const t of turns) {
    if (CORRECTION_RE.test(t.content)) corrections++;
    if (SHORTER_RE.test(t.content)) brevityAsks.shorter++;
    if (LONGER_RE.test(t.content)) brevityAsks.longer++;
  }
  const permissionAnswers = { allowed: 0, denied: 0, always: 0 };
  for (const m of permissions) {
    const text = `${m.content} ${JSON.stringify(m.metadata ?? {})}`;
    if (/allow[ -]?all|always/i.test(text)) permissionAnswers.always++;
    else if (/den(y|ied)|reject|no\b/i.test(text)) permissionAnswers.denied++;
    else if (/allow|approve|yes\b/i.test(text)) permissionAnswers.allowed++;
  }
  return { sessions, ownerMessages: turns.length, medianOwnerLength, hourHistogram, toolsUsed, corrections, brevityAsks, permissionAnswers };
}

/** Most recent first, each turn truncated, the whole capped at ~6k tokens. */
export function formatOwnerTurns(turns: OwnerTurn[], tokenCap = TURNS_TOKEN_CAP): string {
  const lines: string[] = [];
  let chars = 0;
  const cap = tokenCap * 4;
  for (const t of turns) {
    const content = t.content.length > TURN_MAX_CHARS ? `${t.content.slice(0, TURN_MAX_CHARS - 1)}…` : t.content;
    const line = `[${iso(t.at)} ${t.channel} ${t.sessionId.slice(0, 8)}${t.cwd ? ` ${t.cwd}` : ''}] ${content.replace(/\s*\n\s*/g, ' ⏎ ')}`;
    if (chars + line.length > cap) break;
    lines.push(line);
    chars += line.length + 1;
  }
  return lines.join('\n');
}

export function describeBeliefs(beliefs: BeliefStore, now = Date.now()): { traits: string; others: string; ids: Set<string> } {
  const ids = new Set<string>();
  const traits = beliefs.list({ kinds: ['trait'], statuses: ['candidate', 'held', 'confirmed', 'contested'] }).slice(0, MAX_TRAIT_LINES);
  const traitLines = traits.map((b) => {
    ids.add(b.id);
    return `${b.id} | ${b.dimension}=${b.level} | ${b.context} | ${fmt(b.support)}/${fmt(b.against)} | ${b.status}${b.ownerStated ? ' (owner-stated)' : ''} | ${b.statement.slice(0, 100)}`;
  });
  // Usable (held/confirmed) first, then candidates: the model may support,
  // merge or contradict any of them.
  const usable = beliefs.usable(now).filter((b) => b.kind !== 'trait');
  const candidates = beliefs.list({ statuses: ['candidate'] }).filter((b) => b.kind !== 'trait');
  const others = [...usable, ...candidates].slice(0, MAX_OTHER_LINES);
  const otherLines = others.map((b) => {
    ids.add(b.id);
    return `${b.id} | ${b.kind} | ${b.status} | ${b.statement.slice(0, 140)}`;
  });
  return { traits: traitLines.join('\n'), others: otherLines.join('\n'), ids };
}

// ── parsing and validation ───────────────────────────────────────────────

/**
 * Strict parse of the model's output. Returns null when it is not a JSON
 * object of the expected shape; individual ops/merges/pairs that fail
 * validation are dropped. `knownIds` limits references to beliefs we showed.
 */
export function parseReflectionOutput(text: string, knownIds: Set<string>): ReflectionOutput | null {
  const parsed = parseJsonLenient(text);
  if (!isRecord(parsed)) return null;
  const ops: BeliefOperation[] = [];
  if (parsed.ops !== undefined) {
    if (!Array.isArray(parsed.ops)) return null;
    for (const item of parsed.ops) {
      const op = validateOp(item, knownIds);
      if (op) ops.push(op);
    }
  }
  const merges: ReflectionOutput['merges'] = [];
  if (parsed.merges !== undefined) {
    if (!Array.isArray(parsed.merges)) return null;
    for (const m of parsed.merges) {
      if (!isRecord(m) || typeof m.keepId !== 'string' || typeof m.mergeId !== 'string') continue;
      if (m.keepId === m.mergeId || !knownIds.has(m.keepId) || !knownIds.has(m.mergeId)) continue;
      merges.push({ keepId: m.keepId, mergeId: m.mergeId });
    }
  }
  const contested: ReflectionOutput['contested'] = [];
  if (parsed.contested !== undefined) {
    if (!Array.isArray(parsed.contested)) return null;
    for (const c of parsed.contested) {
      if (!isRecord(c) || typeof c.aId !== 'string' || typeof c.bId !== 'string') continue;
      if (c.aId === c.bId || !knownIds.has(c.aId) || !knownIds.has(c.bId)) continue;
      contested.push({ aId: c.aId, bId: c.bId });
    }
  }
  let brief: OwnerSections | null = null;
  if (isRecord(parsed.brief) && typeof parsed.brief.about === 'string' && typeof parsed.brief.howToWork === 'string') {
    const about = parsed.brief.about.trim().slice(0, 2400);
    const howToWork = parsed.brief.howToWork.trim().slice(0, 1500);
    if (about || howToWork) brief = { about, howToWork };
  }
  return { ops, merges, contested, brief };
}

function validateOp(item: unknown, knownIds: Set<string>): BeliefOperation | null {
  if (!isRecord(item) || typeof item.op !== 'string' || !OP_NAMES.has(item.op as BeliefOperation['op'])) return null;
  const op = item.op as BeliefOperation['op'];
  const excerpt = typeof item.excerpt === 'string' && item.excerpt.trim() ? item.excerpt.trim().slice(0, 200) : null;
  if (!excerpt) return null;
  const weight = typeof item.weight === 'number' && Number.isFinite(item.weight) ? Math.min(2, Math.max(0.25, item.weight)) : undefined;
  const sessionId = typeof item.sessionId === 'string' ? item.sessionId : undefined;
  const base: BeliefOperation = { op, excerpt, ...(weight !== undefined ? { weight } : {}), ...(sessionId ? { sessionId } : {}) };
  if (op === 'create' || op === 'owner_stated') {
    const kind = typeof item.kind === 'string' && KINDS.has(item.kind as BeliefKind) ? (item.kind as BeliefKind) : null;
    const statement = typeof item.statement === 'string' ? item.statement.trim() : '';
    if (!kind || kind === 'episode' || statement.length < 8 || statement.length > 240) return null;
    if (looksLikeSecret(statement) || looksLikeIdentity(statement) || looksLikeSecret(String(item.detail ?? ''))) return null;
    const context = typeof item.context === 'string' && CONTEXT_SHAPE.test(item.context.trim()) ? item.context.trim() : '*';
    const out: BeliefOperation = { ...base, kind, statement, context, evidenceKind: op === 'owner_stated' ? 'owner' : 'reflection' };
    if (kind === 'trait') {
      if (typeof item.dimension !== 'string' || typeof item.level !== 'string') return null;
      const dimension = item.dimension.trim().toLowerCase();
      const level = item.level.trim().toLowerCase();
      if (!isKnownTrait(dimension, level)) return null;
      out.dimension = dimension;
      out.level = level;
    }
    if (typeof item.detail === 'string' && item.detail.trim()) out.detail = item.detail.trim().slice(0, 500);
    if (typeof item.timescale === 'string' && TIMESCALES.has(item.timescale as BeliefTimescale)) out.timescale = item.timescale as BeliefTimescale;
    return out;
  }
  if (typeof item.beliefId !== 'string' || !knownIds.has(item.beliefId)) return null;
  const out: BeliefOperation = { ...base, beliefId: item.beliefId, evidenceKind: (op === 'support' ? 'reflection' : 'corrected') as EvidenceKind };
  if (op === 'correction') {
    const statement = typeof item.statement === 'string' ? item.statement.trim() : '';
    if (statement.length >= 8 && statement.length <= 240) out.statement = statement;
    out.evidenceKind = 'owner';
    if (typeof item.level === 'string') out.level = item.level.trim().toLowerCase();
  }
  return out;
}

// ── applying ─────────────────────────────────────────────────────────────

export function applyReflection(beliefs: BeliefStore, output: ReflectionOutput, now = Date.now()): { applied: number; merged: number; contested: number; retired: number } {
  let applied = 0;
  for (const op of output.ops) {
    try {
      if (beliefs.apply(op, now)) applied++;
    } catch (err) {
      logger.debug({ err: (err as Error).message, op: op.op }, 'reflection op failed');
    }
  }
  let merged = 0;
  for (const m of output.merges) {
    if (beliefs.merge(m.keepId, m.mergeId, now)) merged++;
  }
  let contested = 0;
  for (const pair of output.contested) {
    const a = beliefs.get(pair.aId);
    const b = beliefs.get(pair.bId);
    if (!a || !b || a.status !== 'held' || b.status !== 'held') continue;
    beliefs.apply({ op: 'contradict', beliefId: a.id, weight: 1.5, evidenceKind: 'reflection', excerpt: `contested with "${b.statement.slice(0, 120)}"` }, now);
    beliefs.apply({ op: 'contradict', beliefId: b.id, weight: 1.5, evidenceKind: 'reflection', excerpt: `contested with "${a.statement.slice(0, 120)}"` }, now);
    contested++;
  }
  const retired = beliefs.decayPass(now);
  return { applied, merged, contested, retired };
}

/** Lines the owner added under "## My notes" in owner.md become owner-stated facts (once per distinct set of notes). */
export function applyOwnerNotes(beliefs: BeliefStore, notes: string[], now = Date.now()): number {
  if (notes.length === 0) return 0;
  const hash = hashLines(notes);
  if (beliefs.getMeta(NOTES_HASH_KEY) === hash) return 0;
  let applied = 0;
  for (const note of notes) {
    const r = beliefs.apply({ op: 'owner_stated', kind: 'fact', statement: note.slice(0, 240), context: '*', excerpt: `owner.md: ${note.slice(0, 180)}`, evidenceKind: 'owner' }, now);
    if (r && r.change !== 'unchanged') applied++;
  }
  beliefs.setMeta(NOTES_HASH_KEY, hash);
  return applied;
}

// ── the pass ─────────────────────────────────────────────────────────────

export async function runReflection(deps: ReflectionDeps, opts: { now?: number; force?: boolean } = {}): Promise<ReflectionResult> {
  const now = opts.now ?? Date.now();
  const { beliefs } = deps;
  const none = (reason: ReflectionResult['reason'], extra: Partial<ReflectionResult> = {}): ReflectionResult =>
    ({ ran: false, reason, turns: 0, applied: 0, merged: 0, contested: 0, retired: 0, notesApplied: 0, brief: false, ...extra });
  if (deps.learningPaused()) return none('paused');

  const notesApplied = applyOwnerNotes(beliefs, readOwnerNotes({ home: deps.home }), now);

  const since = Number(beliefs.getMeta(WATERMARK_KEY) ?? 0) || 0;
  const collected = collectSince(deps.sessions.list({ includeArchived: true }), since);
  if (collected.turns.length === 0 && !opts.force) {
    if (notesApplied > 0) refreshOwnerFile(deps);
    return none('nothing-new', { notesApplied });
  }
  if (!deps.tokenBudget.canAfford(REFLECTION_COST_TOKENS)) return none('budget', { notesApplied, turns: collected.turns.length });

  const stats = computeStatistics(collected, deps.hourOf);
  const described = describeBeliefs(beliefs, now);
  const prompt = buildReflectionPrompt({ ownerName: deps.ownerName, turns: collected.turns, stats, traits: described.traits, others: described.others, since, now });

  let text: string;
  try {
    const provider = deps.providers.getDefault();
    const result = deps.generate
      ? await deps.generate({ system: REFLECTION_SYSTEM_PROMPT, prompt, maxOutputTokens: REFLECTION_MAX_OUTPUT })
      : await generateText({
        model: provider.getModelInstance() as Parameters<typeof generateText>[0]['model'],
        system: REFLECTION_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }],
        maxOutputTokens: REFLECTION_MAX_OUTPUT,
      });
    deps.tokenBudget.recordUsage({
      provider: provider.name,
      model: provider.getModel(),
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
      totalTokens: (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
      channelType: 'internal',
      agentId: deps.agentId,
    });
    text = result.text;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Reflection: model call failed');
    return none('model-error', { notesApplied, turns: collected.turns.length });
  }

  // The turns were seen whatever the model made of them: advance the watermark
  // so a malformed answer is not retried every hour.
  const newest = collected.turns[0]?.at ?? now;
  beliefs.setMeta(WATERMARK_KEY, String(Math.max(since, newest)));
  beliefs.setMeta(LAST_RUN_KEY, String(now));

  const output = parseReflectionOutput(text, described.ids);
  if (!output) {
    logger.warn({ sample: text.slice(0, 200) }, 'Reflection: output was not valid JSON; nothing applied');
    return none('invalid-output', { notesApplied, turns: collected.turns.length });
  }
  const counts = applyReflection(beliefs, output, now);
  if (output.brief) storeBrief(beliefs, output.brief, now);
  refreshOwnerFile(deps);
  const result: ReflectionResult = { ran: true, turns: collected.turns.length, ...counts, notesApplied, brief: !!output.brief };
  logger.info(result, 'Reflection pass completed');
  return result;
}

function refreshOwnerFile(deps: ReflectionDeps): void {
  try {
    writeOwnerFile(buildOwnerSections(deps.beliefs, deps.ownerName), deps.ownerName, { home: deps.home });
  } catch (err) {
    logger.debug({ err: (err as Error).message }, 'owner.md write failed');
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

function iso(at: number): string {
  return new Date(at).toISOString().slice(0, 16).replace('T', ' ');
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function hashLines(lines: string[]): string {
  let h = 2166136261;
  for (const ch of lines.join('\n')) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16);
}

/** Hours as words ("mostly late morning and early evening"), never as numbers the brief could echo. */
export function describeHours(hist: number[]): string {
  const total = hist.reduce((a, b) => a + b, 0);
  if (total === 0) return 'no messages';
  const bands: Array<[string, number, number]> = [['early morning', 5, 8], ['morning', 8, 12], ['midday', 12, 14], ['afternoon', 14, 18], ['evening', 18, 22], ['late night', 22, 29]];
  const share = bands.map(([name, from, to]) => {
    let n = 0;
    for (let h = from; h < to; h++) n += hist[h % 24] ?? 0;
    return [name, n / total] as const;
  }).filter(([, p]) => p >= 0.15).sort((a, b) => b[1] - a[1]);
  if (share.length === 0) return 'spread across the day';
  return `mostly ${share.map(([n]) => n).slice(0, 3).join(' and ')}`;
}
