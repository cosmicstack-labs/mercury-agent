import React from 'react';
import { Box, Text, Spacer, useApp, useInput, useStdout } from 'ink';
import type { TuiState } from '../channels/cli.js';
import type { AppMode, ChatMessage, ToolStep, SubAgentInfo, PermissionPromptState, SidebarSection, BackgroundTaskInfo, WorkspaceState } from './types.js';
import type { PermissionMode } from '../channels/base.js';
import type { ProgrammingModeState } from '../core/programming-mode.js';
import { renderMarkdown } from '../utils/markdown.js';
import { PLAYER_CONTROLS, formatNowPlaying } from '../spotify/ui.js';
import type { SpotifyClient } from '../spotify/client.js';
import type { SubAgentStatus } from '../types/agent.js';

const MERCURY_LOGO = [
  '    __  _____________  ________  ________  __',
  '   /  |/  / ____/ __ \\/ ____/ / / / __ \\/ < /',
  '  / /|_/ / __/ / /_/ / /   / / / / /_/ /\\  / ',
  ' / /  / / /___/ _, _/ /___/ /_/ / _, _/ / /  ',
  '/_/  /_/_____/_/ |_|\\____/\\____/_/ |_| /_/   ',
];

const MERCURY_MARK = [
  '        ╭─╮     ╭─╮',
  '      ╭─╯ ╰─────╯ ╰─╮',
  '    ╭─╯               ╰─╮',
  '   │      ●       ●      │',
  '   │          ◡          │',
  '   │                     │',
  '    ╰─╮               ╭─╯',
  '      ╰─────╮   ╭─────╯',
  '            │   │',
  '           ─┼───┼─',
  '            │   │',
];

const IS_LIGHT_BG = (() => {
  const fgBg = process.env.COLORFGBG;
  if (!fgBg) return false;
  const parts = fgBg.split(';');
  const bgCode = Number(parts[parts.length - 1]);
  if (Number.isNaN(bgCode)) return false;
  return bgCode >= 10;
})();

const BRAND = IS_LIGHT_BG
  ? { logo: 'blue', title: 'blue', subtitle: 'gray', accent: 'magenta' }
  : { logo: 'cyan', title: 'cyan', subtitle: 'gray', accent: 'magenta' };

const STATUS_ICONS: Record<string, { icon: string; color: string }> = {
  pending: { icon: '🔵', color: 'blue' },
  running: { icon: '🟢', color: 'green' },
  paused: { icon: '🟡', color: 'yellow' },
  completed: { icon: '✅', color: 'green' },
  failed: { icon: '❌', color: 'red' },
  halted: { icon: '⛔', color: 'red' },
};

function canRenderInlineAlbumArt(): boolean {
  if (process.env.MERCURY_SPOTIFY_ART !== '1') return false;
  if (process.env.CI === 'true') return false;
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY) return false;
  return process.env.TERM_PROGRAM === 'iTerm.app';
}

