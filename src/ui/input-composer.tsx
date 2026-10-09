import React from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';

/**
 * Shared input composer — ONE source of truth for the interactive input
 * affordances used by every Mercury terminal surface (main TUI boot path and
 * the attach TUI):
 *
 *   • the canonical slash-command list (`SLASH_COMMANDS`)
 *   • slash + skill + bot-argument suggestion builders
 *   • input-history state helpers
 *   • the suggestion popup rendering
 *
 * The main TUI and the attach TUI both import from here. Before this module,
 * the suggestion logic lived only in App.tsx and the attach TUI shipped with
 * a bare character editor — which is exactly the "close & relaunch feels
 * different, auto-commands don't work" regression.
 */

// ─── Canonical command list ─────────────────────────────────────────────────

/**
 * Canonical slash-command list, shared by the main TUI (App.tsx) and the
 * attach TUI. Kept deliberately as a plain exported constant so the
 * autocomplete-sync contract test can assert on it.
 */
export const SLASH_COMMANDS: readonly string[] = [
  '/help',
  '/whatsnew',
  '/update ignore',
  '/log',
  '/sessions',
  '/session new',
  '/session current',
  '/session ',
  '/session archive ',
  '/session delete ',
  '/bots',
  '/bots list',
  '/bots open ',
  '/bots create ',
  '/bots send ',
  '/bots persona ',
  '/bots budget ',
  '/bots edit ',
  '/bots delete ',
  '/bots journal ',
  '/bots inbox ',
  '/bots storage',
  '/bots enable ',
  '/bots disable ',
  '/bots stop ',
  '/status',
  '/progress',
  '/menu',
  '/chat',
  '/code',
  '/code plan',
  '/code execute',
  '/code build',
  '/code diff',
  '/code init',
  '/code workspace',
  '/code agent ',
  '/code off',
  '/code toggle',
  '/code exit',
  '/code chat',
  '/code back',
  '/research',
  '/research on',
  '/research off',
  '/research toggle',
  '/research ',
  '/spotify',
  '/budget',
  '/permissions',
  '/memory',
  '/models',
  '/models use ',
  '/cloud',
  '/cloud models',
  '/cloud use ',
  '/agents',
  '/agents stop ',
  '/agents pause ',
  '/agents resume ',
  '/bg',
  '/bg current',
  '/bg list',
  '/bg cancel ',
  '/bg clear',
  '/bg killall',
  '/stop',
  '/halt',
  '/reset',
  '/tools',
  '/skills',
  '/skills search ',
  '/skills view ',
  '/skills install ',
  '/skills remove ',
  '/skills help',
  '/stream',
  '/saver',
  '/saver on',
  '/saver off',
  '/saver toggle',
  '/saver threshold ',
  '/saver auto on',
  '/saver auto off',
  '/saver routing on',
  '/saver routing off',
  '/view',
  '/view balanced',
  '/view detailed',
  '/ws',
  '/ws open ',
  '/ws exit',
  '/ws refresh',
  '/ws stage all',
  '/ws commit ',
  '/ws help',
] as const;

/** Suggestion cap for the slash picker. */
const MAX_SUGGESTIONS = 5;

/** Skill suggestions show more rows (name + description lines). */
const MAX_SKILL_SUGGESTIONS = 8;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface BotRosterEntry {
  id: string;
  name: string;
}

export interface SkillEntry {
  name: string;
  description: string;
}

// ─── Suggestion builders ────────────────────────────────────────────────────

/**
 * Slash-command suggestions for the current input. Handles bot-id argument
 * completion: `/bots <action> <partial>` and `/bot <partial>` suggest real
 * bot ids from the live roster (mixed with top base-command matches).
 */
