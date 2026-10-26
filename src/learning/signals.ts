import { ownerWords } from './text.js';
/**
 * Turn signals: the behavioural evidence one chat turn leaves behind,
 * computed without a model call (docs/owner-model.md §3.3). The per-turn
 * extractor reads them alongside the owner's words; the reflection pass
 * mines them across sessions. Every function here is pure.
 */

export type TimeOfDay = 'morning' | 'daytime' | 'evening' | 'late-night';
export type PermissionAnswer = 'yes' | 'no' | 'always';

export interface TurnSignalInput {
  /** The owner's message this turn. */
  message: string;
  /** Earlier owner messages in the same session (oldest first), for repeat detection. */
  previousUserMessages?: readonly string[];
  /** Permission prompts answered during this turn, when the channel reports them. */
  permissionAnswers?: ReadonlyArray<{ action: string; answer: PermissionAnswer }>;
  /** Session-level Allow All was on for this turn. */
  allowAllActive?: boolean;
  /** Tool calls made this turn and whether each failed. */
  toolTrace?: ReadonlyArray<{ tool: string; failed: boolean }>;
  channelType?: string;
  sessionId?: string;
  cwd?: string;
  /** The turn's clock (local timezone); defaults to now. */
  now?: Date;
}

export interface TurnSignals {
  correction: {
    detected: boolean;
    /** Which cues fired ("no, I meant", "repeated request", …). */
    cues: string[];
    /** The message repeats an earlier owner message in this session. */
    repeatedRequest: boolean;
  };
  /** An explicit ask for a shorter or longer reply. */
  brevity: 'shorter' | 'longer' | null;
  /** An explicit ask about asking before acting. */
  autonomy: 'just-do-it' | 'ask-first' | null;
  /** How the owner wants decisions presented this turn. */
  decisionStyle: 'options' | 'recommendation' | 'decide-for-me' | null;
  permissionAnswers: Array<{ action: string; answer: PermissionAnswer }>;
  allowAllActive: boolean;
  timeOfDay: TimeOfDay;
  hourLocal: number;
  channelType: string | null;
  sessionId: string | null;
  cwd: string | null;
  messageLength: number;
  tools: { used: string[]; failed: string[] };
}

const CORRECTION_CUES: Array<{ cue: string; re: RegExp }> = [
  { cue: 'no, I meant', re: /\bno[,.]?\s+i\s+meant\b/i },
  { cue: "that's not what I asked", re: /\b(that'?s|this is|it'?s)\s+not\s+what\s+i\s+(asked|meant|said|wanted|want)\b/i },
  { cue: 'not that', re: /(^|[.!?,;:]\s*|\bno[,.]?\s+)not\s+that\b/i },
  { cue: 'I said', re: /\bi\s+(already\s+)?(said|told\s+you)\b/i },
  { cue: 'again', re: /(?<!\bthanks?\s)(?<!\bthank\s+you\s)\b(again|once\s+more)\b/i },
  { cue: 'wrong', re: /\b(that'?s|this is|you'?re|you\s+are)\s+wrong\b|\bwrong\s+(file|answer|one|thing)\b/i },
  { cue: 'undo', re: /\b(undo|revert)\s+(that|this|it)\b/i },
];

const SHORTER = /\b(shorter|too\s+long|too\s+verbose|tl;?dr|tldr|brief(er)?|concise|less\s+detail|keep\s+it\s+short|one[\s-]liner?|just\s+the\s+(answer|result|command|code|number))\b/i;
const LONGER = /\b(more\s+detail(s|ed)?|explain|elaborate|expand\s+on|walk\s+me\s+through|in\s+depth|step\s+by\s+step|longer\s+(answer|version))\b/i;