async function buildItermInlineImage(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Album art fetch failed: ${response.status}`);
  const contentType = response.headers.get('content-type') || 'image/jpeg';
  const data = Buffer.from(await response.arrayBuffer()).toString('base64');
  return `\u001b]1337;File=inline=1;width=24;height=12;preserveAspectRatio=1;type=${contentType}:${data}\u0007`;
}

export interface TuiAppProps {
  state: TuiState;
  onInput: (text: string) => void;
  onPermissionResolve: (value: string | boolean) => void;
  onExit: () => void;
  spotifyClient?: SpotifyClient | null;
}

export function TuiApp({ state, onInput, onPermissionResolve, onExit, spotifyClient }: TuiAppProps) {
  const { exit } = useApp();
  const [input, setInput] = React.useState('');
  const [cursorPos, setCursorPos] = React.useState(0);
  const setInputAndCursor = (text: string, pos?: number) => {
    setInput(text);
    setCursorPos(pos ?? text.length);
  };  const [permIdx, setPermIdx] = React.useState(0);
  const permIdxRef = React.useRef(0);
  const [menuIdx, setMenuIdx] = React.useState(0);
  const [spotifyIdx, setSpotifyIdx] = React.useState(6);
  const [splashPhase, setSplashPhase] = React.useState<'logo' | 'skills' | 'provider' | 'ready'>('logo');
  const [skillsLoaded, setSkillsLoaded] = React.useState(0);
  const [showStartupDetails, setShowStartupDetails] = React.useState(false);
  const [spotifyNow, setSpotifyNow] = React.useState('');
  const [spotifyStatus, setSpotifyStatus] = React.useState('');
  const [spotifyVolume, setSpotifyVolume] = React.useState<number | null>(null);
  const [spotifyArtUrl, setSpotifyArtUrl] = React.useState<string | null>(null);
  const [spotifyArtAnsi, setSpotifyArtAnsi] = React.useState<string>('');
  const albumArtCache = React.useRef<Map<string, string>>(new Map());
  const [inputHistory, setInputHistory] = React.useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = React.useState<number>(-1);
  const [historyDraft, setHistoryDraft] = React.useState<string>('');
  const [workspacePane, setWorkspacePane] = React.useState<'files' | 'details' | 'git'>('files');
  const [detailCursor, setDetailCursor] = React.useState(0);
  const [gitCursor, setGitCursor] = React.useState(0);

  const slashCommands = React.useMemo(() => [
    '/help',
    '/status',
    '/progress',
    '/menu',
    '/chat',
    '/code',
    '/code plan',
    '/code execute',
    '/code build',
    '/code workspace',
    '/code agent ',
    '/code off',
    '/code toggle',
    '/spotify',
    '/budget',
    '/permissions',
    '/memory',
    '/models',
    '/models use ',
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
    '/stream',
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
  ], []);

  const slashSuggestions = React.useMemo(() => {
    if (!input.startsWith('/')) return [];
    const q = input.toLowerCase();
    return slashCommands.filter((cmd) => cmd.startsWith(q)).slice(0, 5);
  }, [input, slashCommands]);

  const [slashSelIdx, setSlashSelIdx] = React.useState(0);

  // Reset selection index when suggestions change
  React.useEffect(() => {
    setSlashSelIdx(0);
  }, [slashSuggestions.length, input]);

  React.useEffect(() => {
    if (state.mode !== 'splash') return;
    if (splashPhase === 'logo') {
      const t = setTimeout(() => setSplashPhase('skills'), 80);
      return () => clearTimeout(t);
    }
  }, [state.mode, splashPhase]);

  React.useEffect(() => {
    if (state.mode !== 'splash') return;
    if (splashPhase === 'skills') {
      if (skillsLoaded >= state.skills.length) {
        const t = setTimeout(() => setSplashPhase('provider'), 60);
        return () => clearTimeout(t);
      }
      const t = setTimeout(() => setSkillsLoaded((i) => i + 1), 20);
      return () => clearTimeout(t);
    }
  }, [state.mode, splashPhase, skillsLoaded, state.skills.length]);

  React.useEffect(() => {
    if (state.mode !== 'splash') return;
    if (splashPhase === 'provider') {
      const t = setTimeout(() => setSplashPhase('ready'), 80);
      return () => clearTimeout(t);
    }
  }, [state.mode, splashPhase]);

  React.useEffect(() => {
    if (state.mode === 'spotify' && spotifyClient) {
      const refresh = async () => {
        try {
          const data = await spotifyClient.getCurrentlyPlaying();
          setSpotifyNow(formatNowPlaying(data));
          setSpotifyVolume(typeof data?.device?.volume_percent === 'number' ? data.device.volume_percent : null);
          setSpotifyArtUrl(data?.item?.album?.images?.[0]?.url || null);
        } catch {
          setSpotifyNow('Nothing playing');
          setSpotifyVolume(null);
          setSpotifyArtUrl(null);
        }
      };
      refresh();
      const interval = setInterval(refresh, 5000);
      return () => clearInterval(interval);
    }
  }, [state.mode, spotifyClient]);

  React.useEffect(() => {
    if (state.mode !== 'spotify') return;
    if (!spotifyArtUrl) {
      setSpotifyArtAnsi('');
      return;
    }
    if (!canRenderInlineAlbumArt()) {
      setSpotifyArtAnsi('');
      return;
    }

    const cached = albumArtCache.current.get(spotifyArtUrl);
    if (cached) {
      setSpotifyArtAnsi(cached);
      return;
    }

    let cancelled = false;
    buildItermInlineImage(spotifyArtUrl)
      .then((ansi) => {
        if (cancelled) return;
        albumArtCache.current.set(spotifyArtUrl, ansi);
        setSpotifyArtAnsi(ansi);
      })
      .catch(() => {
        if (cancelled) return;
        setSpotifyArtAnsi('');
      });

    return () => {
      cancelled = true;
    };
  }, [state.mode, spotifyArtUrl]);

  const runSpotifyAction = React.useCallback(async (action: string) => {
    if (!spotifyClient || action === 'exit') return;
    try {
      if (action === 'volume_up') {
        const current = typeof spotifyVolume === 'number' ? spotifyVolume : 50;
        const next = Math.min(100, current + 10);
        const result = await spotifyClient.setVolume(next);
        setSpotifyStatus(result);
      } else if (action === 'volume_down') {
        const current = typeof spotifyVolume === 'number' ? spotifyVolume : 50;
        const next = Math.max(0, current - 10);
        const result = await spotifyClient.setVolume(next);
        setSpotifyStatus(result);
      } else {
        const { handlePlayerAction } = await import('../spotify/ui.js');
        const result = await handlePlayerAction(action, spotifyClient);
        setSpotifyStatus(result);
      }

      const data = await spotifyClient.getCurrentlyPlaying();
      setSpotifyNow(formatNowPlaying(data));
      setSpotifyVolume(typeof data?.device?.volume_percent === 'number' ? data.device.volume_percent : null);
      setSpotifyArtUrl(data?.item?.album?.images?.[0]?.url || null);
    } catch (err: any) {
      setSpotifyStatus(err?.message || 'Spotify action failed');
    }
  }, [spotifyClient, spotifyVolume]);

  React.useEffect(() => {
    if (state.permissionPrompt) {
      setPermIdx(0);
      permIdxRef.current = 0;
    }
  }, [state.permissionPrompt]);

  useInput((ch, key) => {
    const keyChar = (ch || (key as any)?.name || '').toLowerCase();
    const isEnter = key.return || (key as any)?.name === 'enter';
    const resolvePermissionAndMaybeContinue = (value: string | boolean) => {
      const shouldAutoEnterChat = state.mode === 'splash' && state.permissionPrompt?.type === 'mode';
      onPermissionResolve(value);
      if (shouldAutoEnterChat) {
        onInput('/chat');
      }
    };

    if (ch === '\u0003' || (key.ctrl && ((key as any).name === 'c' || ch?.toLowerCase?.() === 'c'))) {
      onExit();
      return;
    }

    if (state.mode === 'splash') {
      if (ch === 'd' || ch === 'D') {
        setShowStartupDetails((v) => !v);
        return;
      }
      if (!state.permissionPrompt && isEnter) {
        onInput('/chat');
        return;
      }
    }

    if (state.permissionPrompt) {
      const options = state.permissionPrompt.options || [];
      if (options.length > 0) {
        const lower = ch?.toLowerCase?.();
        if (lower === 'y') {
          const yes = options.find((opt) => opt.value === 'yes');
          if (yes) {
            resolvePermissionAndMaybeContinue(yes.value);
            return;
          }
        }
        if (lower === 'n') {
          const no = options.find((opt) => opt.value === 'no');
          if (no) {
            resolvePermissionAndMaybeContinue(no.value);
            return;
          }
        }
        if (lower === 'a') {
          const always = options.find((opt) => opt.value === 'always');
          if (always) {
            resolvePermissionAndMaybeContinue(always.value);
            return;
          }
        }

        if (key.upArrow) {
          const next = Math.max(0, permIdxRef.current - 1);
          permIdxRef.current = next;
          setPermIdx(next);
        }
        else if (key.downArrow) {
          const next = Math.min(options.length - 1, permIdxRef.current + 1);
          permIdxRef.current = next;
          setPermIdx(next);
        }
        else if (isEnter) {
          const selected = options[permIdxRef.current] || options[0];
          if (selected) resolvePermissionAndMaybeContinue(selected.value);
        } else if (key.escape) {
          resolvePermissionAndMaybeContinue(state.permissionPrompt.type === 'mode' ? 'ask-me' : 'no');
        }
        return;
      }

      if (state.permissionPrompt.type === 'continue') {
        if (ch === 'y' || ch === 'Y') resolvePermissionAndMaybeContinue(true);
        else if (ch === 'n' || ch === 'N') resolvePermissionAndMaybeContinue(false);
        return;
      }
      if (state.permissionPrompt.type === 'ask') {
        if (isEnter) resolvePermissionAndMaybeContinue('');
        return;
      }
      return;
    }

    if (state.mode === 'menu') {
      if (key.upArrow) setMenuIdx((i) => Math.max(0, i - 1));
      else if (key.downArrow) setMenuIdx((i) => Math.min(5, i + 1));
      else if (key.return) {
        const modes: AppMode[] = ['menu', 'coding', 'chat', 'spotify', 'chat', 'chat'];
        onInput('/' + modes[menuIdx]);
        setMenuIdx(0);
      }
      else if (key.escape) onInput('/chat');
      return;
    }

    if (state.mode === 'spotify') {
      if (ch === 'n' || ch === 'N') {
        runSpotifyAction('next');
        return;
      }
      if (ch === 'p' || ch === 'P') {
        runSpotifyAction('prev');
        return;
      }
      if (ch === ' ') {
        runSpotifyAction('play');
        return;
      }
      if (ch === '+' || ch === '=') {
        runSpotifyAction('volume_up');
        return;
      }
      if (ch === '-') {
        runSpotifyAction('volume_down');
        return;
      }
      if (ch === 'z' || ch === 'Z') {
        runSpotifyAction('now');
        return;
      }

      if (key.upArrow) setSpotifyIdx((i) => Math.max(0, i - 1));
      else if (key.downArrow) setSpotifyIdx((i) => Math.min(PLAYER_CONTROLS.length - 1, i + 1));
      else if (key.return) {
        const action = PLAYER_CONTROLS[spotifyIdx];
        if (action && action.value !== 'exit') runSpotifyAction(action.value);
        if (action?.value === 'exit') onInput('/chat');
      } else if (key.escape) onInput('/chat');
      return;
    }

    if (isEnter) {
      const trimmed = input.trim();

      // If autocomplete popup is showing and input doesn't exactly match the selected suggestion,
      // fill the suggestion into the input instead of submitting
      if (slashSuggestions.length > 0 && trimmed !== slashSuggestions[slashSelIdx]) {
        setInputAndCursor(slashSuggestions[slashSelIdx]);
        return;
      }

      if (trimmed) {
        onInput(trimmed);
        setInputHistory((prev) => {
          if (prev[prev.length - 1] === trimmed) return prev;
          return [...prev.slice(-99), trimmed];
        });
        setHistoryIndex(-1);
        setHistoryDraft('');
        setInputAndCursor('');
        return;
      }
    }

    if (state.mode === 'workspace') {
      const focusArea = state.workspace?.focusArea || 'explorer';
      const rightPanel = state.workspace?.rightPanel || 'chat';

      // Global workspace shortcuts (always active)
      if (key.escape || (key.ctrl && (ch === 'q' || ch === 'Q'))) {
        // Esc in non-explorer panel returns to explorer; Esc in explorer exits workspace
        if (focusArea !== 'explorer') {
          onInput('/ws focus explorer');
        } else {
          onInput('/ws exit');
        }
        return;
      }

      if (key.ctrl && (ch === 'p' || ch === 'P')) {
        onInput('/code plan');
        return;
      }
      if (key.ctrl && (ch === 'x' || ch === 'X')) {
        onInput('/code execute');
        return;
      }

      // Panel focus shortcuts
      if (key.ctrl && (ch === 'e' || ch === 'E')) {
        onInput('/ws focus explorer');
        return;
      }
      if (key.ctrl && (ch === 'g' || ch === 'G')) {
        onInput('/ws focus git');
        return;
      }
      if (key.ctrl && (ch === 'j' || ch === 'J')) {
        onInput('/ws toggle-chat');
        return;
      }

      // Tab cycles focus: explorer → code → right panel (chat or git)
      if (key.tab) {
        const showRight = (process.stdout.columns || 80) >= 100;
        const rightFocus = rightPanel === 'chat' ? 'chat' : 'git';
        const cycle = showRight ? ['explorer', 'code', rightFocus] : ['explorer', 'code'];
        const nextIdx = (cycle.indexOf(focusArea) + 1) % cycle.length;
        onInput(`/ws focus ${cycle[nextIdx]}`);
        return;
      }

      const navMode = input.trim().length === 0;

      // Focus-aware navigation
      if (navMode) {
        if (focusArea === 'explorer') {
          if (key.upArrow) { onInput('/ws up'); return; }
          if (key.downArrow) { onInput('/ws down'); return; }
          if (key.leftArrow) { onInput('/ws collapse'); return; }
          if (key.rightArrow) { onInput('/ws expand'); return; }
          if (isEnter) { onInput('/ws open-selected'); return; }
        }

        if (focusArea === 'code') {
          if (key.upArrow) { onInput('/ws scroll -1'); return; }
          if (key.downArrow) { onInput('/ws scroll 1'); return; }
          if (key.pageUp) { onInput('/ws scroll -15'); return; }
          if (key.pageDown) { onInput('/ws scroll 15'); return; }
          if (key.ctrl && (ch === 'u' || ch === 'U')) { onInput('/ws scroll -10'); return; }
          if (key.ctrl && (ch === 'd' || ch === 'D')) { onInput('/ws scroll 10'); return; }
        }

        if (focusArea === 'git') {
          if (key.upArrow) { setGitCursor((i) => Math.max(0, i - 1)); return; }
          if (key.downArrow) { setGitCursor((i) => Math.min((state.workspace?.gitFiles.length || 1) - 1, i + 1)); return; }
          if (isEnter) {
            const picked = state.workspace?.gitFiles[gitCursor];
            if (picked) onInput(`/ws stage ${picked.path}`);
            return;
          }
        }

        if (focusArea === 'chat') {
          if (key.upArrow) { onInput('/ws chat-scroll -1'); return; }
          if (key.downArrow) { onInput('/ws chat-scroll 1'); return; }
          if (key.pageUp) { onInput('/ws chat-scroll -10'); return; }
          if (key.pageDown) { onInput('/ws chat-scroll 10'); return; }
          if (key.ctrl && (ch === 'u' || ch === 'U')) { onInput('/ws chat-scroll -8'); return; }
          if (key.ctrl && (ch === 'd' || ch === 'D')) { onInput('/ws chat-scroll 8'); return; }
        }
      }
    }

    if (state.mode === 'splash') return;

    if ((state.mode === 'coding' || state.mode === 'workspace') && !state.permissionPrompt) {
      if (key.ctrl && (ch === 'p' || ch === 'P')) {
        onInput('/code plan');
        return;
      }
      if (key.ctrl && (ch === 'x' || ch === 'X')) {
        onInput('/code execute');
        return;
      }
    }

    if (key.ctrl && (ch === 't' || ch === 'T') && !state.permissionPrompt) {
      onInput('/view toggle');
      return;
    }

    if (key.ctrl && (ch === 'b' || ch === 'B') && !state.permissionPrompt) {
      onInput(state.isThinking ? '/bg current' : '/bg list');
      return;
    }

    // Ctrl+N → insert newline (multi-line input)
    if (key.ctrl && (ch === 'n' || ch === 'N' || ch === '\x0e')) {
      setInput((prev) => prev.slice(0, cursorPos) + '\n' + prev.slice(cursorPos));
      setCursorPos((p) => p + 1);
      return;
    }

    if (key.escape) {
      if (state.mode === 'coding') {
        onInput('/chat');
      }
      return;
    }

    if (isEnter) return;

    if (key.tab) {
      if (input.startsWith('/') && slashSuggestions.length > 0) {
        setInputAndCursor(slashSuggestions[slashSelIdx]);
      }
      return;
    }

    // Left/right arrow: move cursor within input
    if (key.leftArrow) {
      setCursorPos((p) => Math.max(0, p - 1));
      return;
    }
    if (key.rightArrow) {
      setCursorPos((p) => Math.min(input.length, p + 1));
      return;
    }

    // Up/down arrow: navigate slash suggestions when popup is visible
    if (slashSuggestions.length > 0) {
      if (key.upArrow) {
        setSlashSelIdx((i) => (i > 0 ? i - 1 : slashSuggestions.length - 1));
        return;
      }
      if (key.downArrow) {
        setSlashSelIdx((i) => (i < slashSuggestions.length - 1 ? i + 1 : 0));
        return;
      }
    }

    // Up arrow: navigate input history
    if (key.upArrow) {
      if (inputHistory.length === 0) return;
      if (historyIndex === -1) {
        setHistoryDraft(input);
        const next = inputHistory.length - 1;
        setHistoryIndex(next);
        setInputAndCursor(inputHistory[next] ?? '');
        return;
      }
      const next = Math.max(0, historyIndex - 1);
      setHistoryIndex(next);
      setInputAndCursor(inputHistory[next] ?? '');
      return;
    }

    if (key.downArrow) {
      if (historyIndex === -1) return;
      const next = historyIndex + 1;
      if (next >= inputHistory.length) {
        setHistoryIndex(-1);
        setInputAndCursor(historyDraft);
        return;
      }
      setHistoryIndex(next);
      setInputAndCursor(inputHistory[next] ?? '');
      return;
    }

    if (key.backspace || key.delete) {
      if (cursorPos > 0) {
        setInput((prev) => prev.slice(0, cursorPos - 1) + prev.slice(cursorPos));
        setCursorPos((p) => p - 1);
      }
      return;
    }

    if (key.ctrl || key.meta) return;

    if (ch && ch.length > 0 && !key.escape) {
      // Strip control chars but keep printable content (handles paste)
      const clean = ch.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
      if (clean) {
        setInput((prev) => prev.slice(0, cursorPos) + clean + prev.slice(cursorPos));
        setCursorPos((p) => p + clean.length);
      }
    }
  });

  if (state.mode === 'splash') {
    return (
      <Box flexDirection="column" flexGrow={1}>
        <Box flexDirection="row" flexGrow={1} paddingX={1}>
          <Box flexDirection="column" width={34} paddingRight={2}>
            {MERCURY_MARK.map((line, i) => (
              <Text key={i} color={BRAND.logo}>{line}</Text>
            ))}
            <Text bold color={BRAND.title}>MERCURY</Text>
            <Text color={BRAND.subtitle}>Your soul-driven AI agent</Text>
            <Text color="gray">{'─'.repeat(30)}</Text>
            <Text color="green">● Core {splashPhase === 'ready' ? 'ready' : 'booting'}</Text>
            <Text color={state.provider ? 'green' : 'yellow'}>{state.provider ? '●' : '◐'} Provider {state.provider ? 'ready' : 'loading'}</Text>
            <Text color={skillsLoaded >= state.skills.length ? 'green' : 'yellow'}>{skillsLoaded >= state.skills.length ? '●' : '◐'} Skills {skillsLoaded}/{state.skills.length}</Text>
            <Text color="gray">{'─'.repeat(30)}</Text>
            <Text dimColor>Press Enter to open chat</Text>
            <Text dimColor>Press D for startup details</Text>
          </Box>
          <Box flexDirection="column" flexGrow={1}>
            <Text bold color="white">Session</Text>
            <Text color="gray">{'─'.repeat(56)}</Text>
            <Text>Version: <Text color="cyan">{state.version}</Text></Text>
            <Text>Provider: <Text color={BRAND.accent}>{state.provider ? `${state.provider.name} · ${state.provider.model}` : 'Detecting...'}</Text></Text>
            <Text>Mode: <Text color="yellow">Startup</Text></Text>
            {state.tokenInfo && (
              <Text>Budget: <Text color="green">{state.tokenInfo.used.toLocaleString()}/{state.tokenInfo.budget.toLocaleString()} ({state.tokenInfo.percentage}%)</Text></Text>
            )}
            <Text color="gray">{'─'.repeat(56)}</Text>
            <Text bold color="white">Capabilities</Text>
            <Text>Skills loaded: <Text color="cyan">{skillsLoaded}</Text> / {state.skills.length}</Text>
            {showStartupDetails ? (
              <Box flexDirection="column" marginTop={1}>
                {state.skills.slice(0, skillsLoaded).map((skill, i) => (
                  <Text key={i} dimColor>- {skill.name}</Text>
                ))}
              </Box>
            ) : (
              <Text dimColor>Details hidden (press D)</Text>
            )}
            <Text color="gray">{'─'.repeat(56)}</Text>
            <Text>{splashPhase === 'ready' ? 'Mercury is live.' : 'Initializing Mercury...'}</Text>
            {splashPhase === 'ready' && <Text color="green">Ready. Enter to open chat.</Text>}
            {!state.provider && <Text color="yellow">Waiting for provider handshake...</Text>}
            {state.provider && <Text color="green">Provider connected.</Text>}
          </Box>
        </Box>
        {state.permissionPrompt && (
          <PermPromptView prompt={state.permissionPrompt} activeIdx={permIdx} />
        )}
      </Box>
    );
  }

  const showInput = !state.permissionPrompt && (state.mode === 'chat' || state.mode === 'coding' || state.mode === 'workspace');

  return (
    <Box flexDirection="column" flexGrow={1}>
      <StatusBarView state={state} />
      {state.backgroundTasks.length > 0 && <BackgroundBarView tasks={state.backgroundTasks} />}
      {state.mode === 'spotify' ? <SpotifyBody activeIdx={spotifyIdx} nowPlaying={spotifyNow} status={spotifyStatus} volume={spotifyVolume} albumArtAnsi={spotifyArtAnsi} /> : null}
      {state.mode === 'menu' ? <MenuBody menuIdx={menuIdx} /> : null}
      {state.mode === 'coding' ? <CodingBody state={state} /> : null}
      {(state.mode === 'workspace' || state.mode === 'chat') ? (
        <ChatBody state={state} />
      ) : null}
      {state.permissionPrompt && (
        <PermPromptView prompt={state.permissionPrompt} activeIdx={permIdx} />
      )}
      {showInput && (
        <InputBox
          input={input}
          cursorPos={cursorPos}
          mode={state.mode}
          programmingMode={state.programmingMode}
          projectContext={state.projectContext}
        />
      )}
      {showInput && slashSuggestions.length > 0 && (
        <Box flexDirection="column" paddingX={1}>
          <Text dimColor>Suggestions (↑↓ navigate · Tab/Enter to select):</Text>
          {slashSuggestions.map((cmd, idx) => (
            <Text key={cmd} color={idx === slashSelIdx ? 'cyan' : 'gray'}>{idx === slashSelIdx ? '›' : ' '} {cmd}</Text>
          ))}
        </Box>
      )}
    </Box>
  );
}

function BackgroundBarView({ tasks }: { tasks: BackgroundTaskInfo[] }) {
  if (tasks.length === 0) return null;

  const statusIcons: Record<string, string> = {
    running: '⏳',
    completed: '✅',
    failed: '❌',
    timed_out: '⏱',
    cancelled: '⛔',
  };

  const visible = tasks.slice(0, 3);
  const more = tasks.length > 3 ? ` +${tasks.length - 3} more` : '';

  return (
    <Box paddingX={1} paddingBottom={0}>
      <Text color="gray">{'─'.repeat(50)}</Text>
      <Box flexDirection="column" width="100%">
        <Box>
          <Text dimColor>⏥ Background:</Text>
          <Text> {visible.map((t) => {
            const icon = statusIcons[t.status] || '·';
            const label = t.command || t.task || t.id;
            const short = label.length > 25 ? label.slice(0, 22) + '...' : label;
            const elapsed = t.runningMs ? ` (${Math.round(t.runningMs / 1000)}s)` : '';
            return `${icon} ${t.id}: ${short}${elapsed}`;
          }).join(' · ')}{more}</Text>
        </Box>
      </Box>
    </Box>
  );
}

function StatusBarView({ state }: { state: TuiState }) {
  const modeColor = state.programmingMode === 'execute' ? 'green' : state.programmingMode === 'plan' ? 'yellow' : 'gray';
  const modeLabel = state.programmingMode === 'off' ? '' : ` ${state.programmingMode.toUpperCase()}`;
  let tokenBar = '';
  if (state.tokenInfo) {
    const filled = Math.min(20, Math.round(state.tokenInfo.percentage / 5));
    tokenBar = `[${'█'.repeat(filled)}${'░'.repeat(20 - filled)}] ${state.tokenInfo.percentage}%`;
  }
  const providerBadge = state.provider ? `⚡ ${state.provider.name} · ${state.provider.model}` : '⚡ No provider';
  const viewLabel = state.viewMode === 'balanced' ? 'minimal' : 'detailed';

  // Dynamic subtitle based on thinking state
  const runningStep = [...state.toolSteps].reverse().find((s) => s.status === 'running');
  const doneSteps = state.toolSteps.filter((s) => s.status === 'done').length;
  let subtitle: React.ReactNode;
  if (state.isThinking) {
    const activity = runningStep ? runningStep.label : 'Processing';
    const stepCount = doneSteps > 0 ? `step ${doneSteps + 1}` : 'step 1';
    subtitle = <Text color="green">● {stepCount} · {activity}</Text>;
  } else {
    subtitle = <Text color={BRAND.subtitle}> · Your soul-driven AI agent</Text>;
  }

  return (
    <Box flexDirection="column">
      <Box paddingX={1}>
        <Text color={BRAND.logo}>☿</Text>
        <Text> </Text>
        <Text bold color={BRAND.title}>MERCURY</Text>
        {subtitle}
      </Box>
      <Box paddingX={1} paddingBottom={0}>
        <Box flexGrow={1}>
          <Text bold color="cyan">{state.agentName}</Text>
          {state.programmingMode !== 'off' && <Text> <Text color={modeColor} bold>{modeLabel}</Text></Text>}
          {state.projectContext && <Text> <Text color="gray">|</Text> <Text color="blue">{state.projectContext}</Text></Text>}
          <Text> <Text color="gray">|</Text> <Text color="yellow">View: {viewLabel}</Text></Text>
          <Text> <Text color="gray">|</Text> <Text color="green">{state.permissionMode === 'allow-all' ? '🔓' : '🔒'}</Text></Text>
        </Box>
        <Text color="magenta">{providerBadge}</Text>
      </Box>
      <Box paddingX={1}>
        <Text color="gray">{'─'.repeat(50)}</Text>
      </Box>
      {state.tokenInfo && (
        <Box paddingX={1}>
          <Text color="cyan">Tokens </Text>
          <Text>{tokenBar}</Text>
          <Text color="gray"> {state.tokenInfo.used.toLocaleString()}/{state.tokenInfo.budget.toLocaleString()}</Text>
        </Box>
      )}
    </Box>
  );
}

function ChatBody({ state }: { state: TuiState }) {
  return (
    <Box flexDirection="row" flexGrow={1}>
      {state.sidebarSections.length > 0 && <SidebarView sections={state.sidebarSections} />}
      <Box flexDirection="column" flexGrow={1}>
        <ChatMessagesView messages={state.chatMessages} agentName={state.agentName} />
        {state.toolSteps.length > 0 && !state.isThinking && <ToolStepsView steps={state.toolSteps} viewMode={state.viewMode} />}
        {state.isThinking && <ThinkingIndicator agentName={state.agentName} steps={state.toolSteps} mode={state.mode} />}
        {state.subAgents.length > 0 && <AgentPanelView agents={state.subAgents} />}
      </Box>
    </Box>
  );
}

function CodingBody({ state }: { state: TuiState }) {
  const modeLabels: Record<ProgrammingModeState, { label: string; color: string }> = {
    off: { label: 'OFF', color: 'gray' },
    plan: { label: 'PLAN', color: 'yellow' },
    execute: { label: 'EXECUTE', color: 'green' },
  };
  const modeInfo = modeLabels[state.programmingMode];
  const fileSection = state.sidebarSections.find((s) => s.title === 'Files');

  return (
    <Box flexDirection="row" flexGrow={1}>
      <Box flexDirection="column" width={26} paddingX={1}>
        <Text color="gray">{'─'.repeat(24)}</Text>
        <Text bold color="cyan">Workspace</Text>
        <Box marginTop={1}>
          <Text color={modeInfo.color} bold>{modeInfo.label}</Text>
          <Text> mode</Text>
        </Box>
        {state.projectContext && <Box><Text dimColor>Project: {state.projectContext}</Text></Box>}
        {fileSection && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold color="cyan">{fileSection.title}</Text>
            {fileSection.items.slice(0, 10).map((item, i) => (
              <Box key={i}><Text>{item.icon} </Text><Text color={item.active ? 'white' : 'gray'}>{item.label}</Text></Box>
            ))}
          </Box>
        )}
        {state.subAgents.length > 0 && <AgentPanelView agents={state.subAgents} />}
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        <ChatMessagesView messages={state.chatMessages} agentName={state.agentName} />
        {state.toolSteps.length > 0 && !state.isThinking && <ToolStepsView steps={state.toolSteps} viewMode={state.viewMode} />}
        {state.isThinking && <ThinkingIndicator agentName={state.agentName} steps={state.toolSteps} mode={state.mode} />}
        <Box paddingX={1} marginTop={1}>
          <Text dimColor>Mode shortcuts: Ctrl+P Plan · Ctrl+X Execute</Text>
        </Box>
      </Box>
    </Box>
  );
}

// ─── Workspace IDE ──────────────────────────────────────────────────────────

function useTerminalSize(): { rows: number; cols: number } {
  const { stdout } = useStdout();
  const [size, setSize] = React.useState({ rows: stdout.rows || 24, cols: stdout.columns || 80 });
  React.useEffect(() => {
    const onResize = () => setSize({ rows: stdout.rows || 24, cols: stdout.columns || 80 });
    stdout.on('resize', onResize);
    return () => { stdout.off('resize', onResize); };
  }, [stdout]);
  return size;
}

function WorkspaceTabBar({ ws, focusArea, cols }: { ws: WorkspaceState; focusArea: string; cols: number }) {
  const showRightPanel = cols >= 100;
  const rightLabel = ws.rightPanel === 'chat' ? 'AGENT OUTPUT' : 'SOURCE CONTROL';
  const rightFocus = ws.rightPanel === 'chat' ? 'chat' : 'git';
  const tabs: Array<{ id: string; label: string }> = [
    { id: 'explorer', label: 'EXPLORER' },
    { id: 'code', label: 'CODE' },
    ...(showRightPanel ? [{ id: rightFocus, label: rightLabel }] : []),
  ];

  return (
    <Box paddingX={1}>
      {tabs.map((tab, i) => (
        <React.Fragment key={tab.id}>
          {i > 0 && <Text color="gray"> │ </Text>}
          <Text
            bold={focusArea === tab.id}
            inverse={focusArea === tab.id}
            color={focusArea === tab.id ? 'cyan' : 'gray'}
          >
            {' '}{tab.label}{' '}
          </Text>
        </React.Fragment>
      ))}
      <Spacer />
      {showRightPanel && (
        <>
          <Text dimColor>^J {ws.rightPanel === 'chat' ? 'git' : 'chat'}</Text>
          <Text color="gray"> · </Text>
        </>
      )}
      <Text color="magenta">{ws.branch}</Text>
    </Box>
  );
}

function ExplorerPanel({
  ws,
  panelHeight,
  isFocused,
}: {
  ws: WorkspaceState;
  panelHeight: number;
  isFocused: boolean;
}) {
  const windowSize = Math.max(1, panelHeight - 2); // leave room for header + footer
  const explorerStart = Math.max(0, Math.min(ws.selectedIndex - Math.floor(windowSize / 2), Math.max(0, ws.nodes.length - windowSize)));
  const visible = ws.nodes.slice(explorerStart, explorerStart + windowSize);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={isFocused ? 'cyan' : 'gray'}
      overflow="hidden"
      height={panelHeight}
    >
      <Box paddingX={1}>
        <Text bold={isFocused} color={isFocused ? 'cyan' : 'gray'}>EXPLORER</Text>
        <Spacer />
        <Text dimColor>{ws.nodes.length}</Text>
      </Box>
      {visible.map((node, localIdx) => {
        const idx = explorerStart + localIdx;
        const isSelected = idx === ws.selectedIndex;
        const prefix = node.isDir ? (node.expanded ? '▾' : '▸') : ' ';
        const indent = ' '.repeat(Math.max(0, node.depth * 2));
        return (
          <Box key={node.id} paddingX={1}>
            <Text
              inverse={isSelected && isFocused}
              color={isSelected ? 'white' : node.isDir ? 'blue' : 'gray'}
              wrap="truncate-end"
            >
              {isSelected ? '›' : ' '} {indent}{prefix} {node.name}
            </Text>
          </Box>
        );
      })}
      {visible.length < windowSize && Array.from({ length: windowSize - visible.length }, (_, i) => (
        <Box key={`pad-${i}`}><Text> </Text></Box>
      ))}
    </Box>
  );
}

function CodeViewerPanel({
  ws,
  panelHeight,
  isFocused,
}: {
  ws: WorkspaceState;
  panelHeight: number;
  isFocused: boolean;
}) {
  const viewerLines = Math.max(1, panelHeight - 3); // header + separator + footer
  const preview = ws.openedFilePreview;
  const offset = ws.codeScrollOffset;
  const totalLines = preview.length;
  const visibleLines = preview.slice(offset, offset + viewerLines);
  const lineNumWidth = Math.max(3, String(offset + viewerLines).length);
  const fileName = ws.openedFilePath
    ? ws.openedFilePath.replace(ws.rootPath + '/', '')
    : '';

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={isFocused ? 'cyan' : 'gray'}
      overflow="hidden"
      height={panelHeight}
    >
      <Box paddingX={1}>
        <Text bold={isFocused} color={isFocused ? 'cyan' : 'gray'}>CODE</Text>
        {fileName ? (
          <>
            <Text color="gray"> · </Text>
            <Text color="white" wrap="truncate-end">{fileName}</Text>
          </>
        ) : null}
        <Spacer />
        {totalLines > 0 && (
          <Text dimColor>{offset + 1}-{Math.min(offset + viewerLines, totalLines)}/{totalLines}</Text>
        )}
      </Box>
      {!ws.openedFilePath ? (
        <Box flexDirection="column" flexGrow={1} alignItems="center" justifyContent="center">
          <Text dimColor>Select a file and press Enter</Text>
          <Text dimColor>to preview its contents</Text>
        </Box>
      ) : (
        <>
          {visibleLines.map((line, i) => {
            const lineNum = offset + i + 1;
            return (
              <Box key={`L${lineNum}`} paddingLeft={1}>
                <Text color="gray">{String(lineNum).padStart(lineNumWidth, ' ')} │ </Text>
                <Text wrap="truncate-end">{line || ' '}</Text>
              </Box>
            );
          })}
          {visibleLines.length < viewerLines && Array.from({ length: viewerLines - visibleLines.length }, (_, i) => (
            <Box key={`cpad-${i}`} paddingLeft={1}>
              <Text color="gray">{' '.repeat(lineNumWidth)} │</Text>
            </Box>
          ))}
        </>
      )}
      <Box paddingX={1}>
        <Text dimColor>
          {isFocused ? '↑↓ scroll · PgUp/PgDn half page · Esc back' : 'Tab to focus'}
        </Text>
      </Box>
    </Box>
  );
}

function GitPanel({
  ws,
  panelHeight,
  isFocused,
  gitCursor,
}: {
  ws: WorkspaceState;
  panelHeight: number;
  isFocused: boolean;
  gitCursor: number;
}) {
  const listHeight = Math.max(1, panelHeight - 6); // header + branch + staged/unstaged labels + footer + border
  const gitStart = Math.max(0, Math.min(gitCursor - Math.floor(listHeight / 2), Math.max(0, ws.gitFiles.length - listHeight)));
  const visible = ws.gitFiles.slice(gitStart, gitStart + listHeight);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={isFocused ? 'cyan' : 'gray'}
      overflow="hidden"
      height={panelHeight}
    >
      <Box paddingX={1}>
        <Text bold={isFocused} color={isFocused ? 'cyan' : 'gray'}>GIT</Text>
        <Spacer />
        <Text color="magenta">{ws.branch}</Text>
      </Box>
      <Box paddingX={1}>
        <Text color="green">● {ws.stagedCount} staged</Text>
        <Text color="gray"> · </Text>
        <Text color="yellow">○ {ws.unstagedCount} unstaged</Text>
      </Box>
      {visible.length === 0 ? (
        <Box paddingX={1}><Text dimColor>Clean working tree</Text></Box>
      ) : (
        visible.map((f, localIdx) => {
          const idx = gitStart + localIdx;
          const isSelected = idx === gitCursor;
          return (
            <Box key={f.path} paddingX={1}>
              <Text
                inverse={isSelected && isFocused}
                color={isSelected ? 'white' : f.staged ? 'green' : 'yellow'}
                wrap="truncate-end"
              >
                {isSelected ? '›' : ' '} {f.staged ? '●' : '○'} {f.status} {f.path}
              </Text>
            </Box>
          );
        })
      )}
      {visible.length < listHeight && Array.from({ length: listHeight - visible.length }, (_, i) => (
        <Box key={`gpad-${i}`}><Text> </Text></Box>
      ))}
      <Box paddingX={1}>
        <Text dimColor>{isFocused ? 'Enter stage/unstage · /ws commit <msg>' : 'Tab to focus'}</Text>
      </Box>
    </Box>
  );
}

function AgentOutputPanel({
  state,
  panelHeight,
  isFocused,
  scrollOffset,
}: {
  state: TuiState;
  panelHeight: number;
  isFocused: boolean;
  scrollOffset: number;
}) {
  const viewLines = Math.max(1, panelHeight - 4); // header + thinking + footer + border

  // Build a flat array of rendered lines from messages
  const allLines: Array<{ key: string; node: React.ReactNode }> = [];

  for (const msg of state.chatMessages) {
    const roleColor = msg.role === 'user' ? 'yellow' : msg.role === 'system' ? 'gray' : 'cyan';
    const prefix = msg.role === 'user' ? 'You' : msg.role === 'system' ? 'Sys' : state.agentName;
    const contentLines = msg.content.split('\n');

    // First line with role prefix
    allLines.push({
      key: `${msg.id}-0`,
      node: (
        <Box>
          <Text color={roleColor} bold>{prefix}: </Text>
          <Text wrap="truncate-end">{contentLines[0] || ''}</Text>
        </Box>
      ),
    });

    // Remaining lines indented
    for (let i = 1; i < contentLines.length; i++) {
      allLines.push({
        key: `${msg.id}-${i}`,
        node: (
          <Box>
            <Text> </Text>
            <Text wrap="truncate-end" dimColor={msg.role === 'system'}>{contentLines[i]}</Text>
          </Box>
        ),
      });
    }

    // Separator between messages
    allLines.push({
      key: `${msg.id}-sep`,
      node: <Text dimColor>{'─'.repeat(3)}</Text>,
    });
  }

  // Auto-scroll to bottom if no manual offset, or use scrollOffset
  const totalLines = allLines.length;
  const effectiveOffset = scrollOffset === 0
    ? Math.max(0, totalLines - viewLines) // auto-scroll to bottom
    : Math.max(0, Math.min(scrollOffset, totalLines - viewLines));

  const visibleLines = allLines.slice(effectiveOffset, effectiveOffset + viewLines);
  const hiddenAbove = effectiveOffset;
  const hiddenBelow = Math.max(0, totalLines - effectiveOffset - viewLines);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={isFocused ? 'cyan' : 'gray'}
      overflow="hidden"
      height={panelHeight}
    >
      <Box paddingX={1}>
        <Text bold={isFocused} color={isFocused ? 'cyan' : 'gray'}>AGENT OUTPUT</Text>
        <Spacer />
        <Text dimColor>{state.chatMessages.length} msg{state.chatMessages.length !== 1 ? 's' : ''}</Text>
      </Box>
      {hiddenAbove > 0 && (
        <Box paddingX={1}><Text dimColor>↑ {hiddenAbove} line{hiddenAbove !== 1 ? 's' : ''} above</Text></Box>
      )}
      {visibleLines.length === 0 ? (
        <Box flexDirection="column" flexGrow={1} alignItems="center" justifyContent="center">
          <Text dimColor>No messages yet.</Text>
          <Text dimColor>Type below to chat.</Text>
        </Box>
      ) : (
        visibleLines.map((line) => (
          <Box key={line.key} paddingX={1}>{line.node}</Box>
        ))
      )}
      {/* Fill remaining space */}
      {visibleLines.length > 0 && visibleLines.length < viewLines - (hiddenAbove > 0 ? 1 : 0) && (
        Array.from({ length: viewLines - visibleLines.length - (hiddenAbove > 0 ? 1 : 0) }, (_, i) => (
          <Box key={`apad-${i}`}><Text> </Text></Box>
        ))
      )}
      {state.isThinking && (
        <Box paddingX={1}>
          <Text color="cyan">⠋ </Text>
          <Text color="cyan" bold>{state.agentName}</Text>
          <Text dimColor> · </Text>
          <Text wrap="truncate-end">{(() => {
            const running = [...state.toolSteps].reverse().find((s) => s.status === 'running');
            return running ? running.label : 'Thinking...';
          })()}</Text>
        </Box>
      )}
      <Box paddingX={1}>
        <Text dimColor>{isFocused ? '↑↓ scroll · Ctrl+G git · Esc back' : 'Ctrl+J focus'}</Text>
      </Box>
    </Box>
  );
}

function WorkspaceBody({ state, workspacePane, detailCursor, gitCursor }: { state: TuiState; workspacePane: 'files' | 'details' | 'git'; detailCursor: number; gitCursor: number }) {
  const ws = state.workspace;
  const { rows, cols } = useTerminalSize();

  if (!ws?.active) {
    return (
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        <Text color="yellow">Workspace mode is not active.</Text>
        <Text dimColor>Use /ws open &lt;path&gt; or type: open workspace /path/to/project</Text>
      </Box>
    );
  }

  const focusArea = ws.focusArea;
  const rightPanel = ws.rightPanel;

  // Layout math: rows budget
  // statusBar(2) + tabBar(1) + inputBox(3) = 6 fixed rows
  const fixedOverhead = 6;
  const idePanelHeight = Math.max(8, rows - fixedOverhead);

  // Column widths — 3 columns: explorer | code | right panel (chat or git)
  let explorerWidth: number;
  let rightWidth: number;

  if (cols >= 140) {
    explorerWidth = Math.floor(cols * 0.18);
    rightWidth = Math.floor(cols * 0.28);
  } else if (cols >= 120) {
    explorerWidth = Math.floor(cols * 0.18);
    rightWidth = Math.floor(cols * 0.26);
  } else if (cols >= 100) {
    explorerWidth = Math.floor(cols * 0.22);
    rightWidth = Math.floor(cols * 0.28);
  } else {
    // Narrow: explorer + code only, no right panel
    explorerWidth = Math.floor(cols * 0.30);
    rightWidth = 0;
  }

  return (
    <Box flexDirection="column" flexGrow={1}>
      <WorkspaceTabBar ws={ws} focusArea={focusArea} cols={cols} />
      <Box flexDirection="row">
        <Box width={explorerWidth}>
          <ExplorerPanel
            ws={ws}
            panelHeight={idePanelHeight}
            isFocused={focusArea === 'explorer'}
          />
        </Box>
        <Box flexGrow={1}>
          <CodeViewerPanel
            ws={ws}
            panelHeight={idePanelHeight}
            isFocused={focusArea === 'code'}
          />
        </Box>
        {rightWidth > 0 && (
          <Box width={rightWidth}>
            {rightPanel === 'chat' ? (
              <AgentOutputPanel
                state={state}
                panelHeight={idePanelHeight}
                isFocused={focusArea === 'chat'}
                scrollOffset={ws.chatScrollOffset}
              />
            ) : (
              <GitPanel
                ws={ws}
                panelHeight={idePanelHeight}
                isFocused={focusArea === 'git'}
                gitCursor={gitCursor}
              />
            )}
          </Box>
        )}
      </Box>
    </Box>
  );
}

function MenuBody({ menuIdx }: { menuIdx: number }) {
  const menuOptions: Array<{ label: string; mode: AppMode; icon: string }> = [
    { label: 'Status', mode: 'menu', icon: '📊' },
    { label: 'Coding Mode', mode: 'coding', icon: '💻' },
    { label: 'Memory', mode: 'chat', icon: '🧠' },
    { label: 'Spotify Player', mode: 'spotify', icon: '🎵' },
    { label: 'Permissions', mode: 'chat', icon: '🔒' },
    { label: 'Back to Chat', mode: 'chat', icon: '💬' },
  ];

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      <Text bold color="cyan">Menu</Text>
      {menuOptions.map((opt, i) => (
        <Box key={i}>
          <Text>{i === menuIdx ? '●' : '·'} </Text>
          <Text color={i === menuIdx ? 'cyan' : 'gray'}>{opt.icon} {opt.label}</Text>
        </Box>
      ))}
      <Box marginTop={1}><Text dimColor>↑↓ navigate · Enter select · Esc back</Text></Box>
    </Box>
  );
}

function SpotifyBody({ activeIdx, nowPlaying, status, volume, albumArtAnsi }: { activeIdx: number; nowPlaying: string; status: string; volume: number | null; albumArtAnsi: string }) {
  const volumeBar = volume == null
    ? '[unknown]'
    : `[${'█'.repeat(Math.max(0, Math.min(10, Math.round(volume / 10))))}${'░'.repeat(Math.max(0, 10 - Math.round(volume / 10)))}] ${volume}%`;
  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      <Box paddingX={1} marginBottom={1} flexDirection="column">
        <Text color="green">╭────────────────── Spotify Deck ──────────────────╮</Text>
        <Text color="green">│</Text><Text> </Text><Text bold color="green">Now Playing</Text>
        {(nowPlaying || 'Nothing playing').split('\n').map((line, idx) => (
          <Box key={`np-${idx}`}>
            <Text color="green">│</Text><Text> </Text><Text>{line}</Text>
          </Box>
        ))}
        <Box>
          <Text color="green">│</Text><Text> </Text><Text color="yellow">Volume:</Text><Text> </Text><Text>{volumeBar}</Text>
        </Box>
        {albumArtAnsi ? (
          <Box>
            <Text color="green">│</Text><Text> </Text><Text>{albumArtAnsi}</Text>
          </Box>
        ) : null}
        {status ? (
          <Box>
            <Text color="green">│</Text><Text> </Text><Text color="cyan">Last action:</Text><Text> </Text><Text>{status}</Text>
          </Box>
        ) : null}
        <Text color="green">╰───────────────────────────────────────────────────╯</Text>
      </Box>
      <Box flexDirection="column">
        <Text bold color="cyan">Controls</Text>
        {PLAYER_CONTROLS.map((control, i) => (
          <Box key={control.value}>
            <Text>{i === activeIdx ? '●' : '·'} </Text>
            <Text color={i === activeIdx ? 'green' : 'gray'}>{control.label}</Text>
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>↑↓ navigate · Enter select · N next · P previous · +/- volume · Z now playing · Esc exit</Text>
      </Box>
    </Box>
  );
}

function ChatMessagesView({ messages, agentName }: { messages: ChatMessage[]; agentName: string }) {
  if (messages.length === 0) return null;
  const visible = messages.slice(-50);
  const cache = React.useRef<Map<string, string>>(new Map());
  const wasStreaming = React.useRef<Set<string>>(new Set());
  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      {visible.map((msg) => {
        const isCompletion = msg.role === 'system' && msg.content.startsWith('━━━');
        const roleColor = isCompletion ? 'green' : msg.role === 'user' ? 'yellow' : msg.role === 'system' ? 'gray' : 'cyan';
        const prefix = msg.role === 'user' ? 'You' : msg.role === 'system' ? '' : agentName;
        if (isCompletion) {
          const meta = msg.completionMeta;
          const formatTokens = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
          return (
            <Box key={msg.id} flexDirection="column" marginBottom={1}>
              <Text color="green" bold>{msg.content}</Text>
              {meta && (
                <Box flexDirection="row" paddingLeft={2}>
                  <Text color="gray">☿ </Text>
                  <Text color="white" bold>{meta.model}</Text>
                  <Text color="gray"> via </Text>
                  <Text color="cyan">{meta.provider}</Text>
                  <Text color="gray"> · </Text>
                  <Text color="yellow">{formatTokens(meta.totalTokens)}</Text>
                  <Text color="gray"> tokens · Budget </Text>
                  {(() => {
                    const pct = Math.round(meta.budgetPercentage);
                    const barLen = 16;
                    const filled = Math.round((pct / 100) * barLen);
                    const barColor = pct >= 90 ? 'red' : pct >= 70 ? 'yellow' : 'green';
                    return (
                      <>
                        <Text color={barColor}>{'█'.repeat(filled)}</Text>
                        <Text color="gray">{'░'.repeat(barLen - filled)}</Text>
                        <Text color={barColor}> {pct}%</Text>
                      </>
                    );
                  })()}
                </Box>
              )}
            </Box>
          );
        }
        let rendered: string;
        if (msg.streaming) {
          rendered = renderMarkdown(msg.content);
          cache.current.set(msg.id, rendered);
          wasStreaming.current.add(msg.id);
        } else if (wasStreaming.current.has(msg.id)) {
          // Streaming just ended — re-render with final complete content
          rendered = renderMarkdown(msg.content);
          cache.current.set(msg.id, rendered);
          wasStreaming.current.delete(msg.id);
        } else {
          rendered = cache.current.get(msg.id) ?? renderMarkdown(msg.content);
          cache.current.set(msg.id, rendered);
        }
        return (
          <Box key={msg.id} flexDirection="column" marginBottom={1}>
            <Box>
              <Text bold color={roleColor}>{prefix}:</Text>
            </Box>
            <Box marginLeft={2} flexDirection="column">
              {rendered.split('\n').map((line, idx) => (
                <Text key={`${msg.id}:${idx}`}>{line.length > 0 ? line : ' '}</Text>
              ))}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

function ToolStepsView({ steps, viewMode }: { steps: ToolStep[]; viewMode: 'balanced' | 'detailed' }) {
  const visible = viewMode === 'detailed' ? steps.slice(-20) : steps.slice(-5);
  const totalDone = steps.filter((s) => s.status === 'done').length;
  const totalRunning = steps.filter((s) => s.status === 'running').length;
  const hiddenCount = Math.max(0, steps.length - visible.length);
  return (
    <Box flexDirection="column" marginLeft={2} marginTop={1}>
      <Box>
        <Text color="gray">Activity</Text>
        <Text dimColor> · {totalDone} done{totalRunning > 0 ? `, ${totalRunning} running` : ''}</Text>
        {hiddenCount > 0 && <Text dimColor> · {hiddenCount} earlier steps hidden</Text>}
      </Box>
      {visible.map((step) => (
        <Box key={step.id}>
          <Text>
            {step.status === 'running' ? '⏳' : step.status === 'done' ? '✅' : '❌'}
          </Text>
          <Text> </Text>
          <Text dimColor={step.status === 'done'} color={step.status === 'running' ? 'cyan' : undefined} bold={step.status === 'running'}>{step.label}</Text>
          {step.status === 'running' && <Text color="yellow"> …</Text>}
          {step.status === 'done' && step.elapsed != null && <Text dimColor> ({step.elapsed.toFixed(1)}s)</Text>}
          {viewMode === 'detailed' && step.result && <Text dimColor> · {step.result}</Text>}
        </Box>
      ))}
      <Text dimColor>Ctrl+T toggles view · /progress for full history</Text>
    </Box>
  );
}

function ThinkingIndicator({ agentName, steps, mode }: { agentName: string; steps: ToolStep[]; mode: AppMode }) {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const [frame, setFrame] = React.useState(0);
  const [elapsed, setElapsed] = React.useState(0);
  const startRef = React.useRef(Date.now());

  React.useEffect(() => {
    startRef.current = Date.now();
    const timer = setInterval(() => {
      setFrame((v) => (v + 1) % frames.length);
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    }, 80);
    return () => clearInterval(timer);
  }, []);

  const spinner = frames[frame % frames.length];
  const runningStep = [...steps].reverse().find((s) => s.status === 'running');
  const doneSteps = steps.filter((s) => s.status === 'done');
  const totalSteps = steps.length;

  // Determine current action label
  const currentAction = runningStep
    ? runningStep.label
    : (mode === 'coding' || mode === 'workspace') ? 'Analyzing code' : 'Composing response';

  // Format elapsed time
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

  return (
    <Box marginTop={1} marginLeft={2} flexDirection="column">
      <Box>
        <Text color="cyan">{spinner}</Text>
        <Text> </Text>
        <Text color="cyan" bold>{totalSteps > 0 ? agentName : 'Processing'}</Text>
        <Text dimColor>{totalSteps > 0 ? ` · step ${totalSteps} · ${timeStr}` : ` · ${timeStr}`}</Text>
      </Box>
      <Box marginLeft={4}>
        <Text color="white" bold>{currentAction}</Text>
      </Box>
      {doneSteps.length > 0 && (
        <Box flexDirection="column" marginLeft={4} marginTop={0}>
          {doneSteps.slice(-3).map((step) => (
            <Box key={step.id}>
              <Text color="green">✓</Text>
              <Text dimColor> {step.label}</Text>
              {step.elapsed != null && <Text dimColor> ({step.elapsed.toFixed(1)}s)</Text>}
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}

function AgentPanelView({ agents }: { agents: SubAgentInfo[] }) {
  if (agents.length === 0) return null;
  return (
    <Box flexDirection="column" marginTop={1} paddingX={1}>
      <Text color="gray">{'─'.repeat(30)}</Text>
      <Text bold color="cyan">Agents</Text>
      {agents.map((agent) => {
        const cfg = STATUS_ICONS[agent.status] || STATUS_ICONS.pending;
        const elapsed = ((Date.now() - agent.startedAt) / 1000).toFixed(0);
        const taskPreview = agent.task.length > 40 ? agent.task.slice(0, 37) + '...' : agent.task;
        return (
          <Box key={agent.id} flexDirection="column">
            <Box><Text>{cfg.icon} </Text><Text bold color={cfg.color}>{agent.id}</Text><Text dimColor> {taskPreview}</Text></Box>
            <Box marginLeft={3}><Text dimColor>{agent.status} · {elapsed}s</Text></Box>
          </Box>
        );
      })}
    </Box>
  );
}

function SidebarView({ sections }: { sections: SidebarSection[] }) {
  if (sections.length === 0) return null;
  return (
    <Box flexDirection="column" width={24} paddingX={1}>
      <Text color="gray">{'─'.repeat(22)}</Text>
      {sections.map((section, si) => (
        <Box key={si} flexDirection="column" marginBottom={si < sections.length - 1 ? 1 : 0}>
          <Text bold color="cyan">{section.title}</Text>
          {section.items.map((item, ii) => (
            <Box key={ii}><Text>{item.icon} </Text><Text color={item.active ? 'white' : 'gray'}>{item.label}</Text></Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}

function PermPromptView({ prompt, activeIdx }: { prompt: PermissionPromptState; activeIdx: number }) {
  const options = prompt.options || [];

  if (options.length > 0) {
    const hasAlways = options.some((opt) => opt.value === 'always');
    return (
      <Box flexDirection="column" marginTop={1} paddingX={1}>
        <Box><Text bold color="yellow">⚠ {prompt.message}</Text></Box>
        {options.map((opt, i) => (
          <Box key={opt.value}>
            <Text>{i === activeIdx ? '●' : '·'} </Text>
            <Text color={i === activeIdx ? 'cyan' : 'gray'}>{opt.label}</Text>
          </Box>
        ))}
        <Text dimColor>{hasAlways ? '  ↑↓ choose · Enter confirm · Y/N/A shortcuts · Esc cancel' : '  ↑↓ choose · Enter confirm · Y/N shortcuts · Esc cancel'}</Text>
      </Box>
    );
  }

  if (prompt.type === 'continue') {
    return (
      <Box flexDirection="column" marginTop={1} paddingX={1}>
        <Box><Text color="yellow">⚠ </Text><Text>{prompt.message}</Text></Box>
        <Text dimColor>  [y/N]</Text>
      </Box>
    );
  }

  if (prompt.type === 'ask') {
    return (
      <Box flexDirection="column" marginTop={1} paddingX={1}>
        <Box><Text color="yellow">⚠ </Text><Text>{prompt.message}</Text></Box>
        <Text dimColor>  Type your answer and press Enter</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginTop={1} paddingX={1}>
      <Box><Text bold color="yellow">⚠ {prompt.message}</Text></Box>
      {options.map((opt, i) => (
        <Box key={opt.value}>
          <Text>{i === activeIdx ? '●' : '·'} </Text>
          <Text color={i === activeIdx ? 'cyan' : 'gray'}>{opt.label}</Text>
        </Box>
      ))}
      <Text dimColor>  ↑↓ to navigate, Enter to select</Text>
    </Box>
  );
}

function InputBox({
  input,
  cursorPos,
  mode,
  programmingMode,
  projectContext,
}: {
  input: string;
  cursorPos: number;
  mode: AppMode;
  programmingMode: ProgrammingModeState;
  projectContext: string | null;
}) {
  const inWorkspace = mode === 'workspace';
  const inCoding = mode === 'coding' || inWorkspace;
  const promptColor = inWorkspace ? 'cyan' : inCoding ? 'green' : 'yellow';
  const label = inWorkspace ? '[IDE CHAT]' : inCoding ? '[CODING]' : '[CHAT]';
  const contextLabel = projectContext && projectContext.length > 52
    ? `...${projectContext.slice(-49)}`
    : (projectContext || 'No project context');

  // Split input into lines and figure out which line/col the cursor is on
  const lines = input.split('\n');
  let cursorLine = 0;
  let cursorCol = cursorPos;
  let consumed = 0;
  for (let i = 0; i < lines.length; i++) {
    if (consumed + lines[i].length >= cursorPos && i < lines.length - 1 ? consumed + lines[i].length + 1 > cursorPos : true) {
      cursorLine = i;
      cursorCol = cursorPos - consumed;
      break;
    }
    consumed += lines[i].length + 1; // +1 for \n
  }

  return (
    <Box flexDirection="column">
      <Text color="dim">{'─'.repeat(60)}</Text>
      <Box paddingX={1}>
        <Text color={promptColor} bold>{label}</Text>
        <Text dimColor> {contextLabel} </Text>
        <Text color={programmingMode === 'execute' ? 'green' : programmingMode === 'plan' ? 'yellow' : 'gray'}>
          mode={programmingMode.toUpperCase()}
        </Text>
      </Box>
      <Box paddingX={1} flexDirection="column">
        {lines.map((line, i) => (
          <Box key={i}>
            <Text color={promptColor} bold>{i === 0 ? '> ' : '  '}</Text>
            {i === cursorLine ? (
              <>
                <Text>{line.slice(0, cursorCol)}</Text>
                <Text inverse>{cursorCol < line.length ? line[cursorCol] : ' '}</Text>
                <Text>{cursorCol < line.length ? line.slice(cursorCol + 1) : ''}</Text>
              </>
            ) : (
              <Text>{line}</Text>
            )}
          </Box>
        ))}
      </Box>
      <Box paddingX={1}>
        <Text dimColor>{inWorkspace ? 'Tab switch panels · Ctrl+J chat · Ctrl+P Plan · Ctrl+X Execute · Esc back/exit' : inCoding ? 'Coding chat active. Ctrl+P Plan · Ctrl+X Execute.' : 'Enter send · Ctrl+N newline'}</Text>
      </Box>
    </Box>
  );
}