export function buildSlashSuggestions(
  input: string,
  commands: readonly string[] = SLASH_COMMANDS,
  botRoster: readonly BotRosterEntry[] = [],
): string[] {
  if (!input.startsWith('/')) return [];
  const q = input.toLowerCase();
  const botsArg = /^(\/bots\s+(?:open|send|journal|inbox|budget|edit|delete|enable|disable|stop|persona)\s+)(\S*)$/.exec(input);
  const botArg = /^(\/bot\s+)(\S*)$/.exec(input);
  if ((botsArg || botArg) && botRoster.length > 0) {
    const [, cmdPrefix, typed] = (botsArg ?? botArg)! as unknown as [string, string, string];
    const p = typed.toLowerCase();
    const botCmds = botRoster
      .filter((b) => b.id.startsWith(p) || b.name.toLowerCase().startsWith(p))
      .slice(0, MAX_SUGGESTIONS)
      .map((b) => `${cmdPrefix}${b.id}`);
    const base = commands.filter((cmd) => cmd.startsWith(q)).slice(0, 2);
    return [...botCmds, ...base].slice(0, MAX_SUGGESTIONS);
  }
  return commands.filter((cmd) => cmd.startsWith(q)).slice(0, MAX_SUGGESTIONS);
}

/**
 * Skill suggestions for `#name` input. Prefix match first, then name
 * substring, then description substring (case-insensitive).
 */
export function buildSkillSuggestions(
  input: string,
  skills: readonly SkillEntry[] = [],
): Array<{ name: string; description: string }> {
  if (!input.startsWith('#')) return [];
  const q = input.slice(1).split(/\s/)[0].toLowerCase();
  if (!q) {
    return skills.slice(0, MAX_SKILL_SUGGESTIONS).map((s) => ({ name: s.name, description: s.description }));
  }
  const prefix: SkillEntry[] = [];
  const nameSub: SkillEntry[] = [];
  const descSub: SkillEntry[] = [];
  for (const s of skills) {
    const n = s.name.toLowerCase();
    if (n.startsWith(q)) prefix.push(s);
    else if (n.includes(q)) nameSub.push(s);
    else if ((s.description || '').toLowerCase().includes(q)) descSub.push(s);
  }
  return [...prefix, ...nameSub, ...descSub]
    .slice(0, MAX_SKILL_SUGGESTIONS)
    .map((s) => ({ name: s.name, description: s.description }));
}

// ─── Input history helpers ──────────────────────────────────────────────────

export interface InputHistoryState {
  history: string[];
  index: number;
  draft: string;
}

/**
 * Shell-style input history state: ↑ walks backwards, ↓ walks forwards,
 * editing mid-walk snapshots the draft, submissions dedup consecutive
 * repeats. Pure state helpers — both TUIs share identical navigation.
 */
export function createInputHistoryState(): InputHistoryState {
  return { history: [], index: -1, draft: '' };
}

/** Record a submitted line. Consecutive duplicates collapse. */
export function pushHistoryLine(state: InputHistoryState, line: string): InputHistoryState {
  if (state.history[state.history.length - 1] === line) return state;
  return { ...state, history: [...state.history.slice(-99), line], index: -1, draft: '' };
}

export function historyPrev(state: InputHistoryState, currentInput: string): { state: InputHistoryState; input: string } {
  if (state.history.length === 0) return { state, input: currentInput };
  if (state.index === -1) {
    const next = state.history.length - 1;
    return { state: { ...state, index: next, draft: currentInput }, input: state.history[next] ?? currentInput };
  }
  const next = Math.max(0, state.index - 1);
  return { state: { ...state, index: next }, input: state.history[next] ?? currentInput };
}

export function historyNext(state: InputHistoryState): { state: InputHistoryState; input: string } {
  if (state.index === -1) return { state, input: '' };
  const next = state.index + 1;
  if (next >= state.history.length) {
    return { state: { ...state, index: -1 }, input: state.draft };
  }
  return { state: { ...state, index: next }, input: state.history[next] ?? '' };
}

// ─── Character cleaning / paste safety ──────────────────────────────────────

/**
 * Private-use sentinels the stdin filter (channels/cli.ts
 * `MouseSequenceFilter`) prepends to text that must NOT go through Ink's
 * key parser as keystrokes:
 *
 *   • `PASTE_SENTINEL` — the chunk is bracketed-paste payload (`ESC[200~ …
 *     ESC[201~`). It is inserted literally: a pasted `\n` is a newline in
 *     the buffer, never Enter.
 *   • `FORWARD_DELETE_KEY` — the terminal's real Delete key (`ESC[3~`). Ink
 *     folds that AND `\x7f` (Backspace on macOS/Linux) into `key.delete`,
 *     so the filter rewrites `ESC[3~` to this sentinel to keep them apart.
 *
 * Both live in the Unicode private-use area, so no keyboard produces them.
 */
