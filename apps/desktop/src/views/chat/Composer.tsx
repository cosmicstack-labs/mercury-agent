import { ArrowUp, AudioLines, ChevronDown, Clapperboard, Gauge, Image as ImageIcon, Music, Paperclip, Shield, ShieldCheck, Square, Telescope, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cx } from "~/lib/cx";
import * as api from "~/api/mercury";
import type { ChatEffort, ImageAspect, ImageIntent, MediaModelsResponse, ModelsResponse, ReasoningChoice, ReasoningLevel } from "~/api/types";
import { usePermissionMode } from "~/app/permission";
import { useBots, useRuntimeState, useUi } from "~/app/store";
import { CommandPicker } from "./CommandPicker";
import { CommandChip } from "./CommandChip";
import { matchCommands, matchSkills, pickerMode, relevantCommands, setKnownCommands, type CommandEntry, type PickerItem, type SkillEntry } from "./picker";
import { startCall, useVoice } from "~/app/voice";
import { sendMessage, stopTurn, type CodeTurn } from "~/app/events";
import { useConversation, useConversationStore, type Surface } from "~/app/conversation";
import { Button } from "~/components/ui/Button";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "~/components/ui/Menu";
import { Tooltip } from "~/components/ui/Tooltip";
import { DictationNotice, MicButton, RecordingBar, joinText, useDictation } from "~/components/dictation/Dictation";

/**
 * One box. Enter sends, Shift+Enter breaks a line, Esc clears. Photos and
 * PDFs, TXT and Markdown come in by the paperclip, paste or drag-and-drop (up to 4, the
 * runtime's limit). The mic dictates: ✓ puts the words in, ↑ sends them. Below: the model and Ask Me / Allow All, one click each.
 * Focus shows as a soft ring on the whole box, never a line inside it.
 */
interface Pending {
  id: string;
  name: string;
  mime: string;
  size: number;
  data: string;
  preview: string | null;
}

const MAX_FILES = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_PDF_BYTES = 15 * 1024 * 1024;
const MAX_TEXT_BYTES = 256 * 1024;

export interface ComposerProps {
  surface: Surface;
  placeholder: string;
  /** Code turns carry their mode and folder; Chat turns carry nothing extra. */
  code?: CodeTurn;
  /** Shown left of send (e.g. the Code mode picker); replaces the model/approval pickers' slot order. */
  extra?: React.ReactNode;
  /** Block sending with this reason (e.g. no folder chosen). */
  blockedReason?: string;
  /** Terminal look (Mercury Code): monospace, a ">" prompt. */
  mono?: boolean;
  /** Text to place in the box (e.g. a clicked suggestion). */
  draft?: string | null;
  onDraftConsumed?: () => void;
  /** Shift+Tab cycles the mode; the chip shows it. */
  onCycleMode?: () => void;
  modeLabel?: string;
}

/** Loaded once per app run: the "/" commands and the "#" skills. */
let commandCache: CommandEntry[] | null = null;
let skillCache: SkillEntry[] | null = null;

