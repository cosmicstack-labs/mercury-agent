import React from 'react';
import { Box, Text, Spacer, Static, useApp, useInput } from 'ink';
import type { AttachClient, AttachEvent, AttachThread, AttachThreadMessage } from '../cli/attach.js';
import { renderMarkdown } from '../utils/markdown.js';

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
  return (
    <Box flexDirection="column" marginBottom={1} flexShrink={0}>
      <Box flexShrink={0}>
        <Text bold color={isUser ? 'yellow' : message.role === 'system' ? 'gray' : 'cyan'}>
          {isUser ? 'YOU' : message.role === 'system' ? '—' : 'MERCURY'}:
        </Text>
      </Box>
      <Box marginLeft={2} flexDirection="column" flexShrink={0}>
        {(isUser || message.role === 'system' ? message.content : renderMarkdown(message.content)).split('\n').map((line, idx) => (
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

export function AttachTui({ client, pid, onExit }: { client: AttachClient; pid: number | null; onExit: () => void }): React.ReactNode {
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
  const [notice, setNotice] = React.useState<string | null>(null);

  const [input, setInput] = React.useState('');
  const [cursorPos, setCursorPos] = React.useState(0);

  React.useEffect(() => {
    client.listThreads()
      .then((list) => { setThreads(list.slice(0, 6)); setThreadsLoaded(true); })
      .catch(() => setThreadsLoaded(true));
  }, [client]);

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
          setNotice(null);
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
      const created = await client.createThread();
      setThread(created
        ? { id: created.id, shortId: created.shortId, alias: created.alias, title: created.title }
        : { id: '', shortId: '', alias: 'new session', title: 'New session' });
    }
    setPhase('chat');
  }, [client]);

  const sendInput = React.useCallback(async (text: string) => {
    if (!thread || !text.trim()) return;
    const id = `a_local_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    setHistory((prev) => [...prev, { id, role: 'user', content: text }]);
    setStreaming(true);
    const result = await client.send(text, thread.id || undefined);
    if (!result.ok) {
      setNotice(`⚠ send failed: ${result.error ?? 'unknown error'}`);
      setStreaming(false);
      return;
    }
    if (!thread.id && result.sessionId) {
      setThread({ ...thread, id: result.sessionId, alias: 'session', title: 'New session' });
    }
  }, [client, thread]);

  const resolvePrompt = React.useCallback(async (value: string) => {
    const active = prompt;
    if (!active) return;
    setPrompt(null);
    await client.resolvePermission(active.id, value);
  }, [client, prompt]);

  useInput((ch, key) => {
    if (ch === '' || (key.ctrl && (key as any).name === 'c')) {
      // Detach only: the runtime keeps running.
      exit();
      return;
    }

    if (phase === 'pick') {
      if (threadsLoaded && threads.length >= 0) {
        const rows = threads.length + 1; // threads + "new session"
        if (key.upArrow) setPickIdx((i) => Math.max(0, i - 1));
        else if (key.downArrow) setPickIdx((i) => Math.min(rows - 1, i + 1));
        else if (key.return) {
          if (pickIdx < threads.length) {
            void startThread(threads[pickIdx]);
          } else {
            void startThread(null);
          }
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

    if (key.return) {
      const trimmed = input.trim();
      if (trimmed) {
        setInput('');
        setCursorPos(0);
        void sendInput(trimmed);
      }
      return;
    }
    if (key.leftArrow) { setCursorPos((p) => Math.max(0, p - 1)); return; }
    if (key.rightArrow) { setCursorPos((p) => Math.min(input.length, p + 1)); return; }
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
  });

  if (phase === 'pick') {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="cyan">⚿ Attach to Mercury</Text>
        {pid != null && <Text dimColor>runtime PID {pid} · Ctrl+C cancels</Text>}
        <Text> </Text>
        {!threadsLoaded ? (
          <Text dimColor>Loading sessions…</Text>
        ) : (
          [
            ...threads.map((t, idx) => (
              <Box key={t.id}>
                <Text color={idx === pickIdx ? 'cyan' : 'gray'}>{idx === pickIdx ? '› ' : '  '}</Text>
                <Text bold={idx === pickIdx} color={idx === pickIdx ? 'white' : 'gray'}>
                  {t.alias} [{t.shortId}]
                </Text>
                <Text dimColor> {t.title}</Text>
              </Box>
            )),
            <Box key="__new__">
              <Text color={threads.length === pickIdx ? 'cyan' : 'gray'}>{threads.length === pickIdx ? '› ' : '  '}</Text>
              <Text bold={threads.length === pickIdx} color={threads.length === pickIdx ? 'white' : 'gray'}>Start a new session</Text>
            </Box>,
          ]
        )}
        <Text dimColor>↑↓ select · Enter attach</Text>
      </Box>
    );
  }

  const providerLabel = provider && provider.name ? `${provider.name}${provider.model ? ` ${provider.model}` : ''}` : 'connected';
  const tailLines = streamTail.length > 0 ? streamTail.split('\n').slice(-ATTACH_STREAM_TAIL_MAX_LINES) : [];

  return (
    <Box flexDirection="column" flexShrink={0}>
      <Static items={history} itemKey={attachItemKey}>
        {(message) => <AttachMessageBlock key={message.id} message={message} />}
      </Static>
      {tailLines.length > 0 && (
        <Box flexDirection="column" flexShrink={0}>
          {tailLines.map((line, idx) => (
            <Box key={`t:${idx}`} paddingX={2}>
              <Text color="cyan">│ </Text><Text>{line || ' '}</Text>
            </Box>
          ))}
        </Box>
      )}
      {steps.length > 0 && (
        <Box flexDirection="column" paddingX={2} flexShrink={0}>
          {steps.map((step) => (
            <Box key={step.key}>
              <Text color={step.done ? 'green' : 'cyan'}>{step.done ? '✓' : '→'}</Text>
              <Text dimColor> {step.label}</Text>
            </Box>
          ))}
        </Box>
      )}
      {streaming && tailLines.length === 0 && steps.length === 0 && (
        <Box paddingX={2} flexShrink={0}>
          <Text color="cyan">⠋</Text><Text dimColor> working…</Text>
        </Box>
      )}
      {prompt && <AttachPromptView prompt={prompt} activeIdx={promptIdx} />}
      {notice && (
        <Box paddingX={1} flexShrink={0}>
          <Text color="yellow">{notice}</Text>
        </Box>
      )}
      <Box paddingX={2} flexShrink={0}>
        <Box borderStyle="round" borderColor="gray" flexDirection="column" paddingX={1}>
          <Box>
            <Text bold color="cyan">&gt; </Text>
            <Text>{input.slice(0, cursorPos)}</Text>
            <Text inverse>{cursorPos < input.length ? input[cursorPos] : ' '}</Text>
            <Text>{input.slice(cursorPos + 1)}</Text>
          </Box>
        </Box>
      </Box>
      <Box paddingX={3} flexShrink={0}>
        <Text dimColor>↵ send · esc esc exit · ctrl+c detach</Text>
        <Spacer />
        <Text color="blue" wrap="truncate-end">⚿ {thread ? `${thread.alias} [${thread.shortId}]` : ''} · {providerLabel}{pid != null ? ` · PID ${pid}` : ''}</Text>
      </Box>
    </Box>
  );
}