export const PASTE_SENTINEL = '';
export const FORWARD_DELETE_KEY = '';

/** True when the raw `ch` from `useInput` is a bracketed-paste chunk. */
export function isPasteChunk(ch: string | undefined): boolean {
  return typeof ch === 'string' && ch.startsWith(PASTE_SENTINEL);
}

/**
 * Strip control bytes and escape-sequence fragments from a raw `ch` payload.
 * Mouse scroll in raw mode emits SGR sequences like `\x1b[<0;row;colM` — Ink
 * partially consumes `\x1b[` and leaks the tail as individual chars, so every
 * surface must filter non-printables before accepting input.
 *
 * Newlines and tabs are KEPT (`\r\n` and lone `\r` normalise to `\n`): a
 * multi-line paste must land as multi-line text, not collapse to one line.
 * Only the control bytes that are never text are dropped.
 */
export function cleanPrintableInput(ch: string): string {
  let out = '';
  for (const c of ch.replace(/\r\n?/g, '\n')) {
    const code = c.codePointAt(0) ?? 0;
    if (code === 0x0a || code === 0x09) { out += c; continue; }
    if (code === PASTE_SENTINEL.codePointAt(0) || code === FORWARD_DELETE_KEY.codePointAt(0)) continue;
    if ((code >= 0x20 && code <= 0x7e) || code >= 0xa0) out += c;
  }
  return out;
}

/** Flood guard: never let a corrupt stream grow the input unboundedly. */
export const MAX_INPUT_LEN = 8000;

/**
 * Insert a cleaned chunk at the cursor position with the flood guard applied.
 * Returns the (possibly clamped) new input + new cursor position. Paste
 * sentinels are stripped, so a bracketed chunk inserts as plain text.
 */
export function insertInputChunk(
  input: string,
  cursorPos: number,
  chunk: string,
): { input: string; cursorPos: number } {
  const clean = cleanPrintableInput(chunk);
  if (!clean) return { input, cursorPos };
  const next = input.slice(0, cursorPos) + clean + input.slice(cursorPos);
  if (next.length > MAX_INPUT_LEN) {
    if (input.length >= MAX_INPUT_LEN) return { input, cursorPos };
    const accepted = MAX_INPUT_LEN - input.length;
    // Never cut a surrogate pair in half at the clamp boundary.
    let cut = MAX_INPUT_LEN;
    if (cut > 0 && cut < next.length && /[\uD800-\uDBFF]/.test(next[cut - 1]) && /[\uDC00-\uDFFF]/.test(next[cut])) cut -= 1;
    const clamped = next.slice(0, cut);
    return { input: clamped, cursorPos: Math.min(clamped.length, cursorPos + Math.max(0, accepted)) };
  }
  return { input: next, cursorPos: cursorPos + clean.length };
}

// ─── Grapheme-aware cursor math ─────────────────────────────────────────────
//
// The input buffer is a JS string, so `cursorPos` is a UTF-16 offset. Every
// cursor move and deletion below steps by *grapheme cluster* (emoji with
// modifiers/ZWJ, CJK, combining marks) instead of by code unit, so a
// backspace over "👨‍👩‍👧" removes the whole family instead of leaving a
// broken half, and ← / → never land inside a surrogate pair.

type Segmenter = { segment(input: string): Iterable<{ segment: string; index: number }> };
const graphemeSegmenter: Segmenter | null = (() => {
  try {
    const S = (Intl as unknown as { Segmenter?: new (locale?: string, opts?: { granularity: string }) => Segmenter }).Segmenter;
    return S ? new S(undefined, { granularity: 'grapheme' }) : null;
  } catch {
    return null;
  }
})();

