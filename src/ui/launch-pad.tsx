/**
 * The launch pad: the first screen of the Mercury TUI.
 *
 * Design rules:
 * - Every status row reflects real state (provider handshake, skills
 *   discovered, web server, budget, workspace). Nothing ticks on a timer.
 * - The layout never jumps: every row is present from the first frame, and
 *   pending rows show a spinner in place of the check.
 * - The mark draws in top-down over ~300 ms once, then stays still.
 * - Typing anywhere starts chat (handled by the app's input layer); Enter on
 *   an empty pad does the same; Tab toggles the skills list.
 */
import React from 'react';
import { Box, Text } from 'ink';
import { homedir } from 'node:os';
import type { TuiState } from '../channels/cli.js';
import { IS_LIGHT_TERMINAL } from '../utils/terminal-theme.js';
import { isDevBuild } from '../utils/dev-build.js';
import { fitText, fitTail, isNarrow } from './layout.js';
import { useTick, spinnerFrame } from './tick-store.js';
import { MERCURY_MARK, MERCURY_MARK_SMALL, MERCURY_MARK_WIDTH, MERCURY_MARK_SMALL_WIDTH } from './mercury-mark.js';

const COLORS = IS_LIGHT_TERMINAL
  ? { mark: 'blue', title: 'blue', muted: 'gray', key: 'blue', accent: 'magenta' }
  : { mark: 'cyan', title: 'cyan', muted: 'gray', key: 'cyan', accent: 'magenta' };

/** Milliseconds between mark rows during the draw-in. */
export const MARK_REVEAL_STEP_MS = 24;

export interface LaunchPadCheck {
  label: string;
  value: string;
  /** done = ✓, pending = spinner, info = · (not a readiness gate). */
  status: 'done' | 'pending' | 'info' | 'off';
  /** Paths keep their tail when truncated (the folder name matters most). */
  keepTail?: boolean;
}

/** The status rows, derived only from real state. Exported for tests. */
export function launchPadChecks(state: TuiState, cwd: string = process.cwd()): LaunchPadCheck[] {
  const checks: LaunchPadCheck[] = [];
  checks.push(state.provider
    ? { label: 'Provider', value: `${state.provider.name} · ${state.provider.model}`, status: 'done' }
    : { label: 'Provider', value: 'connecting…', status: 'pending' });
  const skillCount = state.skills.length;
  // Skills are discovered from disk before the TUI mounts, so this is a fact,
  // not a readiness gate.
  checks.push(skillCount > 0
    ? { label: 'Skills', value: skillCount === 1 ? '1 ready' : `${skillCount} ready`, status: 'done' }
    : { label: 'Skills', value: 'none installed', status: 'info' });
  checks.push(state.web?.enabled
    ? { label: 'Web', value: `127.0.0.1:${state.web.port}`, status: 'done' }
    : { label: 'Web', value: 'off', status: 'off' });
  if (state.tokenInfo) {
    checks.push({ label: 'Budget', value: `${state.tokenInfo.used.toLocaleString()} / ${state.tokenInfo.budget.toLocaleString()} today`, status: 'info' });
  }
  checks.push({ label: 'Workspace', value: tildify(cwd), status: 'info', keepTail: true });
  return checks;
}

export function tildify(path: string, home: string = homedir()): string {
  return home && (path === home || path.startsWith(home + '/')) ? '~' + path.slice(home.length) : path;
}

export function isLaunchPadReady(state: TuiState): boolean {
  return state.provider != null;
}

/** Draw-in progress for the mark: rows revealed so far, advancing once. */
function useMarkReveal(total: number): number {
  const [shown, setShown] = React.useState(0);
  React.useEffect(() => {
    if (shown >= total) return;
    const t = setTimeout(() => setShown((n) => Math.min(total, n + 1)), MARK_REVEAL_STEP_MS);
    return () => clearTimeout(t);
  }, [shown, total]);
  return shown;
}

