import React, { useSyncExternalStore } from 'react';
import { Box, Text, Spacer, Static, useApp, useInput, useStdout } from 'ink';
import type { TuiState } from '../channels/cli.js';
import type { AppMode, ChatMessage, ToolStep, SubAgentInfo, PermissionPromptState, SidebarSection, BackgroundTaskInfo, WorkspaceState } from './types.js';
import type { PermissionMode } from '../channels/base.js';
import type { ProgrammingModeState } from '../core/programming-mode.js';
import { renderMarkdown } from '../utils/markdown.js';
import { highlightCodeBlock } from '../utils/highlight.js';
import { anchorViewportDistance, normalizeTerminalText, getViewportWindow, moveViewport } from './terminal-viewport.js';
import { buildMercuryMessageLines, buildMercuryBrandLines, wrapMercuryText, type MercuryTranscriptLine } from './mercury-transcript.js';
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
  /** Live channel store: state is read via useSyncExternalStore, not props. */
  channel: {
    getTuiStateSnapshot: () => TuiState;
    subscribeToTuiState: (listener: () => void) => () => void;
  };
  onInput: (text: string) => void;
  onPermissionResolve: (value: string | boolean) => void;
  onExit: () => void;
  spotifyClient?: SpotifyClient | null;
}

export function TuiApp({ channel, onInput, onPermissionResolve, onExit, spotifyClient }: TuiAppProps) {
  // Single source of render truth: the channel's immutable state snapshots.
  // Notifications are scheduled by React's reconciler — no imperative
  // re-render path exists, so re-entrant commits are impossible.
  const state = useSyncExternalStore(channel.subscribeToTuiState, channel.getTuiStateSnapshot, channel.getTuiStateSnapshot);
  const { exit } = useApp();
  const terminalSize = useTerminalSize();
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
  const [gitCursor, setGitCursor] = React.useState(0);

  const slashCommands = React.useMemo(() => [
    '/help',
    '/sessions',
    '/session new',
    '/session current',
    '/session ',
    '/session archive ',
    '/session delete ',
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

  // ── Skill picker (`#name` prefix) ──
  // Mirrors the slash picker. Triggered when input starts with `#`. Matches
  // skills by name prefix first, then by name-substring, then by
  // description-substring (case-insensitive). The selected entry inserts as
  // `#skill-name ` so the user can continue typing their request.
  const skillSuggestions = React.useMemo(() => {
    if (!input.startsWith('#')) return [] as Array<{ name: string; description: string }>;
    const q = input.slice(1).split(/\s/)[0].toLowerCase();
    const skills = state.skills || [];
    if (!q) {
      return skills.slice(0, 8).map((s) => ({ name: s.name, description: s.description }));
    }
    const prefix: typeof skills = [];
    const nameSub: typeof skills = [];
    const descSub: typeof skills = [];
    for (const s of skills) {
      const n = s.name.toLowerCase();
      if (n.startsWith(q)) prefix.push(s);
      else if (n.includes(q)) nameSub.push(s);
      else if ((s.description || '').toLowerCase().includes(q)) descSub.push(s);
    }
    return [...prefix, ...nameSub, ...descSub]
      .slice(0, 8)
      .map((s) => ({ name: s.name, description: s.description }));
  }, [input, state.skills]);

  const [skillSelIdx, setSkillSelIdx] = React.useState(0);
  React.useEffect(() => {
    setSkillSelIdx(0);
  }, [skillSuggestions.length, input]);

  const showInput = state.mode !== 'mercury-code' && !state.permissionPrompt && (state.mode === 'chat' || state.mode === 'coding' || state.mode === 'workspace');

  const completeSkillSelection = React.useCallback(() => {
    const picked = skillSuggestions[skillSelIdx];
    if (!picked) return false;
    // If the user already typed something after the hash-token, keep it.
    const rest = input.slice(1).split(/\s(.*)/s)[1] || '';
    const next = rest ? `#${picked.name} ${rest}` : `#${picked.name} `;
    setInputAndCursor(next);
    return true;
  }, [skillSuggestions, skillSelIdx, input]);

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

    // ── Mercury Code full-screen mode ──
    if (state.mode === 'mercury-code') {
      const mc = state.mercuryCode;
      if (!mc) return;

      if (ch === '\u0003') { onExit(); return; }

      // Exit confirmation overlay: Esc cancels, y/Enter confirms, Ctrl+D force-quits.
      if (mc.exitConfirm) {
        if (key.escape) { onInput('/mc exit-cancel'); return; }
        if (isEnter || ch === 'y' || ch === 'Y') { onInput('/mc exit-confirm'); return; }
        if (key.ctrl && (ch === 'd' || ch === 'D')) { onInput('/mc exit-force'); return; }
        if (ch === 'n' || ch === 'N') { onInput('/mc exit-cancel'); return; }
        return;
      }

      // Ask agent to exit: arms the confirm overlay.
      if (key.escape && state.exitEscArmed) {
        onInput('/mc exit-arm');
        return;
      }
      if (key.escape) { onInput('/mc esc-arm'); return; }

      if (key.ctrl && (ch === 'd' || ch === 'D')) { onInput('/mc exit-force'); return; }

      // Ctrl+P / Ctrl+X plan/execute shortcuts
      if (key.ctrl && (ch === 'p' || ch === 'P')) { onInput('/code plan'); return; }
      if (key.ctrl && (ch === 'x' || ch === 'X')) { onInput('/code execute'); return; }
      if (key.ctrl && (ch === 'g' || ch === 'G')) { onInput('/code diff'); return; }

      // Ctrl+N newline in input
      if (key.ctrl && (ch === 'n' || ch === 'N' || ch === '\x0e')) {
        setInput((prev) => prev.slice(0, cursorPos) + '\n' + prev.slice(cursorPos));
        setCursorPos((p) => p + 1);
        return;
      }

      if (isEnter) {
        const trimmed = input.trim();
        if (trimmed) {
          onInput(trimmed);
          setInputHistory((prev) => {
            if (prev[prev.length - 1] === trimmed) return prev;
            return [...prev.slice(-99), trimmed];
          });
          setHistoryIndex(-1);
          setHistoryDraft('');
          setInputAndCursor('');
        }
        return;
      }

      if (key.tab) return;

      if (key.leftArrow) { setCursorPos((p) => Math.max(0, p - 1)); return; }
      if (key.rightArrow) { setCursorPos((p) => Math.min(input.length, p + 1)); return; }
      if (key.upArrow) { onInput('/mc scroll 1'); return; }
      if (key.downArrow) { onInput('/mc scroll -1'); return; }
      const transcriptPage = Math.max(5, terminalSize.rows - 12);
      if (key.pageUp) { onInput(`/mc scroll ${transcriptPage}`); return; }
      if (key.pageDown) { onInput(`/mc scroll -${transcriptPage}`); return; }
      if ((key as any).home) { onInput('/mc scroll 1000000000'); return; }
      if ((key as any).end) { onInput('/mc live'); return; }
      if (key.ctrl && (ch === 'u' || ch === 'U')) { onInput(`/mc scroll ${transcriptPage}`); return; }
      if (key.ctrl && (ch === 'a' || ch === 'A')) { onInput('/mc scroll 1000000000'); return; }
      if (key.ctrl && (ch === 'e' || ch === 'E')) { onInput('/mc live'); return; }
      if (key.backspace || key.delete) {
        if (cursorPos > 0) {
          setInput((prev) => prev.slice(0, cursorPos - 1) + prev.slice(cursorPos));
          setCursorPos((p) => p - 1);
        }
        return;
      }
      if (key.ctrl || key.meta) return;

      if (ch && ch.length > 0 && !key.escape) {
        const clean = ch
          .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
          .split('')
          .filter((c) => {
            const code = c.charCodeAt(0);
            return (code >= 0x20 && code <= 0x7e) || code >= 0xa0;
          })
          .join('');
        if (clean) {
          setInput((prev) => prev.slice(0, cursorPos) + clean + prev.slice(cursorPos));
          setCursorPos((p) => p + clean.length);
        }
      }
      return;
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
          if (state.permissionPrompt.type === 'mode') resolvePermissionAndMaybeContinue('ask-me');
          else if (state.permissionPrompt.type !== 'choice') resolvePermissionAndMaybeContinue('no');
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

      // Skill picker: first Enter fills the selection (so the user can keep
      // typing their request after the skill name); second Enter submits.
      if (skillSuggestions.length > 0) {
        const picked = skillSuggestions[skillSelIdx];
        const expected = picked ? `#${picked.name}` : '';
        if (picked && !trimmed.startsWith(expected + ' ') && trimmed !== expected) {
          completeSkillSelection();
          return;
        }
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
        const showRight = terminalSize.cols >= 100;
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
          const viewerLines = Math.max(1, (terminalSize.rows - 11));
          if (key.upArrow) { onInput(`/ws scroll -1 ${viewerLines}`); return; }
          if (key.downArrow) { onInput(`/ws scroll 1 ${viewerLines}`); return; }
          if (key.pageUp) { onInput(`/ws scroll ${-viewerLines} ${viewerLines}`); return; }
          if (key.pageDown) { onInput(`/ws scroll ${viewerLines} ${viewerLines}`); return; }
          if (key.ctrl && (ch === 'u' || ch === 'U')) { onInput(`/ws scroll ${-viewerLines} ${viewerLines}`); return; }
          if (key.ctrl && (ch === 'd' || ch === 'D')) { onInput(`/ws scroll ${viewerLines} ${viewerLines}`); return; }
          if ((key as any).home) { onInput('/ws scroll-home'); return; }
          if ((key as any).end) { onInput(`/ws scroll-end ${viewerLines}`); return; }
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
          if (key.upArrow) { onInput('/ws chat-scroll 1'); return; }
          if (key.downArrow) { onInput('/ws chat-scroll -1'); return; }
          if (key.pageUp) { onInput('/ws chat-scroll 10'); return; }
          if (key.pageDown) { onInput('/ws chat-scroll -10'); return; }
          if (key.ctrl && (ch === 'u' || ch === 'U')) { onInput('/ws chat-scroll 10'); return; }
          if (key.ctrl && (ch === 'd' || ch === 'D')) { onInput('/ws chat-scroll -10'); return; }
          if ((key as any).home) { onInput('/ws chat-home'); return; }
          if ((key as any).end) { onInput('/ws chat-end'); return; }
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

    // Ctrl+D → show last task's step log (when not in workspace nav mode,
    // which uses Ctrl+D for scrolling).  Splash mode also uses 'd' key.
    if (key.ctrl && (ch === 'd' || ch === 'D') && !state.permissionPrompt && state.mode !== 'workspace') {
      onInput('/log');
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
      } else if (input.startsWith('#') && skillSuggestions.length > 0) {
        completeSkillSelection();
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

    // Up/down arrow: navigate skill (#) suggestions when popup is visible
    if (skillSuggestions.length > 0) {
      if (key.upArrow) {
        setSkillSelIdx((i) => (i > 0 ? i - 1 : skillSuggestions.length - 1));
        return;
      }
      if (key.downArrow) {
        setSkillSelIdx((i) => (i < skillSuggestions.length - 1 ? i + 1 : 0));
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
      // Strip control chars and escape-sequence fragments (handles paste).
      // Mouse scroll in raw mode sends SGR sequences like \x1b[<0;row;colM
      // — Ink partially consumes \x1b[ but the remaining fragments (<, ;, digits,
      // M) leak through as individual ch characters. Reject any ch that isn't
      // a normal printable character (ASCII 0x20-0x7E or Unicode >= 0xA0).
      const clean = ch
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
        .split('')
        .filter((c) => {
          const code = c.charCodeAt(0);
          return (code >= 0x20 && code <= 0x7e) || code >= 0xa0;
        })
        .join('');
      // Flood guard: a corrupt stream must never be able to grow the input
      // box unboundedly (input bloat previously cascaded into render
      // storms + V8 aborts). Keep typing functional, cap the reservoir.
      const MAX_INPUT_LEN = 8000;
      if (clean) {
        const next = input.slice(0, cursorPos) + clean + input.slice(cursorPos);
        if (next.length > MAX_INPUT_LEN) {
          if (input.length >= MAX_INPUT_LEN) return; // already full — drop silently
          const accepted = MAX_INPUT_LEN - input.length;
          setInput(next.slice(0, MAX_INPUT_LEN));
          setCursorPos((p) => p + accepted);
        } else {
          setInput(next);
          setCursorPos((p) => p + clean.length);
        }
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
            <Text>Web: {state.web?.enabled ? <Text color="green">Serving · http://127.0.0.1:{state.web.port}</Text> : <Text color="gray">Disabled</Text>}</Text>
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

  return (
    <Box flexDirection="column" flexGrow={1}>
      {state.backgroundTasks.length > 0 && <BackgroundBarView tasks={state.backgroundTasks} />}
      {state.mode === 'mercury-code' ? (
        <MercuryCodeView
          state={state}
          height={Math.max(10, terminalSize.rows)}
          cols={terminalSize.cols}
          input={input}
          cursorPos={cursorPos}
          onInput={onInput}
          onScrollClamp={(distance) => onInput(`/mc scroll-set ${distance}`)}
        />
      ) : null}
      {state.mode === 'spotify' ? <SpotifyBody activeIdx={spotifyIdx} nowPlaying={spotifyNow} status={spotifyStatus} volume={spotifyVolume} albumArtAnsi={spotifyArtAnsi} /> : null}
      {state.mode === 'menu' ? <MenuBody menuIdx={menuIdx} /> : null}
      {state.mode === 'coding' ? <CodingBody state={state} maxDynamicLines={Math.max(3, terminalSize.rows - 14)} /> : null}
      {state.mode === 'workspace' ? (
        <WorkspaceBody state={state} gitCursor={gitCursor} height={Math.max(8, terminalSize.rows - 6)} cols={terminalSize.cols} onInput={onInput} />
      ) : null}
      {state.mode === 'chat' ? (
        <ChatBody state={state} maxDynamicLines={Math.max(3, terminalSize.rows - 14)} />
      ) : null}
      {state.permissionPrompt && state.mode !== 'mercury-code' && (
        <PermPromptView prompt={state.permissionPrompt} activeIdx={permIdx} />
      )}
      {showInput && state.mode !== 'mercury-code' && (
        <InputBox
          input={input}
          cursorPos={cursorPos}
          mode={state.mode}
          programmingMode={state.programmingMode}
          projectContext={state.projectContext}
        />
      )}
      {showInput && state.mode !== 'mercury-code' && slashSuggestions.length > 0 && (
        <Box flexDirection="column" paddingX={1}>
          <Text dimColor>Suggestions (↑↓ navigate · Tab/Enter to select):</Text>
          {slashSuggestions.map((cmd, idx) => (
            <Text key={cmd} color={idx === slashSelIdx ? 'cyan' : 'gray'}>{idx === slashSelIdx ? '›' : ' '} {cmd}</Text>
          ))}
        </Box>
      )}
      {showInput && state.mode !== 'mercury-code' && skillSuggestions.length > 0 && (
        <Box flexDirection="column" paddingX={1}>
          <Text dimColor>Skills (↑↓ navigate · Tab/Enter to select):</Text>
          {skillSuggestions.map((s, idx) => (
            <Text key={s.name} color={idx === skillSelIdx ? 'magenta' : 'gray'}>
              {idx === skillSelIdx ? '›' : ' '} #{s.name}
              {s.description ? <Text dimColor> — {s.description.slice(0, 70)}{s.description.length > 70 ? '…' : ''}</Text> : null}
            </Text>
          ))}
        </Box>
      )}
      {state.mode !== 'mercury-code' && <TokenBarView state={state} cols={terminalSize.cols} />}
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
    <Box paddingX={1} paddingBottom={0} flexShrink={0}>
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

const HEADER_SENTINEL_ID = '__mercury_header__';

/**
 * Static-output bound: number of finalized messages Ink's <Static> retains.
 * Everything older remains in the session store; the live transcript box
 * still shows the tail. This keeps fullStaticOutput bounded regardless of
 * session length.
 */
const MAX_STATIC_MESSAGES = 100;

/**
 * Identity for Ink <Static> item dedup (patched Static.js `itemKey` prop).
 * Ink's built-in positional index assumes `items` only ever appends; this
 * window drops the oldest entries once the transcript exceeds
 * MAX_STATIC_MESSAGES, which under the positional scheme made
 * `items.slice(index)` empty — new messages stopped rendering and every
 * commit unmounted the entire static subtree (freed Yoga nodes churned each
 * frame). Identity-based dedup renders each item exactly once per <Static>
 * instance regardless of window shifts.
 */
const staticItemKey = (item: string | ChatMessage): string => typeof item === 'string' ? item : item.id;

function HeaderBanner(): React.ReactNode {
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Box paddingX={1}>
        <Text color={BRAND.logo}>☿</Text>
        <Text> </Text>
        <Text bold color={BRAND.title}>MERCURY</Text>
        <Text color={BRAND.subtitle}> · Your soul-driven AI agent</Text>
      </Box>
      <Box paddingX={1}>
        <Text color="gray">{'─'.repeat(50)}</Text>
      </Box>
    </Box>
  );
}

function TokenBarView({ state, cols }: { state: TuiState; cols: number }) {
  if (!state.tokenInfo && !state.provider && !state.currentSession) return null;

  const saverActive = !!(state.saverInfo && state.saverInfo.state !== 'off');
  const saverColor = state.saverInfo?.state === 'auto' ? 'yellow' : 'green';
  const pct = state.tokenInfo?.percentage ?? 0;
  const pctColor = saverActive ? saverColor : pct >= 90 ? 'red' : pct >= 70 ? 'yellow' : 'cyan';

  const runningAgents = state.subAgents.filter((a) => a.status === 'running' || a.status === 'paused').length;
  const runningBg = state.backgroundTasks.filter((t) => t.status === 'running').length;
  const isWorkspace = state.mode === 'workspace' && state.workspace;

  // Build colored segments — each has {text, color}. Rendered inline with │.
  const segments: { text: string; color: string }[] = [];

  // 1. Token bar
  if (state.tokenInfo) {
    if (saverActive) segments.push({ text: '⚡', color: saverColor });
    segments.push({
      text: `${pct < 25 ? '○' : pct < 50 ? '◔' : pct < 75 ? '◑' : pct < 100 ? '◕' : '●'}[${'█'.repeat(Math.min(10, Math.round(pct / 10)))}${'░'.repeat(10 - Math.min(10, Math.round(pct / 10)))}] ${pct}%`,
      color: pctColor,
    });
    if (saverActive && state.saverInfo!.savedToday > 0) {
      segments.push({ text: `~${formatCompact(state.saverInfo!.savedToday)}`, color: 'green' });
    }
  }

  // 2. Provider
  if (state.provider) {
    segments.push({ text: `${state.provider.name} · ${state.provider.model}`, color: 'magenta' });
  }

  // 3. Session
  if (state.currentSession) {
    segments.push({ text: `${state.currentSession.alias} [${state.currentSession.shortId}]`, color: 'cyan' });
  }

  // 4. Workspace
  if (isWorkspace && state.workspace) {
    const ws = state.workspace;
    let wsStr = `⎇ ${ws.branch}`;
    if (ws.ahead > 0) wsStr += ` ↑${ws.ahead}`;
    if (ws.behind > 0) wsStr += ` ↓${ws.behind}`;
    if (ws.stagedCount > 0) wsStr += ` S${ws.stagedCount}`;
    if (ws.unstagedCount > 0) wsStr += ` M${ws.unstagedCount}`;
    segments.push({ text: wsStr, color: 'blue' });
  }

  // 5. Background tasks
  if (!isWorkspace && runningBg > 0) {
    segments.push({ text: `⏳ ${runningBg}bg`, color: 'cyan' });
  }

  // 6. Sub-agents
  if (!isWorkspace && runningAgents > 0) {
    segments.push({ text: `🤖 ${runningAgents}agent${runningAgents !== 1 ? 's' : ''}`, color: 'magenta' });
  }

  // Calculate total width and drop segments from the right if they don't fit
  const sepStr = ' │ ';
  const maxLen = Math.max(20, cols - 2);
  let totalLen = segments.reduce((sum, s, i) => sum + s.text.length + (i > 0 ? sepStr.length : 0), 0);
  const visible = [...segments];
  while (totalLen > maxLen && visible.length > 1) {
    const removed = visible.pop()!;
    totalLen -= removed.text.length + sepStr.length;
  }
  if (totalLen > maxLen && visible.length > 0) {
    const last = visible[visible.length - 1];
    const excess = totalLen - maxLen;
    last.text = last.text.slice(0, Math.max(1, last.text.length - excess - 1)) + '…';
  }

  return (
    <Box flexDirection="column" flexShrink={0}>
      <Box paddingX={1}>
        <Text color="gray">{'─'.repeat(Math.max(20, cols - 2))}</Text>
      </Box>
      <Box paddingX={1} paddingBottom={0} height={1} overflow="hidden">
        {visible.map((seg, i) => (
          <React.Fragment key={i}>
            {i > 0 && <Text color="gray">{sepStr}</Text>}
            <Text color={seg.color} wrap="truncate">{seg.text}</Text>
          </React.Fragment>
        ))}
      </Box>
    </Box>
  );
}

function truncateStr(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, Math.max(1, maxLen - 1)) + '…';
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function ChatBody({ state, maxDynamicLines }: { state: TuiState; maxDynamicLines: number }) {
  // Static-output bound: Ink's <Static> accumulates every rendered item in a
  // monotonically growing output string that is re-written on each frame.
  // Retaining the entire transcript there is O(N²) work and permanent heap;
  // older messages live in the session store, so the TUI keeps a bounded
  // recent window. The window is safe because <Static> dedupes by itemKey —
  // see the staticItemKey note above MAX_STATIC_MESSAGES.
  const staticMessages = state.chatMessages.filter((message) => !message.streaming && !message.id.startsWith('heartbeat-')).slice(-MAX_STATIC_MESSAGES);
  // ThinkingIndicator owns transient progress; do not duplicate heartbeat
  // messages in the conversation transcript above it.
  const dynamicMessages = state.chatMessages.filter((message) => message.streaming && !message.id.startsWith('heartbeat-'));
  const staticItems: Array<string | ChatMessage> = [HEADER_SENTINEL_ID, ...staticMessages];
  return (
    <Box flexDirection="row" flexGrow={1}>
      {state.sidebarSections.length > 0 && <SidebarView sections={state.sidebarSections} />}
      <Box flexDirection="column" flexGrow={1}>
        <Static items={staticItems} itemKey={staticItemKey}>
          {(item) => typeof item === 'string'
            ? <HeaderBanner key={item} />
            : <ChatMessagesView key={item.id} messages={[item]} agentName={state.agentName} />}
        </Static>
        <ChatMessagesView messages={dynamicMessages} agentName={state.agentName} maxLines={maxDynamicLines} />
        {state.toolSteps.length > 0 && !state.isThinking && <ToolStepsView steps={state.toolSteps} viewMode={state.viewMode} idle />}
        {state.isThinking && <ThinkingIndicator agentName={state.agentName} steps={state.toolSteps} mode={state.mode} />}
        {state.subAgents.length > 0 && <AgentPanelView agents={state.subAgents} />}
      </Box>
    </Box>
  );
}

function CodingBody({ state, maxDynamicLines }: { state: TuiState; maxDynamicLines: number }) {
  const modeLabels: Record<ProgrammingModeState, { label: string; color: string }> = {
    off: { label: 'OFF', color: 'gray' },
    plan: { label: 'PLAN', color: 'yellow' },
    execute: { label: 'EXECUTE', color: 'green' },
  };
  const modeInfo = modeLabels[state.programmingMode];
  const fileSection = state.sidebarSections.find((s) => s.title === 'Files');
  const staticMessages = state.chatMessages.filter((message) => !message.streaming && !message.id.startsWith('heartbeat-')).slice(-MAX_STATIC_MESSAGES);
  // ThinkingIndicator owns transient progress; do not duplicate heartbeat
  // messages in the conversation transcript above it.
  const dynamicMessages = state.chatMessages.filter((message) => message.streaming && !message.id.startsWith('heartbeat-'));
  const staticItems: Array<string | ChatMessage> = [HEADER_SENTINEL_ID, ...staticMessages];

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
        <Static items={staticItems} itemKey={staticItemKey}>
          {(item) => typeof item === 'string'
            ? <HeaderBanner key={item} />
            : <ChatMessagesView key={item.id} messages={[item]} agentName={state.agentName} />}
        </Static>
        <ChatMessagesView messages={dynamicMessages} agentName={state.agentName} maxLines={maxDynamicLines} />
        {state.toolSteps.length > 0 && !state.isThinking && <ToolStepsView steps={state.toolSteps} viewMode={state.viewMode} idle />}
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
    const onResize = () => {
      const rows = stdout.rows || 24;
      const cols = stdout.columns || 80;
      setSize((current) => current.rows === rows && current.cols === cols ? current : { rows, cols });
    };
    stdout.on('resize', onResize);
    const fallback = setInterval(onResize, 500);
    fallback.unref?.();
    return () => {
      stdout.off('resize', onResize);
      clearInterval(fallback);
    };
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
  const windowSize = Math.max(1, panelHeight - 3); // border + header
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
  const viewerLines = Math.max(1, panelHeight - 4); // border + header + footer
  const preview = ws.openedFilePreview;
  const totalLines = preview.length;
  const maxOffset = Math.max(0, totalLines - viewerLines);
  const offset = Math.max(0, Math.min(maxOffset, ws.codeScrollOffset));
  const visibleLines = preview.slice(offset, offset + viewerLines);
  const lineNumWidth = Math.max(3, String(offset + viewerLines).length);
  const fileName = ws.openedFilePath
    ? ws.openedFilePath.slice(ws.rootPath.length).replace(/^[/\\]+/, '') || ws.openedFilePath
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
  const listHeight = Math.max(1, panelHeight - 5); // border + header + stats + footer
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
  onScrollClamp,
}: {
  state: TuiState;
  panelHeight: number;
  isFocused: boolean;
  scrollOffset: number;
  onScrollClamp: (distance: number) => void;
}) {
  const viewLines = Math.max(1, panelHeight - 5 - (state.isThinking ? 1 : 0)); // border + header + status + footer

  // Build a flat array of rendered lines from messages
  const allLines: Array<{ key: string; node: React.ReactNode }> = [];

  for (const msg of state.chatMessages) {
    const roleColor = msg.role === 'user' ? 'yellow' : msg.role === 'system' ? 'gray' : 'cyan';
    const prefix = msg.role === 'user' ? 'You' : msg.role === 'system' ? 'Sys' : state.agentName;
    const contentLines = normalizeTerminalText(msg.content).split('\n');

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

  const totalLines = allLines.length;
  const viewport = getViewportWindow(totalLines, viewLines, scrollOffset);
  React.useEffect(() => {
    if (viewport.distanceFromBottom !== scrollOffset) onScrollClamp(viewport.distanceFromBottom);
  }, [onScrollClamp, scrollOffset, viewport.distanceFromBottom]);
  const visibleLines = allLines.slice(viewport.start, viewport.end);
  const hiddenAbove = viewport.start;
  const hiddenBelow = Math.max(0, totalLines - viewport.end);

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
      {visibleLines.length > 0 && visibleLines.length < viewLines && (
        Array.from({ length: viewLines - visibleLines.length }, (_, i) => (
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
      <Box paddingX={1} height={1}>
        <Text dimColor>↑{hiddenAbove} · {viewport.start + (totalLines > 0 ? 1 : 0)}-{viewport.end}/{totalLines} · ↓{hiddenBelow}</Text>
      </Box>
      <Box paddingX={1}>
        <Text dimColor>{isFocused ? '↑↓ · PgUp/PgDn · Home/End · Esc back' : 'Ctrl+J focus'}</Text>
      </Box>
    </Box>
  );
}

function WorkspaceBody({ state, gitCursor, height, cols, onInput }: { state: TuiState; gitCursor: number; height: number; cols: number; onInput: (text: string) => void }) {
  const ws = state.workspace;

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

  const idePanelHeight = Math.max(4, height - 1); // tab bar occupies one row

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
    <Box flexDirection="column" height={height} overflow="hidden">
      <WorkspaceTabBar ws={ws} focusArea={focusArea} cols={cols} />
      <Box flexDirection="row" height={idePanelHeight} overflow="hidden">
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
                onScrollClamp={(distance) => onInput(`/ws chat-set ${distance}`)}
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

function ChatMessagesView({ messages, agentName, maxLines }: { messages: ChatMessage[]; agentName: string; maxLines?: number }) {
  if (messages.length === 0) return null;

  return (
    <Box flexDirection="column" flexGrow={1} flexShrink={0} paddingX={1}>
      {messages.slice(-50).map((msg) => (
        <MessageRow key={msg.id} msg={msg} agentName={agentName} maxLines={maxLines} />
      ))}
    </Box>
  );
}

/**
 * Renders a single chat message (user / agent / system completion banner).
 *
 * `live` marks the currently-streaming message; it gets `flexShrink={0}` so
 * Ink's Yoga layout never compresses its rows while deltas are arriving,
 * which is what previously caused the visible "font shrink" + flicker.
 */
const MessageRow = React.memo(function MessageRow({
  msg,
  agentName,
  maxLines,
}: { msg: ChatMessage; agentName: string; maxLines?: number }) {
  const isCompletion = msg.role === 'system' && msg.content.startsWith('━━━');
  const roleColor = isCompletion
    ? 'green'
    : msg.role === 'user'
      ? 'yellow'
      : msg.role === 'system'
        ? 'gray'
        : 'cyan';
  const prefix = msg.role === 'user' ? 'You' : msg.role === 'system' ? '' : agentName;

  if (isCompletion) {
    const meta = msg.completionMeta;
    const formatTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);
    return (
      <Box key={msg.id} flexDirection="column" marginBottom={1} flexShrink={0}>
        <Text color="green" bold>
          {msg.content}
        </Text>
        {meta && (
          <Box flexDirection="row" paddingLeft={2} flexShrink={0}>
            <Text color="gray">☿ </Text>
            <Text color="white" bold>
              {meta.model}
            </Text>
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

  const renderedLines = renderMarkdown(msg.content).split('\n');
  const visibleLines = maxLines && renderedLines.length > maxLines
    ? ['…', ...renderedLines.slice(-(maxLines - 1))]
    : renderedLines;
  return (
    <Box key={msg.id} flexDirection="column" marginBottom={1} flexShrink={0}>
      <Box flexShrink={0}>
        <Text bold color={roleColor}>
          {prefix}:
        </Text>
      </Box>
      <Box marginLeft={2} flexDirection="column" flexShrink={0}>
        {visibleLines.map((line, idx) => (
          <Box key={`${msg.id}:${idx}`} flexShrink={0}>
            <Text>{line.length > 0 ? line : ' '}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
});

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Animated row for a currently-running tool step.
 *
 * Shows a braille spinner + live elapsed counter so the user gets
 * continuous feedback during long operations (1-2 min tool calls
 * like screenshots, large file ops, sub-agent dispatches).
 *
 * Color escalates to signal long runs:
 *   < 30s : cyan       — normal
 *   30-90s: yellow     — "still working" hint
 *   > 90s : red        — long-op warning (mentions Ctrl+C)
 */
function RunningStepRow({ step }: { step: ToolStep }) {
  const [frame, setFrame] = React.useState(0);
  const [elapsed, setElapsed] = React.useState(() =>
    step.startedAt ? Math.floor((Date.now() - step.startedAt) / 1000) : 0,
  );

  React.useEffect(() => {
    const startedAt = step.startedAt ?? Date.now();
    const timer = setInterval(() => {
      setFrame((v) => (v + 1) % SPINNER_FRAMES.length);
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 80);
    return () => clearInterval(timer);
  }, [step.startedAt]);

  const tone = elapsed >= 90 ? 'red' : elapsed >= 30 ? 'yellow' : 'cyan';
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  const timeStr = mins > 0 ? `${mins}m${secs.toString().padStart(2, '0')}s` : `${secs}s`;

  return (
    <Box>
      <Text color={tone}>{SPINNER_FRAMES[frame]}</Text>
      <Text> </Text>
      <Text color={tone} bold>{step.label}</Text>
      <Text dimColor> · {timeStr}</Text>
      {elapsed >= 30 && elapsed < 90 && <Text color="yellow" dimColor> · still working</Text>}
      {elapsed >= 90 && <Text color="red" dimColor> · long op (Ctrl+C cancels, /bg current to background)</Text>}
    </Box>
  );
}

function ToolStepsView({ steps, viewMode, idle }: { steps: ToolStep[]; viewMode: 'balanced' | 'detailed'; idle?: boolean }) {
  // When idle (task complete), show a single compact summary line.
  // Full history is accessible via Ctrl+D (/log).
  if (idle) {
    const last = [...steps].reverse().find((s) => s.status === 'done' || s.status === 'error') ?? steps[steps.length - 1];
    if (!last) return null;
    const totalDone = steps.filter((s) => s.status === 'done').length;
    const icon = last.status === 'done' ? '✓' : last.status === 'error' ? '✗' : '·';
    const more = totalDone > 1 ? ` (+${totalDone - 1})` : '';
    return (
      <Box marginLeft={2} marginTop={1}>
        <Text dimColor>{icon} {last.label}{more} · Ctrl+D for details</Text>
      </Box>
    );
  }

  // Active: show at most 3 visible steps (running + last 2 done).
  // All other steps are collapsed into "N earlier" — no scrolling list.
  const MAX_VISIBLE = 3;
  const totalDone = steps.filter((s) => s.status === 'done').length;
  const doneSteps = steps.filter((s) => s.status === 'done');
  const runningSteps = steps.filter((s) => s.status === 'running');
  const hiddenCount = Math.max(0, steps.length - MAX_VISIBLE);
  const visible = [
    ...doneSteps.slice(-(MAX_VISIBLE - runningSteps.length)),
    ...runningSteps,
  ].slice(-MAX_VISIBLE);

  return (
    <Box flexDirection="column" marginLeft={2} marginTop={1}>
      <Box>
        <Text color="gray" bold>⏳</Text>
        <Text color="gray"> {totalDone} done{runningSteps.length > 0 ? `, ${runningSteps.length} running` : ''}</Text>
        {hiddenCount > 0 && <Text dimColor> · {hiddenCount} earlier</Text>}
      </Box>
      {visible.map((step) => {
        if (step.status === 'running') {
          return <RunningStepRow key={step.id} step={step} />;
        }
        return (
          <Box key={step.id}>
            <Text color="green">✓</Text>
            <Text dimColor> {step.label}</Text>
            {step.elapsed != null && <Text dimColor> ({step.elapsed.toFixed(1)}s)</Text>}
          </Box>
        );
      })}
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

  const currentAction = runningStep
    ? runningStep.label
    : (mode === 'coding' || mode === 'workspace') ? 'Analyzing code' : 'Composing response';

  const displayElapsed = runningStep?.startedAt
    ? Math.floor((Date.now() - runningStep.startedAt) / 1000) + (frame * 0)
    : elapsed;
  const actionTone = displayElapsed >= 90 ? 'red' : displayElapsed >= 30 ? 'yellow' : 'white';

  const mins = Math.floor(displayElapsed / 60);
  const secs = displayElapsed % 60;
  const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

  // Show at most 2 most recent completed steps (keeps total lines ≤ 3)
  const recentDone = doneSteps.slice(-2);

  return (
    <Box marginTop={1} marginLeft={2} flexDirection="column">
      <Box>
        <Text color={actionTone === 'white' ? 'cyan' : actionTone}>{spinner}</Text>
        <Text> </Text>
        <Text color="cyan" bold>{totalSteps > 0 ? 'Processing' : 'Processing'}</Text>
        <Text dimColor>{totalSteps > 0 ? ` · step ${totalSteps} · ${timeStr}` : ` · ${timeStr}`}</Text>
      </Box>
      <Box marginLeft={4}>
        <Text color={actionTone} bold>{currentAction}</Text>
        {displayElapsed >= 90 && <Text color="red" dimColor> · long op (Ctrl+C cancels, /bg current to background)</Text>}
      </Box>
      {recentDone.length > 0 && (
        <Box flexDirection="column" marginLeft={4} marginTop={0}>
          {recentDone.map((step) => (
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

// ─── Mercury Code (full-screen /code) ───────────────────────────────────────

/** Per-message transcript index entry: exact row count plus optional lines. */
interface MercuryCacheEntry {
  key: string;
  count: number;
  lines?: MercuryTranscriptLine[];
}
/**
 * Bounded transcript projection index. Counts are retained for every known
 * message (tiny numbers) so scroll math stays exact, but rendered lines are
 * kept only for a small LRU window around the viewport. Formatting work is
 * amortized: each message is built once per (content, width) revision.
 */
const mercuryTranscriptIndex = new Map<string, MercuryCacheEntry>();
const MERCURY_INDEX_MAX_ENTRIES = 4096;
const MERCURY_LINES_MAX_ENTRIES = 64;
const MERCURY_LINES_MAX_LINES = 6000;
let mercuryLineCacheEntries = 0;
let mercuryLineCacheLines = 0;

function mercuryCacheKey(msg: ChatMessage, width: number): string {
  return `${msg.id}|${msg.role}|${msg.content.length}|${msg.timestamp}|${msg.streaming ? 1 : 0}|${width}`;
}

function evictMercuryLineCache(): void {
  while ((mercuryLineCacheEntries > MERCURY_LINES_MAX_ENTRIES || mercuryLineCacheLines > MERCURY_LINES_MAX_LINES)) {
    const oldest = mercuryTranscriptIndex.keys().next().value;
    if (oldest === undefined) break;
    const entry = mercuryTranscriptIndex.get(oldest)!;
    if (entry.lines) {
      mercuryLineCacheLines -= entry.lines.length;
      mercuryLineCacheEntries -= 1;
      entry.lines = undefined;
      // Move the count-only entry to the end so line eviction progresses.
      mercuryTranscriptIndex.delete(oldest);
      mercuryTranscriptIndex.set(oldest, entry);
      continue;
    }
    if (mercuryLineCacheEntries === 0 && mercuryLineCacheLines === 0) break;
    break;
  }
  while (mercuryTranscriptIndex.size > MERCURY_INDEX_MAX_ENTRIES) {
    const oldest = mercuryTranscriptIndex.keys().next().value;
    if (oldest === undefined) break;
    const entry = mercuryTranscriptIndex.get(oldest)!;
    if (entry.lines) {
      mercuryLineCacheLines -= entry.lines.length;
      mercuryLineCacheEntries -= 1;
    }
    mercuryTranscriptIndex.delete(oldest);
  }
}

function getMercuryEntry(msg: ChatMessage, width: number, wantLines: boolean): MercuryCacheEntry {
  const key = mercuryCacheKey(msg, width);
  const existing = mercuryTranscriptIndex.get(msg.id);
  if (existing && existing.key === key) {
    if (existing.lines) {
      // LRU touch: refresh insertion order.
      mercuryTranscriptIndex.delete(msg.id);
      mercuryTranscriptIndex.set(msg.id, existing);
      return existing;
    }
    if (wantLines) {
      const lines = buildMercuryMessageLines(msg, width);
      existing.lines = lines;
      mercuryLineCacheEntries += 1;
      mercuryLineCacheLines += lines.length;
      evictMercuryLineCache();
    }
    return existing;
  }
  const lines = buildMercuryMessageLines(msg, width);
  const entry: MercuryCacheEntry = { key, count: lines.length };
  if (existing?.lines) {
    mercuryLineCacheLines -= existing.lines.length;
    mercuryLineCacheEntries -= 1;
  }
  entry.lines = lines;
  mercuryLineCacheEntries += 1;
  mercuryLineCacheLines += lines.length;
  mercuryTranscriptIndex.set(msg.id, entry);
  evictMercuryLineCache();
  return entry;
}

/** A message-count index used for exact scroll math without retaining text. */
export interface MercuryTranscriptIndex {
  msgs: ChatMessage[];
  counts: number[];
  total: number;
  /** Brand rows rendered before the first message (scroll away like a header). */
  brandLines: MercuryTranscriptLine[];
}

export function buildMercuryTranscriptIndex(
  messages: ChatMessage[],
  width: number,
  brandLines: MercuryTranscriptLine[] = [],
): MercuryTranscriptIndex {
  const msgs: ChatMessage[] = [];
  const counts: number[] = [];
  let total = brandLines.length;
  for (const msg of messages) {
    if (typeof msg.content !== 'string') continue;
    const entry = getMercuryEntry(msg, width, false);
    counts.push(entry.count);
    msgs.push(msg);
    total += entry.count;
  }
  return { msgs, counts, total, brandLines };
}

/** Format only the transcript rows inside [startRow, endRow). */
export function renderMercuryTranscriptWindow(
  index: MercuryTranscriptIndex,
  startRow: number,
  endRow: number,
  width: number,
): MercuryTranscriptLine[] {
  const out: MercuryTranscriptLine[] = [];
  // Brand block occupies the leading rows of the transcript.
  const brandCount = index.brandLines.length;
  if (startRow < brandCount && endRow > 0) {
    out.push(...index.brandLines.slice(startRow, Math.min(brandCount, endRow)));
  }
  let offset = brandCount;
  for (let i = 0; i < index.msgs.length; i++) {
    const count = index.counts[i];
    const msgStart = offset;
    const msgEnd = offset + count;
    offset = msgEnd;
    if (msgEnd <= startRow || msgStart >= endRow) continue;
    const entry = getMercuryEntry(index.msgs[i], width, true);
    const lines = entry.lines ?? [];
    const from = Math.max(0, startRow - msgStart);
    const to = Math.max(0, Math.min(count, endRow - msgStart));
    if (to > from) out.push(...lines.slice(from, to));
  }
  return out;
}

/**
 * Format a viewport range across the transcript PLUS the live streaming tail.
 *
 * The tail is a virtual block appended after the finalized transcript: it is
 * part of the scroll math (grand total = index.total + tail.length), so the
 * viewport slices across both naturally. Appending tail rows after a full
 * height window instead overflowed the fixed-height transcript box — bottom
 * rows clipped, scroll distances wrong, top messages seemingly trimmed.
 */
export function renderMercuryTranscriptRange(
  index: MercuryTranscriptIndex,
  tail: MercuryTranscriptLine[],
  startRow: number,
  endRow: number,
  width: number,
): MercuryTranscriptLine[] {
  const finalizedTotal = index.total;
  const out: MercuryTranscriptLine[] = [];
  if (startRow < finalizedTotal && endRow > 0) {
    out.push(...renderMercuryTranscriptWindow(index, startRow, Math.min(endRow, finalizedTotal), width));
  }
  if (endRow > finalizedTotal && tail.length > 0) {
    const from = Math.max(0, startRow - finalizedTotal);
    const to = Math.min(tail.length, endRow - finalizedTotal);
    if (to > from) out.push(...tail.slice(from, to));
  }
  return out;
}

const CODE_HINTS: Array<[string, string, string]> = [
  ['/code plan', 'analyze & propose before coding', 'ctrl+p'],
  ['/code execute', 'approve & implement the plan', 'ctrl+x'],
  ['/init', 'scan repo & write AGENTS.md', ''],
  ['/code diff', 'show working-tree diff', 'ctrl+g'],
  ['/code chat', 'switch back to regular chat', 'esc esc'],
  ['/code exit', 'leave Mercury Code (confirm)', 'ctrl+d'],
];

/** Live streaming tail budget: chars of the stream buffer rendered per frame. */
const STREAM_TAIL_CHARS = 8 * 1024;
/** Live streaming tail budget: max wrapped rows rendered per frame. */
const STREAM_TAIL_MAX_LINES = 40;

/**
 * Vibrant Mercury palette for the wordmark. Background-adaptive: on a dark
 * terminal cyan "MERCURY" contrasts with orange "CODE"; on a light
 * background the shades deepen instead of washing out.
 */
const WORDMARK_LIGHT_BG = (() => {
  const fgBg = process.env.COLORFGBG;
  if (!fgBg) return false;
  const parts = fgBg.split(';');
  const bgCode = Number(parts[parts.length - 1]);
  return !Number.isNaN(bgCode) && bgCode >= 10;
})();

// One solid color per word, background-adaptive. "CODE" is a whitish gray
// so the cyan "MERCURY" stays the visual anchor on any background.
const WORDMARK_COLORS = WORDMARK_LIGHT_BG
  ? { mercury: 'blue', code: '#c9cdd1' }
  : { mercury: 'cyanBright', code: '#c9cdd4' };

/** Centered three-column hint block (command · description · key), opencode-style. */
function MercuryCodeHints({ cols }: { cols: number }): React.ReactNode {
  const cmdW = Math.max(...CODE_HINTS.map((h) => h[0].length));
  const descW = Math.max(...CODE_HINTS.map((h) => h[1].length));
  const rowLen = cmdW + 2 + descW + 2 + 8;
  const indent = Math.max(0, Math.floor((cols - rowLen) / 2));
  return (
    <Box flexDirection="column" alignItems="flex-start" paddingLeft={indent} marginTop={2}>
      {CODE_HINTS.map(([cmd, desc, key]) => (
        <Box key={cmd}>
          <Text bold color="cyan">{cmd.padEnd(cmdW)}</Text>
          <Text>  </Text>
          <Text dimColor>{desc.padEnd(descW)}</Text>
          <Text>  </Text>
          <Text color="blue">{key}</Text>
        </Box>
      ))}
    </Box>
  );
}

/** Single active live-feedback block: phase + elapsed + running tool + done ticks + swarm. */
function MercuryLiveFeedback({ state }: { state: TuiState }): React.ReactNode {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const [frame, setFrame] = React.useState(0);
  const [, forceTick] = React.useState(0);
  const running = [...state.toolSteps].reverse().find((s) => s.status === 'running');
  const doneRecently = state.toolSteps.filter((s) => s.status === 'done').slice(-2);
  const activeAgents = state.subAgents.filter((a) => a.status === 'running' || a.status === 'paused');
  const activity = state.liveActivity;
  const active = Boolean(running || state.isThinking || doneRecently.length > 0 || activeAgents.length > 0 || activity);
  React.useEffect(() => {
    if (!active || state.mode !== 'mercury-code') return;
    // 100ms tick: smooth spinner AND a live seconds counter. The old 250ms
    // tick with no elapsed read as frozen during long tool calls.
    const t = setInterval(() => {
      setFrame((v) => (v + 1) % frames.length);
      forceTick((v) => v + 1);
    }, 100);
    return () => clearInterval(t);
  }, [active, state.mode]);
  if (state.mode !== 'mercury-code') return null;
  if (!active) return null;

  const elapsedSec = activity ? Math.floor((Date.now() - activity.startedAt) / 1000) : 0;
  const mins = Math.floor(elapsedSec / 60);
  const secs = elapsedSec % 60;
  const timeStr = mins > 0 ? `${mins}m${String(secs).padStart(2, '0')}s` : `${secs}s`;
  const phase = activity?.phase
    ?? (running
      ? running.label
      : state.isThinking
        ? (state.programmingMode === 'plan' ? 'Analyzing' : 'Working')
        : null);
  const detail = activity?.detail ?? null;
  const stepsDone = activity?.stepsDone ?? 0;

  return (
    <Box flexDirection="column" paddingX={2} flexShrink={0}>
      {phase && (
        <Box>
          <Text color="cyan">{frames[frame]}</Text>
          <Text> </Text>
          <Text color="cyan" bold>{phase}</Text>
          {stepsDone > 0 && <Text dimColor> · step {stepsDone}</Text>}
          <Text dimColor> · {timeStr}</Text>
          {detail && <Text dimColor> — {detail}</Text>}
        </Box>
      )}
      {running && (
        <Box paddingLeft={2}>
          <Text color="yellow">→ {running.label}</Text>
          {running.startedAt && <Text dimColor> ({Math.max(0, (Date.now() - running.startedAt) / 1000).toFixed(0)}s)</Text>}
        </Box>
      )}
      {doneRecently.map((step) => (
        <Box key={step.id} paddingLeft={2}>
          <Text color="green">✓</Text>
          <Text dimColor> {step.label}{step.elapsed != null ? ` (${step.elapsed.toFixed(1)}s)` : ''}</Text>
        </Box>
      ))}
      {activeAgents.length > 0 && (
        <React.Fragment>
          <Text color="magenta">  ⧖ swarm · {activeAgents.length} in parallel</Text>
          {activeAgents.slice(0, 4).map((a) => (
            <Box key={a.id}>
              <Text color="magenta">  {frames[(frame + a.id.length) % frames.length]}</Text>
              <Text> </Text>
              <Text color="magenta" bold>{a.id}</Text>
              <Text dimColor> {a.task.length > 44 ? a.task.slice(0, 41) + '…' : a.task}</Text>
            </Box>
          ))}
        </React.Fragment>
      )}
    </Box>
  );
}

/** Bordered input box (opencode-style) with mode-tinted prompt. */
function MercuryCodeInput({ input, cursorPos, mode, boxWidth }: { input: string; cursorPos: number; mode: ProgrammingModeState; boxWidth: number }) {
  const color = mode === 'execute' ? 'green' : mode === 'plan' ? 'yellow' : 'cyan';
  const lines = input.split('\n');
  let cursorLine = 0;
  let cursorCol = cursorPos;
  let consumed = 0;
  for (let i = 0; i < lines.length; i++) {
    if (consumed + lines[i].length >= cursorPos || i === lines.length - 1) {
      cursorLine = i;
      cursorCol = cursorPos - consumed;
      break;
    }
    consumed += lines[i].length + 1;
  }

  return (
    <Box paddingX={2} flexShrink={0}>
      <Box borderStyle="round" borderColor="gray" flexDirection="column" width={boxWidth} paddingX={1}>
        {lines.map((line, i) => (
          <Box key={i}>
            <Text bold color={color}>{i === 0 ? '> ' : '  '}</Text>
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
    </Box>
  );
}

function MercuryCodeExitConfirm({ boxWidth }: { boxWidth: number }): React.ReactNode {
  return (
    <Box paddingX={2} flexShrink={0}>
      <Box borderStyle="round" borderColor="yellow" width={boxWidth} paddingX={1}>
        <Text color="yellow" bold>Exit Mercury Code? </Text>
        <Text dimColor>Enter/Y exit · Esc/N stay · Ctrl+D force</Text>
      </Box>
    </Box>
  );
}

export function MercuryCodeView({
  state,
  height,
  cols,
  onInput,
  input,
  cursorPos,
  onScrollClamp,
}: {
  state: TuiState;
  height: number;
  cols: number;
  onInput: (text: string) => void;
  input?: string | undefined;
  cursorPos?: number | undefined;
  onScrollClamp?: (distance: number) => void;
}): React.ReactNode {
  const mc = state.mercuryCode;
  const contentWidth = Math.max(20, cols - 4);
  // Bounded projection: retain exact per-message row counts for scroll math
  // and format only the rows currently visible. No full-transcript flatten,
  // no 60k-line render cache. The brand block is the transcript's first rows,
  // centered across the terminal width, so new content scrolls it up and
  // away like a web page header.
  const brandLines = React.useMemo(() => buildMercuryBrandLines(state.version, cols), [state.version, cols]);
  // Streaming message exclusion: the streaming message's content grows on
  // every chunk, so including it in the memoized index would invalidate the
  // memo and re-run buildMercuryMessageLines (full markdown parse + wrap) on
  // the entire buffer each 60ms frame — O(frames × chars) churn that caused
  // multi-GB allocation storms during long streaming responses.
  const finalizedMessages = React.useMemo(
    () => state.chatMessages.filter((m) => !m.streaming && !m.id.startsWith('heartbeat-')),
    [state.chatMessages],
  );
  const streamingMessage = state.chatMessages.find((m) => m.streaming && !m.id.startsWith('heartbeat-'));
  const transcriptIndex = React.useMemo(
    () => buildMercuryTranscriptIndex(finalizedMessages, contentWidth, brandLines),
    [finalizedMessages, contentWidth, brandLines],
  );
  const totalLines = transcriptIndex.total;

  if (!mc) {
    return (
      <Box paddingX={1}>
        <Text color="yellow">Mercury Code is not active. Type /code to enter.</Text>
      </Box>
    );
  }

  // Row budget: the transcript owns the full screen height (brand rows are
  // part of the scrollable content); chrome is input, live feedback, exit
  // confirm, and the status line.
  const inputLines = Math.max(1, (input ?? '').split('\n').length);
  const inputRows = 2 + inputLines;
  const confirmRows = mc.exitConfirm ? 3 : 0;
  const liveVisible = state.isThinking || state.toolSteps.some((s) => s.status === 'running') || state.subAgents.some((a) => a.status === 'running');
  const liveRows = liveVisible
    ? 1 + Math.min(2, state.toolSteps.filter((s) => s.status === 'done').slice(-2).length) + (state.subAgents.some((a) => a.status === 'running') ? 1 + Math.min(4, state.subAgents.filter((a) => a.status === 'running').length) : 0)
    : 0;
  const statusRows = 1;
  const transcriptHeight = Math.max(3, height - inputRows - 1 - liveRows - confirmRows);

  // Live streaming tail: a bounded, fixed-cost projection of the stream
  // buffer (last STREAM_TAIL_CHARS, no markdown parsing). It participates in
  // the scroll math as a virtual block after the finalized transcript, so
  // the viewport slices across both — never appended on top of a full
  // window (that overflowed the box and clipped bottom rows).
  const streamTail = React.useMemo(() => {
    if (!streamingMessage) return [] as MercuryTranscriptLine[];
    const content = streamingMessage.content;
    const tail = content.length > STREAM_TAIL_CHARS ? content.slice(-STREAM_TAIL_CHARS) : content;
    const lines: MercuryTranscriptLine[] = [{ key: `${streamingMessage.id}:hdr`, kind: 'header', role: streamingMessage.role, text: 'MERCURY' }];
    for (const row of tail.split('\n')) {
      for (const chunk of wrapMercuryText(row, contentWidth)) {
        lines.push({ key: `${streamingMessage.id}:${lines.length}`, kind: 'text', role: streamingMessage.role, text: chunk });
        if (lines.length > STREAM_TAIL_MAX_LINES) {
          // Bound the block: keep the newest rows (replace header position).
          lines.splice(1, lines.length - STREAM_TAIL_MAX_LINES);
        }
      }
    }
    return lines;
  }, [streamingMessage, contentWidth]);
  const totalWithTail = totalLines + streamTail.length;

  const previousLineCount = React.useRef(totalWithTail);
  const anchoredOffset = anchorViewportDistance(mc.scrollOffset, previousLineCount.current, totalWithTail);

  // Sticky compact brand replaces the pixel wordmark once its rows scroll
  // away — the session header stays visible without consuming scroll space.
  // Its single row is reserved by shrinking the transcript box (below), and
  // the viewport height is reduced to match so rows are never clipped.
  const preliminaryViewport = getViewportWindow(totalWithTail, transcriptHeight, anchoredOffset);
  const wordmarkOnScreen = preliminaryViewport.start < brandLines.length;
  const effectiveViewportRows = wordmarkOnScreen ? transcriptHeight : transcriptHeight - 1;
  const viewport = getViewportWindow(totalWithTail, effectiveViewportRows, anchoredOffset);
  const adjustedVisible = renderMercuryTranscriptRange(transcriptIndex, streamTail, viewport.start, viewport.end, contentWidth);

  React.useEffect(() => {
    previousLineCount.current = totalWithTail;
    if (onScrollClamp && viewport.distanceFromBottom !== mc.scrollOffset) {
      onScrollClamp(viewport.distanceFromBottom);
    }
  }, [totalWithTail, onScrollClamp, mc.scrollOffset, viewport.distanceFromBottom]);

  // Status line (single row): left hint, right context.
  const mode = state.programmingMode;
  const modeLabel = mode === 'execute' ? 'EXECUTE' : mode === 'plan' ? 'PLAN' : 'CHAT';
  const modeColor = mode === 'execute' ? 'green' : mode === 'plan' ? 'yellow' : 'cyan';
  const git = mc.git;
  const gitBits: string[] = [];
  if (git.branch !== 'no-git') {
    gitBits.push(`⎇ ${git.branch}`);
    if (git.ahead > 0) gitBits.push(`↑${git.ahead}`);
    if (git.behind > 0) gitBits.push(`↓${git.behind}`);
    gitBits.push(git.dirty > 0 ? `±${git.dirty}` : '✓');
  }
  const rightParts = [mc.dirName, ...gitBits, modeLabel];
  if (state.provider) rightParts.push(`${state.provider.name} ${state.provider.model}`);
  const rightStr = rightParts.join(' · ');

  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      {!wordmarkOnScreen && (
        <Box paddingX={1} flexShrink={0}>
          <Text bold color="cyan">☿ MERCURY </Text>
          <Text bold color={WORDMARK_COLORS.code}>CODE</Text>
          <Text dimColor> v{state.version}</Text>
          <Text dimColor> · </Text>
          <Text dimColor>{mc.dirName}</Text>
        </Box>
      )}
      <Box flexDirection="column" height={effectiveViewportRows} overflow="hidden">
        {adjustedVisible.length === 0 && streamTail.length === 0 && totalWithTail === 0 ? (
          <MercuryCodeHints cols={cols} />
        ) : (
          adjustedVisible.map((line) => {
            const roleColor = line.role === 'user' ? 'yellow' : line.role === 'agent' ? 'cyan' : 'gray';
            if (line.kind === 'brand') {
              // Indent is baked into the text for exact centering.
              return (
                <Box key={line.key}>
                  {line.accent && line.accent.length > 0 ? (
                    <>
                      <Text bold color={WORDMARK_COLORS.mercury}>{line.text}</Text>
                      <Text bold color={WORDMARK_COLORS.code}>{line.accent}</Text>
                    </>
                  ) : (
                    <Text bold color="cyan">{line.text}</Text>
                  )}
                </Box>
              );
            }
            if (line.kind === 'spacer') {
              return <Box key={line.key} paddingX={2}><Text> </Text></Box>;
            }
            if (line.kind === 'header') {
              return (
                <Box key={line.key} paddingX={2}>
                  <Text bold color={roleColor}>● {line.text}</Text>
                </Box>
              );
            }
            if (line.kind === 'code-label') {
              return (
                <Box key={line.key} paddingX={2}>
                  <Text color={roleColor}>│ </Text><Text dimColor>┌─ {line.text}</Text>
                </Box>
              );
            }
            if (line.kind === 'code') {
              const highlighted = highlightCodeBlock(line.text, line.lang)[0] ?? line.text;
              return (
                <Box key={line.key} paddingX={2}>
                  <Text color={roleColor}>│ </Text><Text>{highlighted || ' '}</Text>
                </Box>
              );
            }
            if (line.kind === 'system') {
              const complete = line.text.startsWith('Task complete');
              return (
                <Box key={line.key} paddingX={2}>
                  <Text color={complete ? 'green' : 'gray'} bold={complete}>─ {line.text || ' '}</Text>
                </Box>
              );
            }
            if (line.kind === 'file') {
              return (
                <Box key={line.key} paddingX={2}>
                  <Text color="green">  ↳ </Text><Text>{line.text}</Text>
                </Box>
              );
            }
            return (
              <Box key={line.key} paddingX={2}>
                <Text color={roleColor}>│ </Text><Text>{line.text || ' '}</Text>
              </Box>
            );
          })
        )}
      </Box>
      <MercuryLiveFeedback state={state} />
      {mc.exitConfirm && <MercuryCodeExitConfirm boxWidth={Math.max(40, cols - 4)} />}
      <MercuryCodeInput input={input ?? ''} cursorPos={cursorPos ?? 0} mode={state.programmingMode} boxWidth={Math.max(40, cols - 4)} />
      <Box paddingX={3} flexShrink={0}>
        {viewport.distanceFromBottom > 0 ? (
          <Text color="yellow">SCROLLBACK · {viewport.distanceFromBottom} row{viewport.distanceFromBottom !== 1 ? 's' : ''} from live · ↑↓ move · PgUp/PgDn page · Ctrl+E live</Text>
        ) : (
          <Text dimColor>enter send · ↑/PgUp/Ctrl+U history · Ctrl+A oldest</Text>
        )}
        <Spacer />
        <Text color="blue" wrap="truncate-end">{rightStr}</Text>
      </Box>
    </Box>
  );
}
