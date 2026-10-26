/**
 * The one status row under the chat input (attached terminal and the
 * foreground TUI share it). Two halves:
 *
 *   left  — what is happening now: a spinner + phase + elapsed while a turn
 *           runs, a notice when there is one, otherwise nothing.
 *   right — where you are: permission mode, today's budget meter (green →
 *           yellow → red), model, Code mode, Optimus, an update — each in
 *           priority order with a compact form, and the session alias last. Segments that do not fit are
 *           dropped from the lowest priority up; nothing is ever cut
 *           mid-word, and a long model or session name never pushes the
 *           useful parts off the row.
 *
 * Pure functions, so the fitting is testable at any width.
 */

export interface StatusSegment {
  text: string;
  color: string;
  /** Lower number = kept longer when the row is narrow. */
  priority: number;
  /** Narrower spelling tried before the segment is dropped. */
  compact?: string;
}

export interface StatusInputs {
  provider?: { name: string; model: string } | null;
  permission?: 'allow-all' | 'ask-me' | '' | null;
  /** Today's budget use, 0–100+, or null when unknown. */
  tokensPct?: number | null;
  /** Mercury Code mode ('off' or a mode name). */
  codeMode?: string | null;
  /** What a desktop plugin is doing right now (Optimus), or ''. */
  desktop?: string | null;
  /** A newer version the update check found. */
  updateAvailable?: string | null;
  session?: { alias: string; shortId?: string } | null;
  /** Caller-specific extras (workspace branch, background tasks, agents). */
  extras?: StatusSegment[];
}

export const SEPARATOR = ' · ';
const MAX_SESSION_CHARS = 16;
const MAX_MODEL_CHARS = 28;

/**
 * A model id as a person says it: no provider path, no vendor date stamp,
 * no tier tag in the compact form.
 *   anthropic/claude-sonnet-4.6      → claude-sonnet-4.6
 *   claude-haiku-4-5-20251001        → claude-haiku-4-5
 *   minimax-m3.1-flash:free          → minimax-m3.1-flash:free (compact: minimax-m3.1-flash)
 *   gpt-4.1-mini                     → gpt-4.1-mini
 */
export function shortModel(model: string, opts: { compact?: boolean } = {}): string {
  let m = model.trim();
  if (!m) return '';
  m = m.split('/').pop() ?? m;
  m = m.replace(/-20\d{6}$/, '');           // claude-…-20251001
  m = m.replace(/-latest$/, '');
  if (opts.compact) m = m.replace(/:[a-z0-9-]+$/i, '');  // :free, :beta
  return fit(m, MAX_MODEL_CHARS);
}

/** The session alias, short: "quiet-harbour-42" → "quiet-harbour-42", longer ones end in …. */
export function shortSession(alias: string, max = MAX_SESSION_CHARS): string {
  const a = alias.trim().replace(/\s+/g, ' ');
  return fit(a, max);
}

function fit(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return '…';
  return text.slice(0, max - 1).replace(/[-_ .:]+$/, '') + '…';
}

/** Budget colour, as the completion footer has always shown it: green, then yellow from 70 %, red from 90 %. */
export function tokenColor(pct: number): string {
  return pct >= 90 ? 'red' : pct >= 70 ? 'yellow' : 'green';
}

/** A small meter for today's budget: `█░░░░░░░` at 12 %. */
export function budgetBar(pct: number, cells = 8): string {
  const filled = Math.round((Math.max(0, Math.min(100, pct)) / 100) * cells);
  return '█'.repeat(filled) + '░'.repeat(cells - filled);
}

/** The right-hand segments in priority order (not yet fitted): desktop 0, permission 1, budget 2, model 3, Code 4, update 5, extras, session 9. */
export function statusSegments(i: StatusInputs): StatusSegment[] {
  const out: StatusSegment[] = [];
  if (i.desktop) out.push({ text: i.desktop, color: 'yellow', priority: 0 });
  if (i.permission === 'allow-all') out.push({ text: 'Allow All', compact: 'Allow', color: 'yellow', priority: 1 });
  else if (i.permission === 'ask-me') out.push({ text: 'Ask Me', compact: 'Ask', color: 'gray', priority: 1 });
  // The model only: the provider name made the row too long, and the model
  // name already says who serves it (claude-…, gpt-…, minimax-…).
  if (i.provider?.model || i.provider?.name) {
    const model = i.provider.model ? shortModel(i.provider.model) : '';
    const compact = i.provider.model ? shortModel(i.provider.model, { compact: true }) : i.provider.name;
    out.push({ text: model || i.provider.name, compact, color: 'magenta', priority: 3 });
  }
  // Today's budget outranks the model: the owner asked for the meter to stay
  // on the row, and the model is one /model away.
  if (typeof i.tokensPct === 'number' && Number.isFinite(i.tokensPct)) {
    const pct = Math.max(0, Math.min(999, Math.round(i.tokensPct)));
    out.push({ text: `⚡ ${budgetBar(pct)} ${pct}%`, compact: `⚡${pct}%`, color: tokenColor(pct), priority: 2 });
  }
  if (i.codeMode && i.codeMode !== 'off') out.push({ text: `CODE ${i.codeMode.toUpperCase()}`, compact: 'CODE', color: 'cyan', priority: 4 });
  if (i.updateAvailable) out.push({ text: `⬆ v${i.updateAvailable.replace(/^v/, '')}`, compact: '⬆', color: 'green', priority: 5 });
  for (const extra of i.extras ?? []) out.push(extra);
  if (i.session?.alias) {
    out.push({ text: shortSession(i.session.alias), compact: shortSession(i.session.alias, 10), color: 'blue', priority: 9 });
  }
  return out.sort((a, b) => a.priority - b.priority);
}

