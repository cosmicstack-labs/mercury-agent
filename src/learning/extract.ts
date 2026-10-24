/**
 * Per-turn belief extraction (docs/owner-model.md §3.4 "per turn", ADR-026).
 *
 * One small model call per non-trivial turn turns the owner's words, the
 * turn's signals and the beliefs Mercury already holds into a list of
 * belief operations — or `[]`, which is the usual answer. The output is
 * parsed strictly: anything that is not a JSON array of valid operations
 * becomes `[]`. There is no prose fallback; that is where the old store's
 * junk came from.
 */
import { parseJsonLenient } from './json.js';
import { looksLikeIdentity, looksLikeSecret, ownerWords } from './text.js';
import { generateText } from 'ai';
import type { Belief, BeliefKind, BeliefOperation, BeliefStore, BeliefTimescale } from '../memory/beliefs.js';
import { SCOPED_DIMENSIONS, TRAIT_DIMENSIONS } from '../memory/beliefs.js';
import { logger } from '../utils/logger.js';
import { describeSignals, type TurnSignals } from './signals.js';

export const EXTRACT_MAX_OUTPUT_TOKENS = 600;
export const EXTRACT_MIN_BUDGET = 1200;
export const MAX_OPS_PER_TURN = 5;
export const RELEVANT_BELIEF_LIMIT = 8;
const STATEMENT_MIN = 12;
const STATEMENT_MAX = 220;
const EXCERPT_MAX = 200;
const CONTEXT_MAX = 160;

/** Greetings and acknowledgements: nothing to learn, no model call. */
export const TRIVIAL_MESSAGE = /^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|bye|goodbye|good morning|good evening)\b/i;
/** A message that opens like a greeting but goes on ("No no, I said British spelling…") is a turn, often a correction. */
export const TRIVIAL_MAX_CHARS = 40;

export function isTrivialMessage(message: string): boolean {
  const m = message.trim();
  return m.length <= TRIVIAL_MAX_CHARS && TRIVIAL_MESSAGE.test(m);
}

export interface ExtractTurn {
  role: 'owner' | 'mercury';
  content: string;
}

export interface ExtractInput {
  ownerMessage: string;
  mercuryReply: string;
  /** The last few turns of the session before this one, oldest first. */
  recentTurns: readonly ExtractTurn[];
  signals: TurnSignals;
  ownerName: string;
  /** A contested-belief question Mercury has asked or is about to ask, so an answer can be read. */
  pendingQuestion: string | null;
  channelAccess?: string;
  sessionId?: string;
  turnRef?: string;
}

/** The slice of the belief store the extractor reads. */
export type BeliefSearch = Pick<BeliefStore, 'searchRelevant' | 'findSimilar'>;

interface UsageLike { inputTokens?: number; outputTokens?: number }
export type GenerateFn = (args: { model: unknown; system: string; messages: Array<{ role: 'user'; content: string }>; maxOutputTokens: number }) => Promise<{ text: string; usage?: UsageLike }>;

export interface ExtractDeps {
  providers: { getDefault(): { name: string; getModel(): string; getModelInstance(): unknown } };
  tokenBudget: {
    canAfford(estimatedTokens: number): boolean;
    recordUsage(entry: { provider: string; model: string; inputTokens: number; outputTokens: number; totalTokens: number; channelType: 'internal'; agentId?: string }): void;
  };
  beliefs: BeliefSearch;
  learningPaused: () => boolean;
  agentId?: string;
  /** Injected by tests; defaults to the AI SDK's generateText. */
  generate?: GenerateFn;
}

const KINDS: ReadonlySet<string> = new Set<BeliefKind>(['fact', 'preference', 'trait', 'situation', 'relationship', 'goal', 'project', 'episode']);
const TIMESCALES: ReadonlySet<string> = new Set<BeliefTimescale>(['stable', 'situational', 'episodic']);
const OPS: ReadonlySet<string> = new Set<BeliefOperation['op']>(['create', 'support', 'contradict', 'owner_stated', 'correction']);

/** The trait levels allowed for a dimension, or null when the dimension is unknown. */
export function levelsFor(dimension: string): readonly string[] | null {
  if (Object.prototype.hasOwnProperty.call(TRAIT_DIMENSIONS, dimension)) return TRAIT_DIMENSIONS[dimension as keyof typeof TRAIT_DIMENSIONS];
  const colon = dimension.indexOf(':');
  if (colon > 0 && colon < dimension.length - 1) {
    const base = dimension.slice(0, colon);
    if (Object.prototype.hasOwnProperty.call(SCOPED_DIMENSIONS, base)) return SCOPED_DIMENSIONS[base as keyof typeof SCOPED_DIMENSIONS];
  }
  return null;
}