/** Split a string into grapheme clusters (code-point fallback without Intl.Segmenter). */
export function graphemes(text: string): string[] {
  if (text.length === 0) return [];
  if (graphemeSegmenter) {
    const out: string[] = [];
    for (const { segment } of graphemeSegmenter.segment(text)) out.push(segment);
    return out;
  }
  return Array.from(text);
}

/** UTF-16 offset of the grapheme boundary immediately before `pos` (0 at start). */
export function prevGraphemeBoundary(text: string, pos: number): number {
  if (pos <= 0) return 0;
  const head = text.slice(0, Math.min(pos, text.length));
  if (head.length === 0) return 0;
  const parts = graphemes(head);
  const last = parts[parts.length - 1] ?? '';
  return head.length - last.length;
}

/** UTF-16 offset of the grapheme boundary immediately after `pos` (text.length at end). */
export function nextGraphemeBoundary(text: string, pos: number): number {
  if (pos >= text.length) return text.length;
  const tail = text.slice(Math.max(0, pos));
  if (graphemeSegmenter) {
    for (const { segment } of graphemeSegmenter.segment(tail)) return pos + segment.length;
  }
  const first = Array.from(tail)[0] ?? '';
  return pos + first.length;
}

/** The grapheme cluster that starts at `pos` ('' at end of text). */
export function graphemeAt(text: string, pos: number): string {
  return text.slice(pos, nextGraphemeBoundary(text, pos));
}

/** Text as the input box draws it: tabs become two spaces (Ink measures a
 * raw tab as zero width while the terminal jumps to the next tab stop, so
 * the cursor cell would drift). */
export function expandTabs(text: string): string {
  return text.replace(/\t/g, '  ');
}

/** Terminal column width of one grapheme cluster (East-Asian wide + emoji = 2). */
export function graphemeWidth(cluster: string): number {
  if (cluster.length === 0) return 0;
  return stringWidth(expandTabs(cluster));
}

/** Terminal column width of a string (grapheme-aware, via `string-width`). */
export function displayWidth(text: string): number {
  return stringWidth(expandTabs(text));
}

/**
 * Column (0-based) at which the cursor sits on `line` when `cursorCol` is a
 * UTF-16 offset into it — i.e. the display width of the text before it.
 */
export function cursorColumn(line: string, cursorCol: number): number {
  return displayWidth(line.slice(0, Math.max(0, Math.min(cursorCol, line.length))));
}

/** Backspace: delete the grapheme before the cursor. */
export function backspaceAt(input: string, cursorPos: number): { input: string; cursorPos: number } {
  if (cursorPos <= 0) return { input, cursorPos };
  const start = prevGraphemeBoundary(input, cursorPos);
  return {
    input: input.slice(0, start) + input.slice(cursorPos),
    cursorPos: start,
  };
}

/** Forward delete: delete the grapheme under the cursor. */
export function deleteForwardAt(input: string, cursorPos: number): { input: string; cursorPos: number } {
  if (cursorPos >= input.length) return { input, cursorPos };
  const end = nextGraphemeBoundary(input, cursorPos);
  return { input: input.slice(0, cursorPos) + input.slice(end), cursorPos };
}

