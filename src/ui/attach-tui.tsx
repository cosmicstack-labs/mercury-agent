import React from 'react';
import { parseAttachHandoff } from './attach-handoff.js';
import { LaunchPad, launchPadRows } from './launch-pad.js';
import { useTick, spinnerFrame } from './tick-store.js';
import { rotateTip } from './tips.js';
import type { TuiState } from '../channels/cli.js';
import { Box, Text, Static, useApp, useInput } from 'ink';
import type { AttachClient, AttachEvent, AttachThread } from '../cli/attach.js';
import { renderMarkdown } from '../utils/markdown.js';
import { useTerminalSize } from './use-terminal-size.js';
import {
  SLASH_COMMANDS,
  buildSlashSuggestions,
  buildSkillSuggestions,
  skillFillText,
  shouldSubmitSlash,
  createInputHistoryState,
  pushHistoryLine,
  historyPrev,
  historyNext,
  applyEditKey,
  isPasteChunk,
  graphemeAt,
  nextGraphemeBoundary,
  expandTabs,
  type EditorKey,
  SuggestionList,
  type BotRosterEntry,
  type SkillEntry,
} from './input-composer.js';
import { CursorCell } from './cursor-anchor.js';
import { loadInputHistory, saveInputHistory } from './input-history-store.js';
import { activityLine, fitSegments, phaseFromStep, splitRow, statusSegments } from './status-bar.js';

/**
 * Attach TUI — the terminal face of `mercury attach`. Native scrollback
 * model (same as the main TUI): finalized messages print once through
 * <Static> into the terminal's own scrollback; only a small live region
 * (streaming tail, steps, prompt, input, status) repaints.
 *
 * Live events arrive over the runtime's SSE feed for the attached session;
 * the conversation history comes from the shared session repository, so
 * messages from other surfaces are visible as history (live mirroring of
 * other surfaces is out of scope in v1).
 *
 * Input is built on the SHARED input composer (src/ui/input-composer.tsx) —
 * the same slash/skill/bot suggestions, Enter-fill contract, and input
 * history as the main TUI's boot path. Previously the attach surface used a
 * bare character editor: no pickers, no history — the "close & relaunch
 * feels different, auto-commands don't work" regression.
 */

interface ThreadInfo {
  id: string;
  shortId: string;
  alias: string;
  title: string;
}

interface TranscriptMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface StepInfo {
  key: string;
  label: string;
  done: boolean;
}

const LOCAL_PERMISSION_MODE_PROMPT = 'local:permission-mode';

interface AttachPrompt {
  id: string;
  kind: 'permission' | 'continue' | 'choice';
  text: string;
  options: Array<{ value: string; label: string }>;
}

/** Live streaming tail budget: chars + rows, mirroring the main TUI's caps. */
const ATTACH_STREAM_TAIL_CHARS = 8 * 1024;
const ATTACH_STREAM_TAIL_MAX_LINES = 12;
/** Transient step lines kept in the live region. */
const ATTACH_STEP_WINDOW = 4;

/** Module-level identity — an inline arrow would remount <Static> dedup state each render. */
const attachItemKey = (message: TranscriptMessage): string => message.id;