/** Existing beliefs the turn may touch: usable ones matching the message plus near-duplicates of it. */
export function relevantBeliefs(beliefs: BeliefSearch, message: string, limit = RELEVANT_BELIEF_LIMIT): Belief[] {
  const seen = new Set<string>();
  const out: Belief[] = [];
  const add = (b: Belief): void => { if (!seen.has(b.id) && b.status !== 'forgotten' && out.length < limit) { seen.add(b.id); out.push(b); } };
  try { for (const b of beliefs.searchRelevant(message, limit)) add(b); } catch (err) { logger.debug({ err: (err as Error).message }, 'belief search failed'); }
  try { for (const b of beliefs.findSimilar(message, undefined, limit)) add(b); } catch (err) { logger.debug({ err: (err as Error).message }, 'belief similarity search failed'); }
  return out;
}

function dimensionsHelp(): string {
  const fixed = Object.entries(TRAIT_DIMENSIONS).map(([d, levels]) => `  ${d}: ${levels.join(' | ')}`);
  const scoped = Object.entries(SCOPED_DIMENSIONS).map(([d, levels]) => `  ${d}:<domain> (e.g. ${d}:typescript): ${levels.join(' | ')}`);
  return [...fixed, ...scoped].join('\n');
}

export function buildSystemPrompt(ownerName: string): string {
  return `You maintain Mercury's beliefs about its owner, ${ownerName}. After each chat turn you decide what, if anything, this turn taught Mercury about the owner, and output belief operations as a JSON array. Nothing else: no prose, no markdown fences, no commentary.

SOURCES
- Only the OWNER's words and actions are evidence about the owner.
- The block labelled "MERCURY SAID" is Mercury's own reply. It is NEVER a source for beliefs about the owner. At most it may yield one op of kind "episode" recording what Mercury did ("Mercury set up the release script for project X"), and only when that is worth remembering.
- EXISTING BELIEFS are what Mercury already holds. Prefer "support", "contradict" or "correction" on an existing belief over creating a near-duplicate.

OPERATIONS (each object has "op" and "excerpt"; "excerpt" quotes the OWNER's own words, at most 200 characters)
- {"op":"create", "kind", "statement", "context", "timescale", "dimension"?, "level"?} — a new inferred belief. statement is 12-220 characters, third person ("Prefers one command over many manual steps").
- {"op":"owner_stated", "kind", "statement", "context", "timescale", "dimension"?, "level"?} — the owner said it outright about themselves or how they want Mercury to work. Held immediately.
- {"op":"support", "beliefId"} — the turn is fresh evidence for an existing belief.
- {"op":"contradict", "beliefId"} — the turn is evidence against an existing belief.
- {"op":"correction", "beliefId", "statement", "dimension"?, "level"?, "context"?} — the owner corrected a belief Mercury acted on; "statement" is the replacement (12-220 chars). Omit "statement" when the owner only rejected it.

KINDS: fact | preference | trait | situation | relationship | goal | project | episode
TIMESCALES: stable | situational | episodic
CONTEXT: where the belief applies: "*" (everywhere), "project:<cwd>", "channel:<type>", "domain:<name>", "time:<morning|daytime|evening|late-night>".

TRAITS (kind "trait") must use exactly one of these dimensions and one of its levels:
${dimensionsHelp()}

RULES
- Output [] when nothing durable was learned. That is the right answer for most turns: questions, tasks, chit-chat and anything Mercury could re-derive from the conversation itself teach nothing about the owner.
- Never infer personality types, health, religion, politics, sexuality, or anything about a third person beyond what the owner stated. Never record passwords, codes, API keys, tokens, card or account numbers, even if the owner pasted them. If the owner states such a thing about themselves, store it as kind "fact" with the owner's words; never generalise it.
- Passing states (frustrated, in a hurry, tired, exploring) are kind "situation" with timescale "situational"; never a trait.
- The owner's name, email, handles and phone number are already in Mercury's configuration; never create a belief that states who the owner is or how to reach them.
- When the owner corrects how Mercury behaved ("don't ask before running tests here", "shorter", "stop explaining"), emit "correction" on the belief Mercury acted on if one is listed, otherwise "owner_stated" with kind "trait" (e.g. autonomy = just-do-it with context project:<cwd>; brevity = terse).
- The TURN SIGNALS are hints computed by code; use them to decide, but the excerpt must still quote the owner.
- If a PENDING QUESTION is listed and the owner answered it, emit "correction" or "support" on the belief that won and "contradict" on the one that lost.
- At most ${MAX_OPS_PER_TURN} operations. Each fact appears once.
- Output a pure JSON array.`;
}

