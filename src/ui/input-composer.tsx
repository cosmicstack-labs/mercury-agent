import React from 'react';
import { Box, Text } from 'ink';

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
 * Strip control bytes and escape-sequence fragments from a raw `ch` payload.
 * Mouse scroll in raw mode emits SGR sequences like `\x1b[<0;row;colM` — Ink
 * partially consumes `\x1b[` and leaks the tail as individual chars, so every
 * surface must filter non-printables before accepting input.
 */
export function cleanPrintableInput(ch: string): string {
  return ch
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .split('')
    .filter((c) => {
      const code = c.charCodeAt(0);
      return (code >= 0x20 && code <= 0x7e) || code >= 0xa0;
    })
    .join('');
}

/** Flood guard: never let a corrupt stream grow the input unboundedly. */
export const MAX_INPUT_LEN = 8000;

/**
 * Insert a cleaned chunk at the cursor position with the flood guard applied.
 * Returns the (possibly clamped) new input + new cursor position.
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
    return { input: next.slice(0, MAX_INPUT_LEN), cursorPos: cursorPos + Math.max(0, accepted) };
  }
  return { input: next, cursorPos: cursorPos + clean.length };
}

export function backspaceAt(input: string, cursorPos: number): { input: string; cursorPos: number } {
  if (cursorPos <= 0) return { input, cursorPos };
  return {
    input: input.slice(0, cursorPos - 1) + input.slice(cursorPos),
    cursorPos: cursorPos - 1,
  };
}

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