function AttachMessageBlock({ message }: { message: TranscriptMessage }): React.ReactNode {
  const isUser = message.role === 'user';
  // A system note (the permission mode on entry) is one dim line, no header.
  if (message.role === 'system') {
    return (
      <Box flexDirection="column" marginBottom={1} paddingX={2} flexShrink={0}>
        {message.content.split('\n').map((line, idx) => (
          <Box key={`${message.id}:${idx}`} flexShrink={0}><Text dimColor>{line.length > 0 ? line : ' '}</Text></Box>
        ))}
      </Box>
    );
  }
  return (
    <Box flexDirection="column" marginBottom={1} flexShrink={0}>
      <Box flexShrink={0}>
        <Text bold color={isUser ? 'yellow' : 'cyan'}>
          {isUser ? 'YOU' : 'MERCURY'}:
        </Text>
      </Box>
      <Box marginLeft={2} flexDirection="column" flexShrink={0}>
        {(isUser ? message.content : renderMarkdown(message.content)).split('\n').map((line, idx) => (
          <Box key={`${message.id}:${idx}`} flexShrink={0}>
            <Text>{line.length > 0 ? line : ' '}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function AttachPromptView({ prompt, activeIdx }: { prompt: AttachPrompt; activeIdx: number }): React.ReactNode {
  return (
    <Box paddingX={1} flexShrink={0}>
      <Box borderStyle="round" borderColor="yellow" flexDirection="column" paddingX={1} flexShrink={0}>
        <Text color="yellow" bold>{prompt.kind === 'continue' ? 'Continue? ' : prompt.kind === 'choice' ? 'Choose ' : 'Permission: '}</Text>
        <Text wrap="truncate-end">{prompt.text}</Text>
        {prompt.options.map((option, idx) => (
          <Box key={option.value} paddingLeft={1}>
            <Text color={idx === activeIdx ? 'cyan' : 'gray'}>{idx === activeIdx ? '› ' : '  '}{option.label}</Text>
          </Box>
        ))}
        <Text dimColor> ↑↓ select · Enter confirm · Esc decline</Text>
      </Box>
    </Box>
  );
}

export function AttachTui({ client, pid, version, onExit, onHandoff }: { client: AttachClient; pid: number | null; version?: string; onExit: () => void; onHandoff?: (handoff: { kind: 'code'; dir?: string }) => void }): React.ReactNode {
  const { exit } = useApp();

  const [phase, setPhase] = React.useState<'pick' | 'chat'>('pick');
  const [threads, setThreads] = React.useState<ThreadInfo[]>([]);
  const [threadsLoaded, setThreadsLoaded] = React.useState(false);
  const [pickIdx, setPickIdx] = React.useState(0);

  const [thread, setThread] = React.useState<ThreadInfo | null>(null);
  const [history, setHistory] = React.useState<TranscriptMessage[]>([]);
  const [streamTail, setStreamTail] = React.useState('');
  const [streaming, setStreaming] = React.useState(false);
  const [steps, setSteps] = React.useState<StepInfo[]>([]);
  const [prompt, setPrompt] = React.useState<AttachPrompt | null>(null);
  const [promptIdx, setPromptIdx] = React.useState(0);
  const [provider, setProvider] = React.useState<{ name: string; model: string } | null>(null);
  const [tokenInfo, setTokenInfo] = React.useState<{ used: number; budget: number } | null>(null);
  // Live runtime status for the bottom bar (pushed by the runtime on every
  // model switch, mode or permission change, and checked every 2 s).
  const [runtimeStatus, setRuntimeStatus] = React.useState<{ mode: string; permission: string; desktop: string } | null>(null);
  const applyStatus = React.useCallback((raw: unknown) => {
    if (!raw || typeof raw !== 'object') return;
    const st = raw as Record<string, unknown>;
    if (typeof st.provider === 'string' && st.provider) setProvider({ name: st.provider, model: String(st.model ?? '') });
    const used = Number(st.tokensUsed); const budget = Number(st.tokenBudget);
    if (Number.isFinite(used) && Number.isFinite(budget) && budget > 0) setTokenInfo({ used, budget });
    setRuntimeStatus({ mode: String(st.mode ?? 'off'), permission: String(st.permission ?? ''), desktop: String(st.desktop ?? '') });
  }, []);
  const launchTip = React.useMemo(() => rotateTip('chat')?.tip ?? null, []);
  // One shared 100 ms ticker drives every spinner while something is in flight.
  // (A hook: it must run on every render, before the pick-screen return.)
  const busy = streaming || steps.some((s) => !s.done);
  const tick = useTick(busy);
  const frame = spinnerFrame(tick);
  // When the current turn started (for the elapsed counter in the status row).
  const turnStartedAt = React.useRef<number | null>(null);
  if (busy && turnStartedAt.current === null) turnStartedAt.current = Date.now();
  if (!busy) turnStartedAt.current = null;
  const [notice, setNotice] = React.useState<string | null>(null);

  const [input, setInput] = React.useState('');
  const [cursorPos, setCursorPos] = React.useState(0);
  // Same persisted history as the main TUI (~/.mercury/history).
  const [inputHistory, setInputHistory] = React.useState(() => createInputHistoryState(loadInputHistory()));

  // ── Shared-composer suggestion state (main-TUI parity) ──
  const [skills, setSkills] = React.useState<SkillEntry[]>([]);
  const [bots, setBots] = React.useState<BotRosterEntry[]>([]);

  React.useEffect(() => {
    client.listThreads()
      .then((list) => { setThreads(list.slice(0, 12)); setThreadsLoaded(true); })
      .catch(() => setThreadsLoaded(true));
  }, [client]);

  // Picker data sources — the same endpoints the web dashboard uses.
  React.useEffect(() => {
    let cancelled = false;
    client.listSkills().then((list) => { if (!cancelled) setSkills(list); }).catch(() => {});
    // Launch pad rows: real state from the runtime, same as the main TUI.
    client.currentModel().then((m) => { if (!cancelled && m) setProvider(m); }).catch(() => {});
    client.budget().then((b) => { if (!cancelled && b) setTokenInfo({ used: b.used, budget: b.budget }); }).catch(() => {});
    client.listBots().then((list) => { if (!cancelled) setBots(list); }).catch(() => {});
    return () => { cancelled = true; };
  }, [client]);

  // ── Shared-composer suggestion lists ──
  const slashSuggestions = React.useMemo(
    () => buildSlashSuggestions(input, SLASH_COMMANDS, bots),
    [input, bots],
  );
  const skillSuggestions = React.useMemo(
    () => buildSkillSuggestions(input, skills),
    [input, skills],
  );

  // Skill rows render as "#name" strings in the shared popup (descriptions
  // come from the shared SuggestionList's skill mode).
  const skillSuggestionStrings = React.useMemo(
    () => skillSuggestions.map((s) => `#${s.name}`),
    [skillSuggestions],
  );

  const [slashSelIdx, setSlashSelIdx] = React.useState(0);
  React.useEffect(() => { setSlashSelIdx(0); }, [slashSuggestions.length, input]);
  const [skillSelIdx, setSkillSelIdx] = React.useState(0);
  React.useEffect(() => { setSkillSelIdx(0); }, [skillSuggestions.length, input]);

  // Same input width as the main TUI's chat/Code input (App.tsx).
  const terminalSize = useTerminalSize();
  const inputWidth = Math.max(12, terminalSize.cols - 4);
  // The pick screen must fit the terminal: pad + 3 header rows + the list
  // (new-session row, sessions, maybe a "… more" row) + the key hint. On a
  // short terminal the tip goes first, then sessions fold into "… N more".
  const pickTip = terminalSize.rows - launchPadRows(terminalSize.cols, launchTip) - 5 >= 3 ? launchTip : null;
  const pickThreads = React.useMemo(() => {
    const free = terminalSize.rows - launchPadRows(terminalSize.cols, pickTip) - 5; // header(3) + new row + hint
    if (threads.length <= free) return threads;
    return threads.slice(0, Math.max(1, free - 1)); // leave a row for "… N more"
  }, [threads, terminalSize.rows, terminalSize.cols, pickTip]);

  // Live event stream for the attached session.
  React.useEffect(() => {
    if (!thread) return;
    const controller = new AbortController();
    const localEcho = (role: TranscriptMessage['role'], content: string): string => {
      const id = `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      setHistory((prev) => [...prev, { id, role, content }]);
      return id;
    };

    void client.streamEvents(thread.id, (event: AttachEvent) => {
      switch (event.type) {
        case 'connected':
          setProvider({
            name: String(event.data.provider ?? ''),
            model: String(event.data.model ?? ''),
          });
          applyStatus(event.data.status);
          setNotice(null);
          break;
        case 'status':
          applyStatus(event.data);
          break;
        case 'session_switched': {
          // /new, /session <ref> or a deleted current session re-bound this
          // screen: follow it, or every reply from now on goes somewhere we
          // are not listening and the spinner never stops.
          const id = String(event.data.id ?? '');
          if (!id || id === thread.id) break;
          setStreaming(false);
          setStreamTail('');
          setSteps([]);
          setThread({
            id,
            shortId: String(event.data.shortId ?? id.slice(0, 8)),
            alias: String(event.data.alias ?? 'session'),
            title: String(event.data.title ?? ''),
          });
          break;
        }
        case 'provider':
          // The model that actually answered this turn (fallbacks included).
          if (event.data.name) setProvider({ name: String(event.data.name), model: String(event.data.model ?? '') });
          break;
        case 'thinking':
          setStreaming(true);
          break;
        case 'text_delta': {
          const chunk = String(event.data.text ?? '');
          if (chunk) setStreamTail((prev) => (prev + chunk).slice(-ATTACH_STREAM_TAIL_CHARS));
          setStreaming(true);
          break;
        }
        case 'text_done': {
          const fullText = String(event.data.fullText ?? '');
          if (fullText) localEcho('assistant', fullText);
          setStreamTail('');
          setStreaming(false);
          setSteps([]);
          break;
        }
        case 'step_start':
          setSteps((prev) => [...prev.slice(-(ATTACH_STEP_WINDOW - 1)), {
            key: `step_${String(event.data.step ?? prev.length)}`,
            label: String(event.data.label ?? event.data.tool ?? 'working'),
            done: false,
          }]);
          break;
        case 'step_done':
          // Steps arrive in order: mark the oldest still-running one done.
          setSteps((prev) => {
            const next = [...prev];
            const running = next.findIndex((step) => !step.done);
            if (running !== -1) next[running] = { ...next[running], done: true };
            return next.slice(-ATTACH_STEP_WINDOW);
          });
          break;
        case 'permission_request':
          setPrompt({
            kind: 'permission',
            id: String(event.data.id ?? ''),
            text: String(event.data.prompt ?? ''),
            options: (Array.isArray(event.data.options) ? event.data.options as string[] : ['yes', 'no']).map((value) => ({ value, label: value })),
          });
          setPromptIdx(0);
          break;
        case 'permission_continue':
          setPrompt({
            kind: 'continue',
            id: String(event.data.id ?? ''),
            text: String(event.data.question ?? ''),
            options: (Array.isArray(event.data.options) ? event.data.options as string[] : ['yes', 'no']).map((value) => ({ value, label: value })),
          });
          setPromptIdx(0);
          break;
        case 'choice_prompt':
          setPrompt({
            kind: 'choice',
            id: String(event.data.id ?? ''),
            text: String(event.data.question ?? ''),
            options: (Array.isArray(event.data.options) ? event.data.options as Array<{ value: string; label: string }> : []).map((o) => ({ value: o.value, label: o.label ?? o.value })),
          });
          setPromptIdx(0);
          break;
        case 'permission_resolved':
        case 'choice_resolved':
          setPrompt((current) => current && String(event.data.id ?? '') === current.id ? null : current);
          break;
        case 'error':
          setNotice(`⚠ ${String(event.data.message ?? 'agent error')}`);
          setStreaming(false);
          break;
        case 'attach_disconnected':
          setNotice('connection lost — reconnecting…');
          setStreaming(false);
          break;
        case 'attach_auth_error':
          setNotice('⚠ runtime restarted (attach token rotated) — run `mercury attach` again');
          setStreaming(false);
          break;
        default:
          break;
      }
    }, controller.signal);

    return () => controller.abort();
  }, [client, thread?.id]);

  const startThread = React.useCallback(async (picked: ThreadInfo | null) => {
    if (picked) {
      setThread(picked);
      const messages = await client.getThread(picked.id);
      // Transcript view: plain conversation messages only (skip command/echo records).
      setHistory(messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ id: m.id, role: m.role as TranscriptMessage['role'], content: m.content })));
    } else {
      // "New session": create it server-side so send + SSE target the same id.
      newSessionRef.current = true;
      const created = await client.createThread();
      setThread(created
        ? { id: created.id, shortId: created.shortId, alias: created.alias, title: created.title }
        : { id: '', shortId: '', alias: 'new session', title: 'New session' });
    }
    setPhase('chat');
  }, [client]);

  const sendInput = React.useCallback(async (text: string) => {
    if (!thread || !text.trim()) return;
    // Mercury Code needs this terminal, not the daemon's web channel.
    const handoff = parseAttachHandoff(text);
    if (handoff?.kind === 'notice') { setNotice(handoff.text); return; }
    if (handoff?.kind === 'code') { onHandoff?.(handoff); exit(); return; }
    const id = `a_local_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    setHistory((prev) => [...prev, { id, role: 'user', content: text }]);
    setStreaming(true);
    const result = await client.send(text, thread.id || undefined);
    if (!result.ok) {
      setNotice(`⚠ send failed: ${result.error ?? 'unknown error'}`);
      setStreaming(false);
      return;
    }
    if (result.sessionId && result.sessionId !== thread.id) {
      // The runtime routed this to another session (re-bound meanwhile):
      // follow it so its reply reaches this screen.
      const known = (await client.listThreads().catch(() => [] as ThreadInfo[])).find((t) => t.id === result.sessionId);
      setThread(known ?? { ...thread, id: result.sessionId, shortId: result.sessionId.slice(0, 8), alias: thread.id ? 'session' : 'new session', title: thread.title || 'New session' });
    }
  }, [client, thread, onHandoff, exit]);

  const resolvePrompt = React.useCallback(async (value: string) => {
    const active = prompt;
    if (!active) return;
    setPrompt(null);
    if (active.id === LOCAL_PERMISSION_MODE_PROMPT) {
      if (value === 'allow-all' || value === 'ask-me') {
        const ok = typeof client.setPermissionMode === 'function' ? await client.setPermissionMode(value) : false;
        // Saved: the status row shows the mode from now on, so no extra line
        // above the input saying the same thing. Only a failure is announced.
        if (ok) setRuntimeStatus((st) => ({ mode: st?.mode ?? 'off', permission: value, desktop: st?.desktop ?? '' }));
        else setNotice('⚠ could not save the permission mode — try /permissions');
      }
      return;
    }
    await client.resolvePermission(active.id, value);
  }, [client, prompt]);

  // Entering a chat. A NEW session (or no saved mode yet) asks for the
  // permission mode, the current one listed first so Enter keeps it; a
  // resumed session just says which mode is in effect, in one dim line.
  const askedModeRef = React.useRef(false);
  const newSessionRef = React.useRef(false);
  React.useEffect(() => {
    if (phase !== 'chat' || askedModeRef.current) return;
    askedModeRef.current = true;
    // Older runtimes (and test doubles) don't expose it: then nothing to ask.
    if (typeof client.permissionMode !== 'function') return;
    client.permissionMode().then((mode) => {
      if (mode === undefined) return;
      if (mode !== null) setRuntimeStatus((st) => ({ mode: st?.mode ?? 'off', permission: mode, desktop: st?.desktop ?? '' }));
      if (mode !== null && !newSessionRef.current) {
        setHistory((prev) => [...prev, {
          id: `a_mode_${Date.now().toString(36)}`,
          role: 'system',
          content: mode === 'allow-all'
            ? 'Allow All mode: Mercury acts without asking (blocked commands stay blocked) · /permissions to change'
            : 'Ask Me mode: Mercury asks before writing files or running commands · /permissions to change',
        }]);
        return;
      }
      const options = [
        { value: 'ask-me', label: 'Ask Me: confirm before writing files or running commands' },
        { value: 'allow-all', label: 'Allow All: just do it (blocked commands stay blocked)' },
      ];
      if (mode === 'allow-all') options.reverse();
      setPrompt((current) => current ?? {
        id: LOCAL_PERMISSION_MODE_PROMPT,
        kind: 'choice',
        text: mode
          ? `Permission mode for this session? (now: ${mode === 'allow-all' ? 'Allow All' : 'Ask Me'} — Enter keeps it)`
          : 'How should Mercury handle risky actions? (change any time with /permissions)',
        options,
      });
      setPromptIdx(0);
    }).catch(() => {});
  }, [phase, client]);

  useInput((ch, key) => {
    if (ch === '\u0003' || (key.ctrl && (key as any).name === 'c')) {
      // Detach only: the runtime keeps running.
      exit();
      return;
    }

    if (phase === 'pick') {
      if (threadsLoaded) {
        // Row 0 is "Start a new session" (the default), then recent sessions.
        const rows = pickThreads.length + 1;
        if (key.upArrow) setPickIdx((i) => Math.max(0, i - 1));
        else if (key.downArrow) setPickIdx((i) => Math.min(rows - 1, i + 1));
        else if (key.return) {
          if (pickIdx === 0) void startThread(null);
          else void startThread(pickThreads[pickIdx - 1]);
        } else if (key.escape) {
          exit();
        }
      }
      return;
    }

    // Chat phase — an active prompt owns the keyboard.
    if (prompt) {
      const lower = ch?.toLowerCase?.();
      if (prompt.kind === 'permission' && lower === 'y') { void resolvePrompt('yes'); return; }
      if (prompt.kind === 'permission' && lower === 'a') { void resolvePrompt('always'); return; }
      if ((prompt.kind === 'permission' || prompt.kind === 'continue') && lower === 'n') { void resolvePrompt('no'); return; }
      if (key.escape) {
        void resolvePrompt(prompt.kind === 'choice' ? '' : 'no');
        return;
      }
      if (key.upArrow) setPromptIdx((i) => Math.max(0, i - 1));
      else if (key.downArrow) setPromptIdx((i) => Math.min(prompt.options.length - 1, i + 1));
      else if (key.return) {
        const option = prompt.options[promptIdx] ?? prompt.options[0];
        if (option) void resolvePrompt(option.value);
      }
      return;
    }

    if (key.return && !isPasteChunk(ch)) {
      const trimmed = input.trim();
      if (!trimmed) return;
      // Same Enter-fill contract as the main TUI: when the slash picker is
      // showing and Enter was pressed with a non-exact input, FILL first.
      if (!shouldSubmitSlash(slashSuggestions, trimmed, slashSelIdx)) {
        const next = slashSuggestions[slashSelIdx] ?? trimmed;
        setInput(next);
        setCursorPos(next.length);
        return;
      }
      // Skill picker: first Enter fills `#name ` (keeps any typed remainder);
      // second Enter submits.
      if (skillSuggestions.length > 0) {
        const picked = skillSuggestions[skillSelIdx];
        const expected = picked ? `#${picked.name}` : '';
        if (picked && !trimmed.startsWith(expected + ' ') && trimmed !== expected) {
          const next = skillFillText(input, picked.name);
          setInput(next);
          setCursorPos(next.length);
          return;
        }
      }
      setInput('');
      setCursorPos(0);
      setInputHistory((prev) => {
        const next = pushHistoryLine(prev, trimmed);
        if (next !== prev) saveInputHistory(next.history);
        return next;
      });
      void sendInput(trimmed);
      return;
    }
    // ↑/↓ navigate suggestions when a picker is visible, else input history
    // (shell-style, same helpers as the main TUI).
    if (key.upArrow) {
      if (slashSuggestions.length > 0) {
        setSlashSelIdx((i) => (i > 0 ? i - 1 : slashSuggestions.length - 1));
        return;
      }
      if (skillSuggestions.length > 0) {
        setSkillSelIdx((i) => (i > 0 ? i - 1 : skillSuggestions.length - 1));
        return;
      }
      const h = historyPrev(inputHistory, input);
      setInputHistory(h.state);
      setInput(h.input);
      setCursorPos(h.input.length);
      return;
    }
    if (key.downArrow) {
      if (slashSuggestions.length > 0) {
        setSlashSelIdx((i) => (i < slashSuggestions.length - 1 ? i + 1 : 0));
        return;
      }
      if (skillSuggestions.length > 0) {
        setSkillSelIdx((i) => (i < skillSuggestions.length - 1 ? i + 1 : 0));
        return;
      }
      const h = historyNext(inputHistory);
      setInputHistory(h.state);
      setInput(h.input);
      setCursorPos(h.input.length);
      return;
    }
    if (key.tab) {
      if (input.startsWith('/') && slashSuggestions.length > 0) {
        const next = slashSuggestions[slashSelIdx] ?? input;
        setInput(next);
        setCursorPos(next.length);
      } else if (input.startsWith('#') && skillSuggestions.length > 0) {
        const picked = skillSuggestions[skillSelIdx];
        if (picked) {
          const next = skillFillText(input, picked.name);
          setInput(next);
          setCursorPos(next.length);
        }
      }
      return;
    }
    // Shared editing reducer (same pipeline as the main TUI): paste,
    // newline, grapheme-aware cursor moves and deletes, word moves.
    const edited = applyEditKey(input, cursorPos, ch, key as EditorKey);
    if (edited) {
      setInput(edited.input);
      setCursorPos(edited.cursorPos);
    }
  });

  if (phase === 'pick') {
    // The same launch pad the main TUI opens with (ADR-024 made attach the
    // default launch; the first screen must not get plainer for it).
    // Everything below the pad is budgeted to the terminal height: Ink drops
    // rows off the top when the output is taller than the screen, and the
    // wordmark was what went. Sessions beyond the budget fold into one line.
    const padState = {
      version: version ?? 'dev',
      agentName: 'Mercury',
      provider,
      skills,
      web: { enabled: true, port: Number(new URL(client.getBaseUrl()).port) || 6174 },
      tokenInfo: tokenInfo ? { used: tokenInfo.used, budget: tokenInfo.budget, percentage: tokenInfo.budget > 0 ? Math.round((tokenInfo.used / tokenInfo.budget) * 100) : 0 } : null,
    } as unknown as TuiState;
    const hidden = threads.length - pickThreads.length;
    const rowFor = (idx: number, label: React.ReactNode, title?: string) => (
      <Box key={`row:${idx}`}>
        <Text color={idx === pickIdx ? 'cyan' : 'gray'}>{idx === pickIdx ? '› ' : '  '}</Text>
        <Text bold={idx === pickIdx} color={idx === pickIdx ? 'white' : 'gray'}>{label}</Text>
        {title ? <Text dimColor> {title}</Text> : null}
      </Box>
    );
    return (
      <Box flexDirection="column" paddingX={1}>
        <LaunchPad state={padState} cols={terminalSize.cols} showDetails={false} tip={pickTip} />
        <Text bold color="cyan">⚿ Attached to the running Mercury</Text>
        {pid != null && <Text dimColor>runtime PID {pid} · Ctrl+C detaches (Mercury keeps running)</Text>}
        <Text> </Text>
        {!threadsLoaded ? (
          <Text dimColor>Loading sessions…</Text>
        ) : (
          [
            rowFor(0, 'Start a new session'),
            ...pickThreads.map((t, idx) => rowFor(idx + 1, `${t.alias} [${t.shortId}]`, t.title)),
            ...(hidden > 0 ? [<Text key="more" dimColor>  … {hidden} more · /sessions in the chat</Text>] : []),
          ]
        )}
        <Text dimColor>↑↓ select · Enter attach</Text>
      </Box>
    );
  }

  // What is happening now (spinner, phase, elapsed) is drawn in the chat,
  // above the input, where the reply will appear. The row under the input
  // (src/ui/status-bar.ts) is status only — where you are — fitted to the
  // width in priority order so a long model or session name never crowds
  // out the rest.
  const runningStep = [...steps].reverse().find((s) => !s.done);
  const live = activityLine({
    busy,
    phase: phaseFromStep(runningStep?.label, streamTail.length > 0),
    elapsedSec: turnStartedAt.current ? (Date.now() - turnStartedAt.current) / 1000 : 0,
    spinner: frame,
  });
  // Left: which session this is (alias, then its title). Right: mode,
  // budget, model — and Optimus while it is listening or working, which
  // outranks everything: it is the last segment the fit ever drops, and the
  // session shrinks to its alias to make room.
  const rowCols = Math.max(20, terminalSize.cols - 6);
  const desktopActive = Boolean(runtimeStatus?.desktop);
  const sessionLabel = !thread ? ''
    : desktopActive || !thread.title || thread.title === 'New session' ? `⚿ ${thread.alias}`
    : `⚿ ${thread.alias} · ${thread.title}`;
  // One continuous row, left-aligned: session first, then the status right
  // after it. Two halves pinned to opposite edges left a hole in the middle
  // on any wide terminal. The status gets what it needs first; the session
  // label takes what is left (shortened, or dropped on a very narrow row).
  const split = splitRow(rowCols, sessionLabel, desktopActive ? 0.25 : 0.45);
  const right = fitSegments(statusSegments({
    provider: provider && provider.name ? provider : null,
    permission: runtimeStatus?.permission === 'allow-all' || runtimeStatus?.permission === 'ask-me' ? runtimeStatus.permission : null,
    tokensPct: tokenInfo && tokenInfo.budget > 0 ? (tokenInfo.used / tokenInfo.budget) * 100 : null,
    codeMode: runtimeStatus?.mode ?? 'off',
    desktop: runtimeStatus?.desktop ?? '',
    session: null, // shown on the left instead
  }), split.right);
  const rightWidth = right.reduce((n, seg, i) => n + seg.text.length + (i > 0 ? 3 : 0), 0);
  const sessionRoom = rowCols - rightWidth - (right.length > 0 ? 3 : 0);
  const sessionText = sessionRoom >= 6
    ? (sessionLabel.length <= sessionRoom ? sessionLabel : sessionLabel.slice(0, sessionRoom - 1) + '…')
    : '';
  // The live tail looks exactly like the settled block it becomes: the same
  // MERCURY header and indent, the same markdown pass (an unclosed fence is
  // closed for rendering only). It used to be drawn with a cyan "│" bar that
  // vanished when the reply settled — the strip people saw in chat.
  const fenceSafeTail = (streamTail.match(/```/g) || []).length % 2 === 1 ? streamTail + '\n```' : streamTail;
  const tailLines = streamTail.length > 0 ? renderMarkdown(fenceSafeTail).split('\n').slice(-ATTACH_STREAM_TAIL_MAX_LINES) : [];

  return (
    <Box flexDirection="column" flexShrink={0}>
      <Static items={history} itemKey={attachItemKey}>
        {(message) => <AttachMessageBlock key={message.id} message={message} />}
      </Static>
      {tailLines.length > 0 && (
        <Box flexDirection="column" flexShrink={0}>
          <Box flexShrink={0}><Text bold color="cyan">MERCURY:</Text></Box>
          <Box marginLeft={2} flexDirection="column" flexShrink={0}>
            {tailLines.map((line, idx) => (
              <Box key={`t:${idx}`} flexShrink={0}>
                <Text>{line.length > 0 ? line : ' '}</Text>
              </Box>
            ))}
          </Box>
        </Box>
      )}
      {/* Finished steps with a ✓, then one live line: spinner, phase and
          elapsed time (cyan, yellow after 30 s, red after 90 s). Said here,
          in the chat, and nowhere else. */}
      {steps.some((step) => step.done) && (
        <Box flexDirection="column" paddingX={2} flexShrink={0}>
          {steps.filter((step) => step.done).map((step) => (
            <Box key={step.key}>
              <Text color="green">✓</Text>
              <Text dimColor> {step.label}</Text>
            </Box>
          ))}
        </Box>
      )}
      {busy && !prompt && (
        <Box paddingX={2} flexShrink={0}>
          <Text color={live.color}>{live.text}</Text>
        </Box>
      )}
      {prompt && <AttachPromptView prompt={prompt} activeIdx={promptIdx} />}
      {notice && (
        <Box paddingX={1} flexShrink={0}>
          <Text color="yellow" wrap="truncate-end">{notice}</Text>
        </Box>
      )}
      {/* Shared-composer pickers — identical behavior and visuals to the main TUI. */}
      {slashSuggestions.length > 0 && <SuggestionList kind="slash" suggestions={slashSuggestions} selectedIndex={slashSelIdx} />}
      {skillSuggestions.length > 0 && <SuggestionList kind="skill" suggestions={skillSuggestionStrings} selectedIndex={skillSelIdx} />}
      <Box paddingX={2} flexShrink={0}>
        {/* Explicit width, mirroring the main TUI's input: this box used to
            rely on Yoga cross-stretch, but its wrapper is direction='row'
            (ink's Box default), where stretch never applies — so the input
            rendered at content width (~5 cols) on every machine. */}
        <Box borderStyle="round" borderColor="gray" flexDirection="column" paddingX={1} width={inputWidth}>
          <Box>
            <Text bold color="cyan">&gt; </Text>
            <Text>{expandTabs(input.slice(0, cursorPos))}</Text>
            <CursorCell glyph={cursorPos < input.length ? expandTabs(graphemeAt(input, cursorPos)) : ' '} active={!prompt} />
            <Text>{expandTabs(input.slice(nextGraphemeBoundary(input, cursorPos)))}</Text>
          </Box>
        </Box>
      </Box>
      <Box paddingX={3} flexShrink={0} height={1} overflow="hidden">
        {/* One Text so the row can only ever be truncated, never wrapped
            onto a second (hidden) line that cut it off mid-way. */}
        <Text wrap="truncate-end">
          {sessionText && <Text color="blue">{sessionText}</Text>}
          {right.map((seg, idx) => (
            <React.Fragment key={`${seg.priority}:${idx}`}>
              {(idx > 0 || sessionText) && <Text color="gray"> · </Text>}
              <Text color={seg.color}>{seg.text}</Text>
            </React.Fragment>
          ))}
        </Text>
      </Box>
    </Box>
  );
}