function formatBelief(b: Belief): string {
  const dim = b.dimension ? ` ${b.dimension}=${b.level ?? '?'}` : '';
  return `- id=${b.id} [${b.kind}${dim}] ${b.statement} (status: ${b.status}, support: ${b.support}, against: ${b.against}, context: ${b.context})`;
}

export function buildUserPrompt(input: ExtractInput, existing: readonly Belief[]): string {
  const parts: string[] = [];
  parts.push(`OWNER: ${input.ownerName}`);
  parts.push('');
  parts.push(`EXISTING BELIEFS (relevant to this turn; ${existing.length} of them)`);
  parts.push(existing.length > 0 ? existing.map(formatBelief).join('\n') : '- none');
  parts.push('');
  parts.push(`PENDING QUESTION: ${input.pendingQuestion ?? 'none'}`);
  parts.push('');
  parts.push('TURN SIGNALS (computed by code)');
  parts.push(describeSignals(input.signals));
  parts.push('');
  if (input.recentTurns.length > 0) {
    parts.push('RECENT TURNS (oldest first)');
    for (const t of input.recentTurns) {
      parts.push(`${t.role === 'owner' ? 'OWNER SAID' : 'MERCURY SAID'}: ${(t.role === 'owner' ? ownerWords(t.content) : t.content).replace(/\s+/g, ' ').trim().slice(0, 600)}`);
    }
    parts.push('');
  }
  parts.push('THIS TURN');
  parts.push(`OWNER SAID: ${ownerWords(input.ownerMessage).slice(0, 4000)}`);
  parts.push('');
  parts.push(`MERCURY SAID (never a source for beliefs about the owner; it may only yield an "episode" of what Mercury did): ${input.mercuryReply.replace(/\s+/g, ' ').trim().slice(0, 1500)}`);
  parts.push('');
  parts.push('Belief operations as a JSON array:');
  return parts.join('\n');
}

// ── parsing ─────────────────────────────────────────────────────────────

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

function validStatement(v: unknown): string | undefined {
  const s = str(v)?.replace(/\s+/g, ' ');
  return s && s.length >= STATEMENT_MIN && s.length <= STATEMENT_MAX ? s : undefined;
}

function validContext(v: unknown): string {
  const s = str(v);
  if (!s || s.length > CONTEXT_MAX) return '*';
  return s;
}

/**
 * Parse the model's output into validated operations. Anything that is not a
 * JSON array yields []; every element is checked for op, kind, dimension and
 * level, statement length, excerpt and (for references) a known belief id.
 */
export function parseBeliefOperations(text: string, existingIds: ReadonlySet<string>, ref: { sessionId?: string; turnRef?: string; defaultExcerpt?: string } = {}): BeliefOperation[] {
  const parsed = parseJsonLenient(text);
  if (!Array.isArray(parsed)) return [];
  const out: BeliefOperation[] = [];
  const fallback = ref.defaultExcerpt?.replace(/\s+/g, ' ').trim().slice(0, EXCERPT_MAX);
  for (const raw of parsed) {
    if (out.length >= MAX_OPS_PER_TURN) break;
    // Models drop the excerpt now and then; the owner's own message is the
    // evidence anyway, so an op without one cites that rather than being lost.
    const withExcerpt = fallback && raw && typeof raw === 'object' && !str((raw as Record<string, unknown>).excerpt)
      ? { ...(raw as Record<string, unknown>), excerpt: fallback }
      : raw;
    const op = validateOperation(withExcerpt, existingIds);
    if (op) out.push({ ...op, sessionId: ref.sessionId, turnRef: ref.turnRef });
  }
  return out;
}