const JUST_DO_IT = /\b(just\s+do\s+it|don[’']?t\s+ask(\s+me)?|no\s+need\s+to\s+ask|stop\s+asking|why\s+(did|do|are)\s+you\s+ask(ing)?|without\s+asking|you\s+don[’']?t\s+(have|need)\s+to\s+ask)\b/i;
// "ask first" / "ask before" count only when not negated ("don't ask before running tests" is the opposite).
const ASK_FIRST = /\b((?<!don[’']?t\s)(?<!never\s)(?<!no\s+need\s+to\s)ask(\s+me)?\s+(first|before)|check\s+with\s+me|always\s+ask|don[’']?t\s+(do|run|change|delete|send|publish)\s+(that|this|anything|it)\s+without\s+(asking|checking))\b/i;

const OPTIONS = /\b(give\s+me\s+(some\s+|a\s+few\s+|the\s+)?options|what\s+are\s+(my|the)\s+options|list\s+(the\s+)?(options|alternatives)|show\s+me\s+(the\s+)?alternatives)\b/i;
const DECIDE_FOR_ME = /\b(just\s+pick\s+(one|something)|pick\s+one(\s+for\s+me)?|you\s+(choose|decide|pick)|decide\s+for\s+me|whatever\s+you\s+think(\s+is)?\s+(best|right)?)\b/i;
const RECOMMENDATION = /\b(what\s+(do|would)\s+you\s+(recommend|suggest)|what\s+should\s+i\b|your\s+recommendation|which\s+(one\s+)?(do|would)\s+you\s+(recommend|suggest|go\s+with))\b/i;

/** Lowercase, strip punctuation, collapse whitespace: the key for "same request again". */
export function normalizeMessage(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

export function timeOfDayBucket(date: Date): TimeOfDay {
  const h = date.getHours();
  if (h >= 5 && h < 11) return 'morning';
  if (h >= 11 && h < 18) return 'daytime';
  if (h >= 18 && h < 23) return 'evening';
  return 'late-night';
}

export function detectCorrection(message: string, previousUserMessages: readonly string[] = []): TurnSignals['correction'] {
  const cues: string[] = [];
  for (const { cue, re } of CORRECTION_CUES) if (re.test(message)) cues.push(cue);
  const norm = normalizeMessage(message);
  const repeatedRequest = norm.length >= 8 && previousUserMessages.some((m) => normalizeMessage(m) === norm);
  if (repeatedRequest) cues.push('repeated request');
  return { detected: cues.length > 0, cues, repeatedRequest };
}

export function detectBrevityRequest(message: string): TurnSignals['brevity'] {
  if (SHORTER.test(message)) return 'shorter';
  if (LONGER.test(message)) return 'longer';
  return null;
}

export function detectAutonomyRequest(message: string): TurnSignals['autonomy'] {
  // "ask first" wins when both appear ("don't ask about reads, but ask first before deleting").
  if (ASK_FIRST.test(message)) return 'ask-first';
  if (JUST_DO_IT.test(message)) return 'just-do-it';
  return null;
}

export function detectDecisionStyle(message: string): TurnSignals['decisionStyle'] {
  if (DECIDE_FOR_ME.test(message)) return 'decide-for-me';
  if (OPTIONS.test(message)) return 'options';
  if (RECOMMENDATION.test(message)) return 'recommendation';
  return null;
}

/** Parse the turn's tool-trace lines ("- tool args → ✗ …" / "→ ok …") back into tool/failed pairs. */
export function parseToolTraceLines(lines: readonly string[]): Array<{ tool: string; failed: boolean }> {
  const out: Array<{ tool: string; failed: boolean }> = [];
  for (const line of lines) {
    const m = /^-\s*([A-Za-z0-9_.:-]+)/.exec(line);
    if (!m) continue;
    const arrow = line.lastIndexOf('→');
    const outcome = arrow >= 0 ? line.slice(arrow + 1).trim() : '';
    out.push({ tool: m[1], failed: outcome.startsWith('✗') });
  }
  return out;
}

export function collectTurnSignals(input: TurnSignalInput): TurnSignals {
  const message = ownerWords(input.message ?? '');
  const now = input.now ?? new Date();
  const used: string[] = [];
  const failed: string[] = [];
  for (const t of input.toolTrace ?? []) {
    if (!used.includes(t.tool)) used.push(t.tool);
    if (t.failed && !failed.includes(t.tool)) failed.push(t.tool);
  }
  return {
    correction: detectCorrection(message, (input.previousUserMessages ?? []).map(ownerWords) ?? []),
    brevity: detectBrevityRequest(message),
    autonomy: detectAutonomyRequest(message),
    decisionStyle: detectDecisionStyle(message),
    permissionAnswers: (input.permissionAnswers ?? []).map((p) => ({ action: p.action, answer: p.answer })),
    allowAllActive: input.allowAllActive === true,
    timeOfDay: timeOfDayBucket(now),
    hourLocal: now.getHours(),
    channelType: input.channelType ?? null,
    sessionId: input.sessionId ?? null,
    cwd: input.cwd ?? null,
    messageLength: message.length,
    tools: { used, failed },
  };
}

/** True when the turn carried any explicit behavioural request or correction. */
export function hasBehavioralSignal(s: TurnSignals): boolean {
  return s.correction.detected || s.brevity !== null || s.autonomy !== null || s.decisionStyle !== null || s.permissionAnswers.length > 0;
}

/** A compact, line-per-signal rendering for the extraction prompt. */
export function describeSignals(s: TurnSignals): string {
  const lines: string[] = [];
  lines.push(`correction: ${s.correction.detected ? `yes (${s.correction.cues.join(', ')})` : 'none detected'}`);
  if (s.brevity) lines.push(`asked for a ${s.brevity} reply`);
  if (s.autonomy) lines.push(`autonomy request: ${s.autonomy}`);
  if (s.decisionStyle) lines.push(`decision style requested: ${s.decisionStyle}`);
  if (s.permissionAnswers.length > 0) lines.push(`permission answers: ${s.permissionAnswers.map((p) => `${p.action}=${p.answer}`).join(', ')}`);
  if (s.allowAllActive) lines.push('session Allow All is on');
  lines.push(`time: ${s.timeOfDay} (${String(s.hourLocal).padStart(2, '0')}:00 local)`);
  if (s.channelType) lines.push(`channel: ${s.channelType}`);
  if (s.cwd) lines.push(`project cwd: ${s.cwd}`);
  lines.push(`message length: ${s.messageLength} chars`);
  if (s.tools.used.length > 0) lines.push(`tools used: ${s.tools.used.join(', ')}${s.tools.failed.length > 0 ? `; failed: ${s.tools.failed.join(', ')}` : ''}`);
  return lines.join('\n');
}