export function Composer({ surface, placeholder, code, extra, blockedReason, mono, draft, onDraftConsumed, onCycleMode, modeLabel }: ComposerProps) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<Pending[]>([]);
  const [dragging, setDragging] = useState(false);
  const [sending, setSending] = useState(false);
  // Research the next message (one run, then back to off). Chat only.
  const [researchNext, setResearchNext] = useState<ResearchNext>("off");
  const [imageNext, setImageNext] = useState<ImageIntent | null>(null);
  const threadKey = useConversation((s) => s.activeId);
  useEffect(() => { setResearchNext("off"); }, [threadKey]);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const agent = useConversation((s) => s.agent);
  const stopping = useConversation((s) => s.stopping);
  const convStore = useConversationStore();
  const connected = useRuntimeState((s) => s.connected);
  const textRef = useRef(text);
  textRef.current = text;

  // "/" commands and "#" skills, as in the terminal: a list above the box while you type.
  /** A picked command or skill: a chip before the text, which holds only what follows it. */
  const [token, setToken] = useState<PickerItem | null>(null);
  const mode = token ? null : pickerMode(text);
  const [commands, setCommands] = useState<CommandEntry[]>(commandCache ?? []);
  const [skills, setSkills] = useState<SkillEntry[]>(skillCache ?? []);
  const bots = useBots((s) => s.bots);
  // The list also lets the chat draw earlier commands as chips: load it once, up front.
  useEffect(() => {
    if (!commandCache) void api.chat.commands().then((c) => { commandCache = c; setKnownCommands(c.map((x) => x.command)); setCommands(c); }).catch(() => {});
  }, []);
  useEffect(() => {
    if (mode === "command" && !commandCache) void api.chat.commands().then((c) => { commandCache = c; setKnownCommands(c.map((x) => x.command)); setCommands(c); }).catch(() => {});
    if (mode === "skill" && !skillCache) void api.skills.list().then((r) => { skillCache = r.skills; setSkills(r.skills); }).catch(() => {});
  }, [mode]);
  const items = useMemo<PickerItem[]>(
    () => (mode === "command" ? matchCommands(text, relevantCommands(commands, surface), bots) : mode === "skill" ? matchSkills(text, skills) : []),
    [mode, text, commands, skills, bots, surface],
  );
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => { setActive(0); }, [text]);
  /** Fill the box with a pick; a command that needs nothing more runs straight away when `run`. */
  function choose(item: PickerItem, run: boolean) {
    if (run && item.runs) { void submit(item.fill); return; }
    setToken(item);
    setText("");
    requestAnimationFrame(() => ref.current?.focus());
  }
  const dictation = useDictation((spoken, mode) => {
    const next = joinText(textRef.current, spoken);
    if (mode === "send") { void submit(next); return; }
    setText(next);
    requestAnimationFrame(() => { const el = ref.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } });
  });
  const recording = dictation.phase === "recording";
  const voiceAvailable = useVoice((s) => s.available && s.supported && !s.active);
  // Esc throws the take away, Enter sends it, while recording.
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); dictation.finish("cancel"); }
      else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); dictation.finish(canSendRef.current ? "send" : "insert"); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording]); // eslint-disable-line react-hooks/exhaustive-deps

  // An undone message comes back here, in place of what was typed.
  const undone = useConversation((s) => s.draft);
  useEffect(() => {
    if (undone == null) return;
    setText(undone);
    convStore.getState().setDraft(null);
    requestAnimationFrame(() => { const el = ref.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } });
  }, [undone, convStore]);

  useEffect(() => {
    if (draft == null) return;
    setText(draft);
    onDraftConsumed?.();
    requestAnimationFrame(() => { const el = ref.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } });
  }, [draft, onDraftConsumed]);

  // Fit the box to its text. Re-measured when the text changes AND when the
  // box's width changes or it becomes visible (a hidden view measures 0 and a
  // narrower layout wraps more lines), so text never runs under the controls.
  const fit = useCallback(() => {
    const el = ref.current;
    if (!el || el.offsetParent === null) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 26), 240)}px`;
  }, []);
  useLayoutEffect(fit, [text, files.length, fit]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => fit());
    ro.observe(el);
    if (el.parentElement) ro.observe(el.parentElement);
    return () => ro.disconnect();
  }, [fit]);

  // The cursor goes to the box when a chat opens (new or switched to) and when this view is shown,
  // so typing can start at once. Two frames: the view must have rendered (a hidden view can't take focus).
  const view = useUi((st) => st.view);
  const focusSoon = useCallback((force = false) => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const el = ref.current;
      if (!el || el.offsetParent === null) return;
      // Don't take the cursor from another field the owner is typing in (a search box, a dialog).
      const at = document.activeElement as HTMLElement | null;
      if (!force && at && at !== el && at !== document.body && (at.tagName === "INPUT" || at.tagName === "TEXTAREA" || at.isContentEditable)) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }));
  }, []);
  useEffect(() => {
    const on = (e: Event) => { if ((e as CustomEvent<{ surface: string }>).detail?.surface === surface) focusSoon(true); };
    window.addEventListener("mercury:focus-composer", on);
    return () => window.removeEventListener("mercury:focus-composer", on);
  }, [surface, focusSoon]);
  useEffect(() => { if (view === surface) focusSoon(); }, [view, surface, threadKey, focusSoon]);

  // ⌘L / Ctrl+L focuses the box from anywhere in the view.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "l") { e.preventDefault(); ref.current?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function addFiles(list: FileList | File[]) {
    setError(null);
    const incoming = Array.from(list);
    const room = MAX_FILES - files.length;
    if (incoming.length > room) setError(`Up to ${MAX_FILES} files per message.`);
    const accepted: Pending[] = [];
    for (const f of incoming.slice(0, Math.max(0, room))) {
      const isImage = f.type.startsWith("image/");
      const isPdf = f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf");
      const isText = /\.(txt|md|markdown)$/i.test(f.name);
      if (!isImage && !isPdf && !isText) { setError(`${f.name}: attach an image, PDF, TXT or Markdown file.`); continue; }
      const limit = isText ? MAX_TEXT_BYTES : isImage ? MAX_IMAGE_BYTES : MAX_PDF_BYTES;
      if (f.size > limit) { setError(`${f.name}: the limit is ${isText ? "256 KiB" : `${limit / 1048576} MB`}.`); continue; }
      const data = await readBase64(f);
      accepted.push({ id: crypto.randomUUID(), name: f.name, mime: isText ? (/\.txt$/i.test(f.name) ? "text/plain" : "text/markdown") : isImage ? f.type || "image/png" : "application/pdf", size: f.size, data, preview: isImage ? URL.createObjectURL(f) : null });
    }
    if (accepted.length) setFiles((cur) => [...cur, ...accepted]);
    ref.current?.focus();
  }

  function removeFile(id: string) {
    setFiles((cur) => {
      const gone = cur.find((f) => f.id === id);
      if (gone?.preview) URL.revokeObjectURL(gone.preview);
      return cur.filter((f) => f.id !== id);
    });
  }

  async function submit(override?: string) {
    let content = (override ?? (token ? `${token.fill}${text}` : text)).trim();
    if (surface === "chat" && researchNext !== "off" && !imageNext && content && !/^[/#]/.test(content)) content = `/research ${researchNext === "plan" ? "plan " : ""}${content}`;
    const media: ImageIntent | undefined = surface === "chat" && imageNext && content && !/^[/#]/.test(content) ? imageNext : undefined;
    if ((!content && files.length === 0) || sending) return;
    setSending(true);
    setError(null);
    try {
      await sendMessage(surface, content, files.map((f) => ({ name: f.name, data: f.data, mime: f.mime })), code, media);
      setText("");
      setToken(null);
      setResearchNext("off");
      setImageNext(null);
      for (const f of files) if (f.preview) URL.revokeObjectURL(f.preview);
      setFiles([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
      ref.current?.focus();
    }
  }

  const busy = agent === "thinking" || agent === "streaming" || agent === "working";
  // While Mercury works the send button is a stop button; typing a follow-up turns it back into send.
  // A chat waiting behind another's turn has nothing of its own to stop: Stop would stop the other chat.
  const waiting = useConversation((s) => s.waiting);
  const showStop = busy && !waiting && text.trim().length === 0 && files.length === 0;
  function stop() {
    setError(null);
    void stopTurn(convStore).catch((err) => setError(err instanceof Error ? `Couldn't stop: ${err.message}` : "Couldn't stop"));
  }
  const canSend = connected && !blockedReason && (text.trim().length > 0 || files.length > 0 || token !== null);
  const canSendRef = useRef(false);
  canSendRef.current = connected && !blockedReason;
  const pickerOpen = items.length > 0 && dismissed !== text && !recording && connected && !blockedReason;

  return (
    <div className="shrink-0 px-8 pb-6 pt-2">
      <div className="mx-auto w-full max-w-[780px]">
        {error && <div className="mb-2 px-1 text-sm text-red">{error}</div>}
        <DictationNotice d={dictation} className="mb-2" />
        <div
          onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragging(true); } }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files); }}
          className={cx(
            "relative rounded-[28px] border bg-surface transition-[border-color,box-shadow] duration-150",
            "shadow-[0_1px_2px_rgb(0_0_0/0.04),0_4px_16px_-8px_rgb(0_0_0/0.12)]",
            "focus-within:border-line-strong focus-within:shadow-[0_0_0_4px_rgb(var(--ink)/0.05),0_4px_16px_-8px_rgb(0_0_0/0.16)]",
            dragging ? "border-accent border-dashed" : "border-line",
            !connected && "opacity-70",
          )}
        >
          {pickerOpen && mode && <CommandPicker items={items} active={Math.min(active, items.length - 1)} mode={mode} onHover={setActive} onPick={(item) => choose(item, true)} />}
          {files.length > 0 && (
            <div className="flex flex-wrap gap-2 px-4 pt-4">
              {files.map((f) => (
                <span key={f.id} className="group flex h-12 items-center gap-2 rounded-xl border border-line bg-raised pl-1 pr-2 text-xs text-ink2">
                  {f.preview ? <img src={f.preview} alt="" className="h-10 w-10 rounded-md object-cover" /> : <span className="flex h-10 w-10 items-center justify-center rounded-md bg-red/10 font-mono text-2xs text-red">{f.mime === "application/pdf" ? "PDF" : f.mime === "text/markdown" ? "MD" : "TXT"}</span>}
                  <span className="max-w-[140px]">
                    <span className="block truncate text-ink">{f.name}</span>
                    <span className="block text-2xs text-ink4">{formatSize(f.size)}</span>
                  </span>
                  <button onClick={() => removeFile(f.id)} className="ml-1 rounded p-0.5 text-ink4 hover:text-ink" aria-label={`Remove ${f.name}`}><X size={14} /></button>
                </span>
              ))}
            </div>
          )}
          {recording ? (
            <div className="px-4 pb-1 pt-3"><RecordingBar d={dictation} canSend={connected && !blockedReason} /></div>
          ) : (
          <div className="flex">
          {mono && <span aria-hidden="true" className="pointer-events-none select-none pl-5 pt-4 font-mono text-md leading-[26px] text-accent">&gt;</span>}
          {token && <CommandChip label={token.label} kind={token.kind} onRemove={() => { setToken(null); ref.current?.focus(); }} className={mono ? "ml-2 mt-[15px]" : "ml-4 mt-[15px]"} />}
          <textarea
            ref={ref}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); void addFiles(e.clipboardData.files); } }}
            onKeyDown={(e) => {
              if (pickerOpen) {
                if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (a + 1) % items.length); return; }
                if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (a - 1 + items.length) % items.length); return; }
                if (e.key === "Tab" && !e.shiftKey) { e.preventDefault(); choose(items[active], false); return; }
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); choose(items[active], true); return; }
                if (e.key === "Escape") { e.preventDefault(); setDismissed(text); return; }
              }
              // The chip goes back to text on Backspace (to edit it) and away on Esc, like a token field.
              if (token && !text && e.key === "Backspace") { e.preventDefault(); setText(token.fill.trimEnd()); setToken(null); return; }
              if (token && !text && e.key === "Escape") { e.preventDefault(); setToken(null); return; }
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); }
              if (e.key === "Escape" && text) { e.preventDefault(); setText(""); }
              else if (e.key === "Escape" && busy) { e.preventDefault(); stop(); }
              if (e.key === "Tab" && e.shiftKey && onCycleMode) { e.preventDefault(); onCycleMode(); }
            }}
            placeholder={!connected ? "Waiting for Mercury…" : blockedReason ?? (researchNext !== "off" && !token ? "What should Mercury research?" : token ? (token.hint || (token.kind === "skill" ? "What should the skill do?" : "Add details, or press Enter")) : placeholder)}
            rows={1}
            disabled={!connected}
            className={cx("block max-h-[240px] w-full resize-none overflow-y-auto bg-transparent pb-1 pt-4 text-md leading-[26px] text-ink caret-accent placeholder:truncate placeholder:text-ink4", mono ? "pl-3 pr-5 font-mono text-[14.5px]" : token ? "pl-2.5 pr-5" : "px-5")}
            aria-label="Message"
          />
          </div>
          )}
          {/* One line, always: the model name gives way first, then the chips drop to their icons (base.css .composer-row). */}
          <div className="composer-row flex flex-nowrap items-center gap-1 px-3 pb-3 pt-1.5">
            <div className="flex min-w-0 flex-1 items-center gap-1">
            <Tooltip label="Attach images, PDFs, TXT or Markdown" side="top">
              <Button variant="ghost" size="md" icon onClick={() => picker.current?.click()} disabled={!connected || files.length >= MAX_FILES} aria-label="Attach">
                <Paperclip size={17} />
              </Button>
            </Tooltip>
            <input ref={picker} type="file" accept="image/*,application/pdf,.txt,.md,.markdown,text/plain,text/markdown" multiple hidden onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = ""; }} />
            {extra}
            {modeLabel && (
              <Tooltip label="Switch mode" shortcut="⇧⇥" side="top">
                <button onClick={onCycleMode} className="flex h-8 items-center gap-1.5 rounded-md px-2 font-mono text-sm text-cyan hover:bg-ink/[0.06]" aria-label="Switch mode">
                  <span className="text-ink4">mode</span> {modeLabel}
                </button>
              </Tooltip>
            )}
            <ModelPicker />
            {surface === "chat" && <ImageToggle value={imageNext} onChange={(v) => { setImageNext(v); if (v) setResearchNext("off"); ref.current?.focus(); }} />}
            {surface === "chat" && <ResearchToggle value={researchNext} onChange={(v) => { setResearchNext(v); if (v !== "off") setImageNext(null); ref.current?.focus(); }} />}
            {surface === "chat" && <ModePicker />}
            </div>
            {/* What Mercury is doing shows inside the chat, under the reply (TurnTimeline's status line), not here. */}
            <div className="flex shrink-0 items-center gap-1">
            {!recording && <MicButton d={dictation} disabled={!connected} />}
            {!recording && surface === "chat" && voiceAvailable && !text.trim() && files.length === 0 && !busy && (
              <Tooltip label="Talk to Mercury (voice call)" side="top">
                <Button variant="secondary" size="md" icon onClick={() => void startCall()} disabled={!connected} aria-label="Start a voice call" className="!rounded-full">
                  <AudioLines size={17} />
                </Button>
              </Tooltip>
            )}
            {recording || (surface === "chat" && voiceAvailable && !text.trim() && files.length === 0 && !busy) ? null : showStop ? (
              <Tooltip label={stopping ? "Stopping…" : "Stop"} shortcut="esc" side="top">
                <Button variant="primary" size="md" icon onClick={stop} disabled={stopping || !connected} aria-label="Stop" className="!rounded-full">
                  <Square size={13} className="fill-current" strokeWidth={0} />
                </Button>
              </Tooltip>
            ) : (
              <Tooltip label="Send" shortcut="↵" side="top">
                <Button variant="primary" size="md" icon onClick={() => void submit()} disabled={!canSend} loading={sending} aria-label="Send" className="!rounded-full">
                  <ArrowUp size={17} strokeWidth={2.4} />
                </Button>
              </Tooltip>
            )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/** How many models before the picker offers a search box. */
const SEARCH_FROM = 8;

function ModelPicker() {
  const [models, setModels] = useState<ModelsResponse | null>(null);
  const [query, setQuery] = useState("");
  const provider = useRuntimeState((s) => s.provider);
  const model = useRuntimeState((s) => s.model);
  const store = useConversationStore();
  const threadId = useConversation((s) => s.activeId);
  const pendingEffort = useConversation((s) => s.pendingEffort);
  const search = useRef<HTMLInputElement>(null);

  async function load() {
    try { setModels(await api.chat.models(threadId)); } catch { setModels(null); }
  }
  useEffect(() => { void load(); }, [provider, model, threadId]); // eslint-disable-line react-hooks/exhaustive-deps

  const label = models?.current?.label || model || provider || "Model";
  const all = models?.providers ?? [];
  const q = query.trim().toLowerCase();
  // Every word must match the name, the model id or the provider ("pro cloud", "gpt 5").
  const matches = (p: ModelsResponse["providers"][number]) => !q || q.split(/\s+/).every((w) => `${p.label} ${p.model} ${p.group}`.toLowerCase().includes(w));
  const shown = all.filter(matches);
  const groups = new Map<string, ModelsResponse["providers"]>();
  for (const p of shown) groups.set(p.group, [...(groups.get(p.group) ?? []), p]);
  const current = models?.current;
  return (
    <>
    <Menu
      side="top"
      className="flex w-[min(360px,calc(100vw-32px))] flex-col p-0"
      onOpenChange={(open) => {
        if (open) { setQuery(""); void load(); setTimeout(() => search.current?.focus(), 0); }
      }}
      trigger={
        <button className="flex h-8 min-w-0 items-center gap-1 rounded-md px-2 text-sm text-ink2 hover:bg-ink/[0.06] hover:text-ink" aria-label={`Model: ${label}`} title={label}>
          <span className="min-w-0 max-w-[200px] truncate">{label}</span>
          <ChevronDown size={12} className="shrink-0 text-ink4" />
        </button>
      }
    >
      {all.length >= SEARCH_FROM && (
        <div className="border-b border-line p-1.5">
          <input
            ref={search}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            // Typing goes to the box, not to the menu's jump-to-letter.
            onKeyDown={(e) => { if (e.key !== "ArrowDown" && e.key !== "Escape" && e.key !== "Tab") e.stopPropagation(); }}
            placeholder={`Search ${all.length} models`}
            aria-label="Search models"
            className="h-8 w-full rounded-md border border-line bg-bg px-2.5 text-sm text-ink outline-none placeholder:text-ink4 focus:border-accent"
          />
        </div>
      )}
      {/* At most this tall, whatever the screen: longer lists scroll. */}
      <div className="max-h-[min(420px,55vh)] overflow-y-auto overscroll-contain p-1">
        {[...groups.entries()].map(([group, list], gi) => (
          <div key={group}>
            {gi > 0 && <MenuSeparator />}
            <MenuLabel>{group}{list.length > 1 ? ` · ${list.length}` : ""}</MenuLabel>
            {list.map((p) => (
              <MenuItem key={`${p.name}:${p.model}`} selected={p.isCurrent} disabled={!p.available} hint={p.available ? undefined : "no key"} onSelect={() => { void api.chat.switchModel(p.name, p.model).then(load); }}>
                <span className="block truncate" title={p.model}>{p.label}</span>
              </MenuItem>
            ))}
          </div>
        ))}
        {all.length === 0 && <MenuItem disabled>No providers configured</MenuItem>}
        {all.length > 0 && shown.length === 0 && <MenuItem disabled>No model matches “{query}”</MenuItem>}
      </div>
      {(models?.notices?.length ?? 0) > 0 && (
        <div className="border-t border-line px-3 py-2 text-xs text-amber">
          {models!.notices!.map((n) => <p key={n}>{n}</p>)}
        </div>
      )}
    </Menu>
    {current && current.reasoningLevels?.length > 0 && (
      <EffortPicker
        effort={withPending(current.effort ?? fallbackEffort(current.reasoning), pendingEffort)}
        levels={current.reasoningLevels}
        modelLabel={current.label}
        onChat={(level) => {
          // A new chat has no thread yet: the pick waits for the first message (sendMessage).
          if (!threadId) { store.getState().setPendingEffort(level ?? undefined); return; }
          void api.chat.setEffort(threadId, level).catch(() => undefined).then(load);
        }}
        onDefault={(level) => {
          void api.chat.setReasoning(current.name, current.model, level === "auto" ? null : level).catch(() => undefined).then(load);
        }}
      />
    )}
    </>
  );
}

const EFFORT_LABEL: Record<ReasoningChoice, string> = { auto: "Auto", off: "Off", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };
const EFFORT_HINT: Partial<Record<ReasoningChoice, string>> = {
  auto: "the model decides",
  off: "answer straight away",
  low: "quick, light thinking",
  high: "thinks it through",
  xhigh: "for hard coding and agent work",
  max: "slowest, most thorough",
};

/** Older runtimes report only the model's level. */
function fallbackEffort(reasoning: ReasoningChoice | undefined): ChatEffort {
  const r = reasoning ?? "auto";
  return { effective: r, source: r === "auto" ? "auto" : "model", modelDefault: r, chat: null };
}

/** A pick made before the chat existed shows as this chat's. */
function withPending(effort: ChatEffort, pending: ReasoningChoice | undefined): ChatEffort {
  return pending ? { ...effort, chat: pending, effective: pending, source: "chat" } : effort;
}

/**
 * How hard the model thinks in this chat (#188). Picks apply to this chat
 * only; "Default" follows the model's own setting, which the last item
 * changes for every chat without a pick of its own. Shown only for models
 * that take an effort.
 */
function EffortPicker({ effort, levels, modelLabel, onChat, onDefault }: {
  effort: ChatEffort;
  levels: ReasoningLevel[];
  modelLabel: string;
  onChat: (level: ReasoningChoice | null) => void;
  onDefault: (level: ReasoningChoice) => void;
}) {
  const choices: ReasoningChoice[] = ["auto", ...levels];
  const own = effort.source === "chat" && effort.chat !== null;
  const shown = effort.effective === "auto" ? "Effort" : EFFORT_LABEL[effort.effective];
  return (
    <Menu
      side="top"
      trigger={
        <button
          className={cx("flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm hover:bg-ink/[0.06]", effort.effective === "auto" ? "text-ink3" : "text-ink2")}
          aria-label="Thinking effort"
          title={`${EFFORT_LABEL[effort.effective]} · ${own ? "this chat" : effort.source === "model" ? `${modelLabel} default` : "the model decides"}`}
        >
          <Gauge size={14} />
          <span className="chip-label">{shown}</span>
          {own && <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-label="set for this chat" />}
          <ChevronDown size={12} className="text-ink4" />
        </button>
      }
    >
      <MenuLabel>Thinking effort · this chat</MenuLabel>
      <MenuItem selected={!effort.chat} hint={EFFORT_LABEL[effort.modelDefault]} onSelect={() => onChat(null)}>Model default</MenuItem>
      {choices.map((level) => (
        <MenuItem key={level} selected={effort.chat === level} hint={EFFORT_HINT[level]} onSelect={() => onChat(level)}>
          {EFFORT_LABEL[level]}
        </MenuItem>
      ))}
      {effort.chatUnsupported && <MenuItem disabled>This model can't use the chat's pick; its default applies</MenuItem>}
      {own && effort.chat && effort.chat !== effort.modelDefault && (
        <>
          <MenuSeparator />
          <MenuItem onSelect={() => onDefault(effort.chat!)}>Make {EFFORT_LABEL[effort.chat]} the default for {modelLabel}</MenuItem>
        </>
      )}
    </Menu>
  );
}

const ASPECT_LABEL: Record<ImageAspect, string> = { square: "Square", landscape: "Landscape", portrait: "Portrait" };
const KIND_LABEL = { image: "Image", video: "Video", music: "Music" } as const;
const ASPECT_RATIO: Record<"image" | "video", Record<ImageAspect, string>> = {
  image: { square: "1:1", landscape: "3:2", portrait: "2:3" },
  video: { square: "1:1", landscape: "16:9", portrait: "9:16" },
};

/**
 * Create with the next message (ADR-042): an image, a video or music, made
 * by a real model (never an SVG). The models are the defaults in Settings →
 * AI → Media, or the best ones Mercury finds on your providers. Videos and
 * music take a while and arrive in the chat when ready.
 */
function ImageToggle({ value, onChange }: { value: ImageIntent | null; onChange: (v: ImageIntent | null) => void }) {
  const [info, setInfo] = useState<MediaModelsResponse | null>(null);
  const provider = useRuntimeState((s) => s.provider);
  // Asked again when the chat provider changes (a new provider may bring media models).
  useEffect(() => { void api.media.models().then(setInfo).catch(() => setInfo(null)); }, [provider]);
  const has = (k: "image" | "video" | "music") => info === null || (info[k]?.models.length ?? 0) > 0;
  const using = (k: "image" | "video" | "music") => {
    const i = info?.[k];
    if (!i) return null;
    return i.default?.available ? i.models.find((m) => m.ref === i.default!.ref)?.label ?? null : i.auto?.label ?? null;
  };
  // Short, so the row stays on one line: "Video 16:9", "Image 3:2", "Music".
  const label = value ? `${KIND_LABEL[value.kind]}${value.aspect ? ` ${ASPECT_RATIO[value.kind === "video" ? "video" : "image"][value.aspect]}` : ""}` : "Create";
  return (
    <Menu
      side="top"
      trigger={
        <button className={cx("flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm hover:bg-ink/[0.06]", value ? "bg-accent/10 text-accent" : "text-ink3")} aria-label={`Create: ${label}`} title={label} aria-pressed={!!value}>
          {value?.kind === "video" ? <Clapperboard size={14} /> : value?.kind === "music" ? <Music size={14} /> : <ImageIcon size={14} />}
          <span className="chip-label">{label}</span>
        </button>
      }
    >
      <MenuLabel>Your next message</MenuLabel>
      <MenuItem selected={!value} onSelect={() => onChange(null)}>Normal answer</MenuItem>
      <MenuSeparator />
      <MenuLabel>Image{using("image") ? ` · ${using("image")}` : ""}</MenuLabel>
      {(["square", "landscape", "portrait"] as ImageAspect[]).map((a) => (
        <MenuItem key={a} selected={value?.kind === "image" && value.aspect === a} disabled={!has("image")} onSelect={() => onChange({ kind: "image", aspect: a })}>{ASPECT_LABEL[a]}</MenuItem>
      ))}
      <MenuLabel>Video{using("video") ? ` · ${using("video")}` : ""}</MenuLabel>
      {(["landscape", "portrait"] as ImageAspect[]).map((a) => (
        <MenuItem key={a} selected={value?.kind === "video" && value.aspect === a} disabled={!has("video")} onSelect={() => onChange({ kind: "video", aspect: a })}>{ASPECT_LABEL[a]}</MenuItem>
      ))}
      <MenuItem selected={value?.kind === "music"} disabled={!has("music")} onSelect={() => onChange({ kind: "music" })}>
        Music{using("music") ? ` · ${using("music")}` : ""}
      </MenuItem>
      {info && !has("image") && !has("video") && !has("music") && (
        <MenuItem disabled hint="Settings → AI → Media">No media models on your providers</MenuItem>
      )}
    </Menu>
  );
}

type ResearchNext = "off" | "on" | "plan";

/** Research the next message: a full report from live sources, optionally with a plan to check first. */
function ResearchToggle({ value, onChange }: { value: ResearchNext; onChange: (v: ResearchNext) => void }) {
  const on = value !== "off";
  return (
    <Menu
      side="top"
      trigger={
        <button className={cx("flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm hover:bg-ink/[0.06]", on ? "bg-accent/10 text-accent" : "text-ink3")} aria-label="Research" title={value === "plan" ? "Research · plan first" : "Research"} aria-pressed={on}>
          <Telescope size={14} />
          <span className="chip-label">{value === "plan" ? "Research · plan" : "Research"}</span>
        </button>
      }
    >
      <MenuLabel>Your next message</MenuLabel>
      <MenuItem selected={value === "off"} onSelect={() => onChange("off")}>Normal answer</MenuItem>
      <MenuItem selected={value === "on"} onSelect={() => onChange("on")} hint="many sources, a full report">Deep research</MenuItem>
      <MenuItem selected={value === "plan"} onSelect={() => onChange("plan")} hint="check the questions first">Deep research, plan first</MenuItem>
    </Menu>
  );
}

function ModePicker() {
  const { allowAll: mode, setAllowAll } = usePermissionMode();
  const allowAll = mode === true;
  const set = setAllowAll;
  return (
    <Menu
      side="top"
      trigger={
        <button className={cx("flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm hover:bg-ink/[0.06]", allowAll ? "text-accent" : "text-amber")} aria-label="Approval mode" title={allowAll ? "Allow All" : "Ask Me"}>
          {allowAll ? <ShieldCheck size={13} /> : <Shield size={13} />}
          <span className="chip-label">{mode !== null ? (allowAll ? "Allow All" : "Ask Me") : "…"}</span>
        </button>
      }
    >
      <MenuLabel>Before acting</MenuLabel>
      <MenuItem selected={!allowAll} onSelect={() => void set(false)}>Ask Me — approve each risky step</MenuItem>
      <MenuItem selected={allowAll} onSelect={() => void set(true)}>Allow All — only MCP and sends still ask</MenuItem>
    </Menu>
  );
}