export function validateOperation(raw: unknown, existingIds: ReadonlySet<string>): BeliefOperation | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const opName = str(r.op);
  if (!opName || !OPS.has(opName)) return null;
  const op = opName as BeliefOperation['op'];
  const excerpt = str(r.excerpt)?.replace(/\s+/g, ' ').slice(0, EXCERPT_MAX);
  if (!excerpt) return null;

  if (op === 'create' || op === 'owner_stated') {
    const kind = str(r.kind);
    if (!kind || !KINDS.has(kind)) return null;
    const statement = validStatement(r.statement);
    if ((statement && (looksLikeSecret(statement) || looksLikeIdentity(statement))) || looksLikeSecret(String(r.excerpt ?? ''))) return null;
    if (!statement) return null;
    const trait = traitFields(r, kind as BeliefKind);
    if (trait === 'invalid') return null;
    const timescale = str(r.timescale);
    const ts: BeliefTimescale = kind === 'situation' ? 'situational'
      : kind === 'episode' ? 'episodic'
        : timescale && TIMESCALES.has(timescale) ? (timescale as BeliefTimescale) : 'stable';
    const detail = str(r.detail)?.slice(0, 500);
    return {
      op, kind: kind as BeliefKind, statement, excerpt, context: validContext(r.context), timescale: ts,
      ...(detail ? { detail } : {}), ...(trait ?? {}),
    };
  }

  const beliefId = str(r.beliefId);
  if (!beliefId || !existingIds.has(beliefId)) return null;
  if (op === 'support' || op === 'contradict') return { op, beliefId, excerpt };

  // correction: replacement statement optional; when present it must be a valid statement.
  const statement = r.statement === undefined || r.statement === null || r.statement === '' ? undefined : validStatement(r.statement);
  if (r.statement !== undefined && r.statement !== null && r.statement !== '' && !statement) return null;
  const kind = str(r.kind);
  // A replacement that names a dimension or level must name a valid pair.
  const trait = kind === 'trait' || r.dimension !== undefined || r.level !== undefined ? traitFields(r, 'trait') : undefined;
  if (trait === 'invalid') return null;
  const timescale = str(r.timescale);
  return {
    op, beliefId, excerpt,
    ...(statement ? { statement } : {}),
    ...(kind && KINDS.has(kind) ? { kind: kind as BeliefKind } : {}),
    ...(r.context !== undefined ? { context: validContext(r.context) } : {}),
    ...(timescale && TIMESCALES.has(timescale) ? { timescale: timescale as BeliefTimescale } : {}),
    ...(trait ?? {}),
  };
}

/** Traits need a known dimension and level; other kinds carry neither. */
function traitFields(r: Record<string, unknown>, kind: BeliefKind): { dimension: string; level: string } | undefined | 'invalid' {
  if (kind !== 'trait') return undefined;
  const dimension = str(r.dimension)?.toLowerCase();
  const level = str(r.level)?.toLowerCase();
  if (!dimension || !level) return 'invalid';
  const levels = levelsFor(dimension);
  if (!levels || !levels.includes(level)) return 'invalid';
  return { dimension, level };
}

// ── the call ────────────────────────────────────────────────────────────

/** Whether a turn is worth a model call at all. */
export function shouldExtract(deps: Pick<ExtractDeps, 'tokenBudget' | 'learningPaused'>, input: Pick<ExtractInput, 'ownerMessage' | 'channelAccess'>): boolean {
  if (deps.learningPaused()) return false;
  if (input.channelAccess === 'general') return false;
  if (isTrivialMessage(input.ownerMessage)) return false;
  if (!deps.tokenBudget.canAfford(EXTRACT_MIN_BUDGET)) return false;
  return true;
}

export async function extractBeliefOperations(deps: ExtractDeps, input: ExtractInput): Promise<BeliefOperation[]> {
  if (!shouldExtract(deps, input)) return [];
  const existing = relevantBeliefs(deps.beliefs, input.ownerMessage);
  const provider = deps.providers.getDefault();
  const generate: GenerateFn = deps.generate ?? ((args) => generateText({ model: args.model as Parameters<typeof generateText>[0]['model'], system: args.system, messages: args.messages, maxOutputTokens: args.maxOutputTokens }));
  const result = await generate({
    model: provider.getModelInstance(),
    system: buildSystemPrompt(input.ownerName),
    messages: [{ role: 'user', content: buildUserPrompt(input, existing) }],
    maxOutputTokens: EXTRACT_MAX_OUTPUT_TOKENS,
  });
  const inputTokens = result.usage?.inputTokens ?? 0;
  const outputTokens = result.usage?.outputTokens ?? 0;
  deps.tokenBudget.recordUsage({
    provider: provider.name, model: provider.getModel(), inputTokens, outputTokens, totalTokens: inputTokens + outputTokens,
    channelType: 'internal', agentId: deps.agentId,
  });
  const ops = parseBeliefOperations(result.text ?? '', new Set(existing.map((b) => b.id)), { sessionId: input.sessionId, turnRef: input.turnRef, defaultExcerpt: ownerWords(input.ownerMessage) });
  if (ops.length > 0) logger.debug({ ops: ops.map((o) => `${o.op}${o.kind ? `:${o.kind}` : ''}`) }, 'Belief operations extracted');
  return ops;
}