function CheckRow({ check, labelWidth, valueWidth, frame }: { check: LaunchPadCheck; labelWidth: number; valueWidth: number; frame: string }) {
  const glyph = check.status === 'done' ? '✓' : check.status === 'pending' ? frame : '·';
  const glyphColor = check.status === 'done' ? 'green' : check.status === 'pending' ? 'yellow' : COLORS.muted;
  return (
    <Text wrap="truncate-end">
      <Text color={glyphColor}>{glyph}</Text>
      <Text> {check.label.padEnd(labelWidth)}  </Text>
      <Text color={check.status === 'off' ? COLORS.muted : undefined}>{check.keepTail ? fitTail(check.value, valueWidth) : fitText(check.value, valueWidth)}</Text>
    </Text>
  );
}

export interface LaunchPadProps {
  state: TuiState;
  cols: number;
  showDetails: boolean;
  tip?: string | null;
}

export function LaunchPad({ state, cols, showDetails, tip }: LaunchPadProps) {
  const narrow = isNarrow(cols);
  // Hero mark from 80 cols, compact from 60, none below (Termux portrait).
  const mark = narrow ? [] : cols >= 80 ? MERCURY_MARK : MERCURY_MARK_SMALL;
  const markWidth = narrow ? 0 : cols >= 80 ? MERCURY_MARK_WIDTH : MERCURY_MARK_SMALL_WIDTH;
  const revealed = useMarkReveal(mark.length);
  const ready = isLaunchPadReady(state);
  const now = useTick(!ready);
  const frame = spinnerFrame(now);

  const gutter = narrow ? 0 : 5;
  const panelWidth = Math.max(10, cols - 2 - markWidth - gutter);
  const checks = launchPadChecks(state);
  const labelWidth = Math.max(...checks.map((c) => c.label.length));
  const valueWidth = Math.max(4, panelWidth - labelWidth - 4);
  const versionLabel = `v${state.version}`;

  const panel = (
    <Box flexDirection="column" width={narrow ? undefined : panelWidth}>
      <Text wrap="truncate-end">
        {narrow && <Text color={COLORS.mark}>☿ </Text>}
        <Text bold color={COLORS.title}>MERCURY</Text>
        <Text color={COLORS.muted}>  {versionLabel}</Text>
        {isDevBuild(state.version) && <Text color="yellow">  ⚠ development build</Text>}
      </Text>
      <Text color={COLORS.muted} wrap="truncate-end">Your soul-driven AI agent</Text>
      <Text> </Text>
      {checks.map((check) => (
        <CheckRow key={check.label} check={check} labelWidth={labelWidth} valueWidth={valueWidth} frame={frame} />
      ))}
      <Text> </Text>
      {ready ? (
        <Text bold wrap="truncate-end">Type to start chatting</Text>
      ) : (
        <Text color={COLORS.muted} wrap="truncate-end">Starting up — you can already type</Text>
      )}
      <Text wrap="truncate-end">
        <Text color={COLORS.key}>/code</Text><Text color={COLORS.muted}>  Mercury Code here   </Text>
        <Text color={COLORS.key}>Tab</Text><Text color={COLORS.muted}>  {showDetails ? 'hide skills' : 'skills'}</Text>
      </Text>
      {tip ? (
        <>
          <Text> </Text>
          <Text color={COLORS.muted} wrap="truncate-end">tip: {fitText(tip, Math.max(4, panelWidth - 5))}</Text>
        </>
      ) : null}
    </Box>
  );

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1} paddingTop={narrow ? 0 : 1}>
      {narrow ? panel : (
        <Box flexDirection="row">
          <Box flexDirection="column" width={markWidth} marginRight={gutter} flexShrink={0}>
            {mark.map((line, i) => (
              // Unrevealed rows render as blank lines so the layout never jumps.
              <Text key={i} color={COLORS.mark}>{i < revealed ? line : ' '}</Text>
            ))}
          </Box>
          {panel}
        </Box>
      )}
      {showDetails && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={COLORS.muted}>Skills</Text>
          {state.skills.length === 0
            ? <Text color={COLORS.muted}>  none installed — /skills to browse the registry</Text>
            : state.skills.map((skill) => (
              <Text key={skill.name} color={COLORS.muted} wrap="truncate-end">  {skill.name}</Text>
            ))}
        </Box>
      )}
    </Box>
  );
}