/** Delete a range [from, to) and put the cursor at `from`. */
function deleteRange(input: string, from: number, to: number): { input: string; cursorPos: number } {
  if (from >= to) return { input, cursorPos: from };
  return { input: input.slice(0, from) + input.slice(to), cursorPos: from };
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

/** Start of the word before `pos` (readline `backward-word`). */
export function wordBoundaryLeft(text: string, pos: number): number {
  let p = Math.min(pos, text.length);
  // Skip separators, then the word.
  while (p > 0) {
    const prev = prevGraphemeBoundary(text, p);
    const g = text.slice(prev, p);
    if (WORD_CHAR.test(g) || g === '\n') break;
    p = prev;
  }
  if (p > 0 && text.slice(prevGraphemeBoundary(text, p), p) === '\n') return prevGraphemeBoundary(text, p);
  while (p > 0) {
    const prev = prevGraphemeBoundary(text, p);
    if (!WORD_CHAR.test(text.slice(prev, p))) break;
    p = prev;
  }
  return p;
}

/** End of the word after `pos` (readline `forward-word`). */
export function wordBoundaryRight(text: string, pos: number): number {
  let p = Math.max(0, pos);
  while (p < text.length) {
    const next = nextGraphemeBoundary(text, p);
    const g = text.slice(p, next);
    if (WORD_CHAR.test(g) || g === '\n') break;
    p = next;
  }
  if (p < text.length && text.slice(p, nextGraphemeBoundary(text, p)) === '\n') return nextGraphemeBoundary(text, p);
  while (p < text.length) {
    const next = nextGraphemeBoundary(text, p);
    if (!WORD_CHAR.test(text.slice(p, next))) break;
    p = next;
  }
  return p;
}

/** Start offset of the line containing `pos`. */
export function lineStart(text: string, pos: number): number {
  const i = text.lastIndexOf('\n', Math.max(0, pos - 1));
  return i < 0 ? 0 : i + 1;
}

/** End offset (exclusive) of the line containing `pos`. */
export function lineEnd(text: string, pos: number): number {
  const i = text.indexOf('\n', pos);
  return i < 0 ? text.length : i;
}

// ─── Key reducer (shared by every surface) ──────────────────────────────────

/** The subset of Ink's `Key` the editor cares about. */
export interface EditorKey {
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  return?: boolean;
  escape?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  tab?: boolean;
  backspace?: boolean;
  delete?: boolean;
  meta?: boolean;
  home?: boolean;
  end?: boolean;
  /** Ink's internal keypress name (`enter` for a bare `\n`). */
  name?: string;
}

export interface EditResult {
  input: string;
  cursorPos: number;
}

/**
 * Pure text-editing reducer for ONE keystroke. Returns the next buffer and
 * cursor, or `null` when the key is not an editing key (the caller then
 * applies its own bindings: submit, history, suggestions, mode shortcuts).
 *
 * Bindings (readline-style, identical on the main TUI, Mercury Code and
 * the attach TUI):
 *
 *   paste chunk          insert literally (newlines kept, never Enter)
 *   Ctrl+N / Shift+Enter insert newline (the stdin filter maps Shift+Enter
 *                        sequences to Ctrl+N)
 *   ← / →                move one grapheme
 *   Alt+← / Alt+→,       move one word
 *   Ctrl+← / Ctrl+→,
 *   Alt+B / Alt+F
 *   Home / End,          line start / line end
 *   Ctrl+A / Ctrl+E
 *   Backspace            delete grapheme before cursor
 *   Delete               delete grapheme under cursor
 *   Ctrl+W               delete word before cursor
 *   Ctrl+U               delete to line start
 *   Ctrl+K               delete to line end
 *   printable text       insert at cursor
 */
export function applyEditKey(input: string, cursorPos: number, ch: string | undefined, key: EditorKey): EditResult | null {
  const pos = Math.max(0, Math.min(cursorPos, input.length));
  const c = ch ?? '';

  if (isPasteChunk(c)) return insertInputChunk(input, pos, c);
  if (c === FORWARD_DELETE_KEY) return deleteForwardAt(input, pos);

  if (key.ctrl) {
    const letter = c.toLowerCase();
    if (letter === 'n' || c === '\x0e') return insertInputChunk(input, pos, '\n');
    if (letter === 'a') return { input, cursorPos: lineStart(input, pos) };
    if (letter === 'e') return { input, cursorPos: lineEnd(input, pos) };
    if (letter === 'w') return deleteRange(input, wordBoundaryLeft(input, pos), pos);
    if (letter === 'u') return deleteRange(input, lineStart(input, pos), pos);
    if (letter === 'k') return deleteRange(input, pos, lineEnd(input, pos));
    if (key.leftArrow) return { input, cursorPos: wordBoundaryLeft(input, pos) };
    if (key.rightArrow) return { input, cursorPos: wordBoundaryRight(input, pos) };
    return null;
  }

  if (key.meta) {
    if (key.leftArrow || c === 'b') return { input, cursorPos: wordBoundaryLeft(input, pos) };
    if (key.rightArrow || c === 'f') return { input, cursorPos: wordBoundaryRight(input, pos) };
    // Alt+Backspace (ESC DEL) also deletes the previous word in most shells.
    if (key.backspace || key.delete) return deleteRange(input, wordBoundaryLeft(input, pos), pos);
    return null;
  }

  if (key.leftArrow) return { input, cursorPos: prevGraphemeBoundary(input, pos) };
  if (key.rightArrow) return { input, cursorPos: nextGraphemeBoundary(input, pos) };
  if (key.home) return { input, cursorPos: lineStart(input, pos) };
  if (key.end) return { input, cursorPos: lineEnd(input, pos) };
  if (key.backspace || key.delete) return backspaceAt(input, pos);

  if (key.return || key.escape || key.tab || key.upArrow || key.downArrow || key.name === 'enter') return null;
  if (c.length > 0) return insertInputChunk(input, pos, c);
  return null;
}

// ─── Ctrl+C semantics ───────────────────────────────────────────────────────

/** Second Ctrl+C within this window (on an empty input) exits. */
export const CTRL_C_EXIT_WINDOW_MS = 1500;

export type CtrlCAction = 'clear' | 'arm' | 'exit';

/**
 * Ctrl+C never kills the process on a single tap:
 *   • input non-empty → `clear` the input
 *   • input empty, not armed (or armed too long ago) → `arm` and show the
 *     "Press Ctrl+C again to exit" hint
 *   • input empty, armed within the window → `exit`
 */
export function ctrlCAction(input: string, armedAt: number | null, now: number): CtrlCAction {
  if (input.length > 0) return 'clear';
  if (armedAt != null && now - armedAt <= CTRL_C_EXIT_WINDOW_MS) return 'exit';
  return 'arm';
}

/** Hint shown while a Ctrl+C exit is armed. */
export const CTRL_C_EXIT_HINT = 'Press Ctrl+C again to exit';

// ─── Suggestion popup rendering ─────────────────────────────────────────────

/**
 * The shared suggestion popup. Identical visual contract on every surface: a
 * dim header, `›`-selected rows, cyan for slash commands, magenta for skills.
 * Both TUIs render this directly under the input box.
 */
export function SuggestionList({
  kind,
  suggestions,
  selectedIndex,
}: {
  kind: 'slash' | 'skill';
  suggestions: readonly string[];
  selectedIndex: number;
}): React.ReactNode {
  if (suggestions.length === 0) return null;
  if (kind === 'skill') {
    const entries = suggestions as unknown as Array<{ name: string; description: string }>;
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text dimColor>Skills (↑↓ navigate · Tab/Enter to select):</Text>
        {entries.map((s, idx) => (
          <Text key={s.name} color={idx === selectedIndex ? 'magenta' : 'gray'}>
            {idx === selectedIndex ? '›' : ' '} #{s.name}
            {s.description ? <Text dimColor> — {s.description.slice(0, 70)}{s.description.length > 70 ? '…' : ''}</Text> : null}
          </Text>
        ))}
      </Box>
    );
  }
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text dimColor>Suggestions (↑↓ navigate · Tab/Enter to select):</Text>
      {suggestions.map((cmd, idx) => (
        <Text key={cmd} color={idx === selectedIndex ? 'cyan' : 'gray'}>{idx === selectedIndex ? '›' : ' '} {cmd}</Text>
      ))}
    </Box>
  );
}

/**
 * Enter-fill contract for the slash picker: when suggestions are showing and
 * the typed input does not exactly equal the selected one, Enter must FILL
 * the suggestion into the input instead of submitting. Returns true when the
 * caller should submit normally.
 */
export function shouldSubmitSlash(slashSuggestions: readonly string[], trimmedInput: string, selectedIndex: number): boolean {
  if (slashSuggestions.length === 0) return true;
  return trimmedInput === slashSuggestions[selectedIndex];
}

/**
 * Skill-entry fill helper shared by both TUIs: inserts `#name ` while keeping
 * any remainder typed after the hash-token.
 */
export function skillFillText(input: string, pickedName: string): string {
  const rest = input.slice(1).split(/\s(.*)/s)[1] || '';
  return rest ? `#${pickedName} ${rest}` : `#${pickedName} `;
}