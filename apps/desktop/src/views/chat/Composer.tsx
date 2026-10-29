import { ArrowUp, AudioLines, ChevronDown, Paperclip, Shield, ShieldCheck, Square, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cx } from "~/lib/cx";
import * as api from "~/api/mercury";
import type { ChatSettings, ModelsResponse } from "~/api/types";
import { useRuntimeState } from "~/app/store";
import { startCall, useVoice } from "~/app/voice";
import { sendMessage, stopTurn, type CodeTurn } from "~/app/events";
import { useConversation, useConversationStore, type Surface } from "~/app/conversation";
import { Button } from "~/components/ui/Button";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "~/components/ui/Menu";
import { Tooltip } from "~/components/ui/Tooltip";
import { DictationNotice, MicButton, RecordingBar, joinText, useDictation } from "~/components/dictation/Dictation";

/**
 * One box. Enter sends, Shift+Enter breaks a line, Esc clears. Photos and
 * PDFs come in by the paperclip, paste or drag-and-drop (up to 4, the
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

export function Composer({ surface, placeholder, code, extra, blockedReason, mono, draft, onDraftConsumed, onCycleMode, modeLabel }: ComposerProps) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<Pending[]>([]);
  const [dragging, setDragging] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const agent = useConversation((s) => s.agent);
  const stopping = useConversation((s) => s.stopping);
  const convStore = useConversationStore();
  const connected = useRuntimeState((s) => s.connected);
  const textRef = useRef(text);
  textRef.current = text;
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
      if (!isImage && !isPdf) { setError(`${f.name}: only images and PDFs can be attached.`); continue; }
      const limit = isImage ? MAX_IMAGE_BYTES : MAX_PDF_BYTES;
      if (f.size > limit) { setError(`${f.name} is ${Math.round(f.size / 1048576)} MB; the limit is ${limit / 1048576} MB.`); continue; }
      const data = await readBase64(f);
      accepted.push({ id: crypto.randomUUID(), name: f.name, mime: isImage ? f.type || "image/png" : "application/pdf", size: f.size, data, preview: isImage ? URL.createObjectURL(f) : null });
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
    const content = (override ?? text).trim();
    if ((!content && files.length === 0) || sending) return;
    setSending(true);
    setError(null);
    try {
      await sendMessage(surface, content, files.map((f) => ({ name: f.name, data: f.data, mime: f.mime })), code);
      setText("");
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
  const showStop = busy && text.trim().length === 0 && files.length === 0;
  function stop() {
    setError(null);
    void stopTurn(convStore).catch((err) => setError(err instanceof Error ? `Couldn't stop: ${err.message}` : "Couldn't stop"));
  }
  const canSend = connected && !blockedReason && (text.trim().length > 0 || files.length > 0);
  const canSendRef = useRef(false);
  canSendRef.current = connected && !blockedReason;

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
            "rounded-[28px] border bg-surface transition-[border-color,box-shadow] duration-150",
            "shadow-[0_1px_2px_rgb(0_0_0/0.04),0_4px_16px_-8px_rgb(0_0_0/0.12)]",
            "focus-within:border-line-strong focus-within:shadow-[0_0_0_4px_rgb(var(--ink)/0.05),0_4px_16px_-8px_rgb(0_0_0/0.16)]",
            dragging ? "border-accent border-dashed" : "border-line",
            !connected && "opacity-70",
          )}
        >
          {files.length > 0 && (
            <div className="flex flex-wrap gap-2 px-4 pt-4">
              {files.map((f) => (
                <span key={f.id} className="group flex h-12 items-center gap-2 rounded-xl border border-line bg-raised pl-1 pr-2 text-xs text-ink2">
                  {f.preview ? <img src={f.preview} alt="" className="h-10 w-10 rounded-md object-cover" /> : <span className="flex h-10 w-10 items-center justify-center rounded-md bg-red/10 font-mono text-2xs text-red">PDF</span>}
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
          <textarea
            ref={ref}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); void addFiles(e.clipboardData.files); } }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); }
              if (e.key === "Escape" && text) { e.preventDefault(); setText(""); }
              else if (e.key === "Escape" && busy) { e.preventDefault(); stop(); }
              if (e.key === "Tab" && e.shiftKey && onCycleMode) { e.preventDefault(); onCycleMode(); }
            }}
            placeholder={!connected ? "Waiting for Mercury…" : blockedReason ?? placeholder}
            rows={1}
            disabled={!connected}
            className={cx("block max-h-[240px] w-full resize-none overflow-y-auto bg-transparent pb-1 pt-4 text-md leading-[26px] text-ink caret-accent placeholder:truncate placeholder:text-ink4", mono ? "pl-3 pr-5 font-mono text-[14.5px]" : "px-5")}
            aria-label="Message"
          />
          </div>
          )}
          <div className="flex flex-wrap items-center gap-1 px-3 pb-3 pt-1.5">
            <Tooltip label="Attach images or PDFs" side="top">
              <Button variant="ghost" size="md" icon onClick={() => picker.current?.click()} disabled={!connected || files.length >= MAX_FILES} aria-label="Attach">
                <Paperclip size={17} />
              </Button>
            </Tooltip>
            <input ref={picker} type="file" accept="image/*,application/pdf" multiple hidden onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = ""; }} />
            {extra}
            {modeLabel && (
              <Tooltip label="Switch mode" shortcut="⇧⇥" side="top">
                <button onClick={onCycleMode} className="flex h-8 items-center gap-1.5 rounded-md px-2 font-mono text-sm text-cyan hover:bg-ink/[0.06]" aria-label="Switch mode">
                  <span className="text-ink4">mode</span> {modeLabel}
                </button>
              </Tooltip>
            )}
            <ModelPicker />
            {surface === "chat" && <ModePicker />}
            <div className="flex-1" />
            {busy ? (
              <span className="mr-2 text-xs text-ink4">{stopping ? "Stopping" : agent === "streaming" ? "Answering" : agent === "working" ? "Working" : "Thinking"}…</span>
            ) : text.length > 0 ? (
              <span className="mr-2 hidden text-2xs text-ink4 sm:inline">⇧↵ new line</span>
            ) : null}
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

function ModelPicker() {
  const [models, setModels] = useState<ModelsResponse | null>(null);
  const provider = useRuntimeState((s) => s.provider);
  const model = useRuntimeState((s) => s.model);

  async function load() {
    try { setModels(await api.chat.models()); } catch { setModels(null); }
  }
  useEffect(() => { void load(); }, [provider, model]);

  const label = models?.current?.label || model || provider || "Model";
  const groups = new Map<string, ModelsResponse["providers"]>();
  for (const p of models?.providers ?? []) {
    const list = groups.get(p.group) ?? [];
    list.push(p);
    groups.set(p.group, list);
  }

  return (
    <Menu
      side="top"
      trigger={
        <button className="flex h-8 items-center gap-1 rounded-md px-2 text-sm text-ink2 hover:bg-ink/[0.06] hover:text-ink" aria-label="Model">
          <span className="max-w-[180px] truncate">{label}</span>
          <ChevronDown size={12} className="text-ink4" />
        </button>
      }
    >
      {[...groups.entries()].map(([group, list], gi) => (
        <div key={group}>
          {gi > 0 && <MenuSeparator />}
          <MenuLabel>{group}</MenuLabel>
          {list.map((p) => (
            <MenuItem key={`${p.name}:${p.model}`} selected={p.isCurrent} disabled={!p.available} hint={p.available ? undefined : "no key"} onSelect={() => { void api.chat.switchModel(p.name, p.model).then(load); }}>
              {p.label}
            </MenuItem>
          ))}
        </div>
      ))}
      {groups.size === 0 && <MenuItem disabled>No providers configured</MenuItem>}
    </Menu>
  );
}

function ModePicker() {
  const [settings, setSettings] = useState<ChatSettings | null>(null);
  useEffect(() => { void api.chat.settings().then(setSettings).catch(() => setSettings(null)); }, []);
  const allowAll = settings?.bypassPermissions === true;
  async function set(next: boolean) {
    try { setSettings(await api.chat.updateSettings({ bypassPermissions: next })); } catch { /* keep */ }
  }
  return (
    <Menu
      side="top"
      trigger={
        <button className={cx("flex h-8 items-center gap-1.5 rounded-md px-2 text-sm hover:bg-ink/[0.06]", allowAll ? "text-accent" : "text-amber")} aria-label="Approval mode">
          {allowAll ? <ShieldCheck size={13} /> : <Shield size={13} />}
          {settings ? (allowAll ? "Allow All" : "Ask Me") : "…"}
        </button>
      }
    >
      <MenuLabel>Before acting</MenuLabel>
      <MenuItem selected={!allowAll} onSelect={() => void set(false)}>Ask Me — approve each risky step</MenuItem>
      <MenuItem selected={allowAll} onSelect={() => void set(true)}>Allow All — only MCP and sends still ask</MenuItem>
    </Menu>
  );
}