function rowWidth(segments: ReadonlyArray<{ text: string }>): number {
  return segments.reduce((n, s, idx) => n + s.text.length + (idx > 0 ? SEPARATOR.length : 0), 0);
}

/**
 * Fit the segments into `width` columns: first swap the longest-priority
 * segments to their compact form (lowest priority first), then drop from
 * the lowest priority up. Keeps the original order (priority order).
 */
export function fitSegments(segments: StatusSegment[], width: number): StatusSegment[] {
  let current = segments.map((s) => ({ ...s }));
  if (rowWidth(current) <= width) return current;
  // Compact pass, lowest priority first.
  const byLowest = [...current].sort((a, b) => b.priority - a.priority);
  for (const seg of byLowest) {
    if (seg.compact && seg.compact !== seg.text) {
      seg.text = seg.compact;
      if (rowWidth(current) <= width) return current;
    }
  }
  // Drop pass, lowest priority first.
  const dropped: StatusSegment[] = [];
  while (current.length > 0 && rowWidth(current) > width) {
    let lowest = 0;
    for (let k = 1; k < current.length; k++) if (current[k].priority > current[lowest].priority) lowest = k;
    dropped.push(current[lowest]);
    current = current.filter((_, k) => k !== lowest);
  }
  // A big segment going last may have freed room for a small one dropped
  // earlier (the model goes, "⚡12%" fits again): take those back, best first.
  for (const seg of dropped.sort((a, b) => a.priority - b.priority)) {
    const candidate = [...current, seg].sort((a, b) => a.priority - b.priority);
    if (rowWidth(candidate) <= width) current = candidate;
  }
  return current;
}

export interface ActivityInputs {
  busy: boolean;
  /** What is happening ("Thinking", "run_command", "Writing"). */
  phase?: string | null;
  elapsedSec?: number | null;
  /** A transient message that outranks everything on the left. */
  notice?: string | null;
  /** The spinner glyph for this tick. */
  spinner?: string;
}

export interface ActivityLine {
  text: string;
  color: string;
  dim: boolean;
}

/**
 * The left half: notice > live phase + elapsed > nothing. Idle, the row says
 * nothing on the left: Enter sends and /help lists the commands, and a row of
 * key hints under every message was noise people stopped reading.
 */
export function activityLine(i: ActivityInputs): ActivityLine {
  if (i.notice) return { text: i.notice, color: 'yellow', dim: false };
  if (i.busy) {
    const secs = Math.max(0, Math.floor(i.elapsedSec ?? 0));
    const time = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
    const phase = (i.phase || 'Thinking').trim();
    const tone = secs >= 90 ? 'red' : secs >= 30 ? 'yellow' : 'cyan';
    return { text: `${i.spinner ?? '⠋'} ${phase} · ${time}`, color: tone, dim: false };
  }
  return { text: '', color: 'gray', dim: true };
}

/**
 * Split the row: the left half gets what it needs up to `maxLeftShare` of the
 * width, the right half gets the rest (minus one column of breathing room).
 */
export function splitRow(cols: number, leftText: string, maxLeftShare = 0.55): { left: number; right: number } {
  const usable = Math.max(10, cols);
  const left = Math.min(leftText.length, Math.floor(usable * maxLeftShare));
  return { left, right: Math.max(0, usable - left - 1) };
}

/** Human phase for a running tool step label ("read_file" → "read_file"); the label is already short. */
export function phaseFromStep(label: string | null | undefined, streamingText: boolean): string {
  if (label) return label.length > 40 ? label.slice(0, 39) + '…' : label;
  return streamingText ? 'Writing' : 'Thinking';
}
