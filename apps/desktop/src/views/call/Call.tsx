import { ChevronDown, Maximize2, MessageSquareText, Mic, MicOff, Pause, PhoneOff, ScrollText, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { PHASE_LABEL, phaseOf, useCall, useVoice, voiceControl, type VoiceTurn } from "~/app/voice";
import { useUi } from "~/app/store";
import { openThread } from "~/app/events";
import { VoiceOrb } from "~/components/VoiceOrb";
import { Button } from "~/components/ui/Button";
import { Tooltip } from "~/components/ui/Tooltip";
import { cx } from "~/lib/cx";
import { IS_MAC } from "~/layout/EnvironmentBar";

/**
 * Calling mode. Full window: the living circles, what's being said as
 * captions, and three controls (mute, pause, end). Minimize and it becomes
 * a small pill in the corner while you use the app; the call keeps going
 * and its chat thread fills in live. The notch capsule still shows it when
 * the window is away.
 */

export function CallLayer() {
  const v = useVoice();
  const call = useCall();
  const show = v.active || call.starting || !!call.error;
  if (!show) return null;
  if (call.view === "full") return <CallScreen />;
  return v.active ? <CallPill /> : null;
}

function useClock(startedAt: number | null, active: boolean): string {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [active]);
  const secs = startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0;
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}

function openCallThread(threadId: string | null | undefined) {
  if (!threadId) return;
  useUi.getState().setView("chat");
  useUi.getState().setVoiceOpen(false);
  void openThread("chat", threadId);
}

function CallScreen() {
  const v = useVoice();
  const call = useCall();
  const phase = call.starting && !v.active ? "starting" : phaseOf(v);
  const clock = useClock(v.startedAt, v.active);
  const [transcript, setTranscript] = useState(false);
  const minimize = () => useCall.setState({ view: "mini" });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "Escape") { e.preventDefault(); if (call.error && !v.active) useCall.setState({ error: null }); else minimize(); }
      else if ((e.key === "m" || e.key === "M") && v.active && !e.metaKey && !e.ctrlKey) { e.preventDefault(); void voiceControl(v.muted ? "unmute" : "mute").catch(() => {}); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [v.active, v.muted, call.error]);

  const said = v.turns.filter((t) => t.role === "owner" || t.role === "mercury");
  const lastOwner = [...said].reverse().find((t) => t.role === "owner");
  const lastMercury = [...said].reverse().find((t) => t.role === "mercury");
  const label = phase === "starting" ? "Starting…" : v.activity && (phase === "working" || phase === "thinking") ? v.activity : PHASE_LABEL[phase as keyof typeof PHASE_LABEL] ?? "";

  return (
    <div className="fixed inset-0 z-[70] flex bg-bg/95 backdrop-blur-xl animate-fade-in" role="dialog" aria-label="Voice call">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* On a Mac the window buttons sit in this row: the title starts after them, centred on them. */}
        <div className={cx("flex shrink-0 items-center gap-2.5", IS_MAC ? "h-9 pl-[84px] pr-3" : "h-[52px] px-5")} data-tauri-drag-region>
          {v.active && <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-red" aria-hidden="true" />}
          <span className="text-sm font-medium text-ink" data-tauri-drag-region>Voice call</span>
          {v.active && <span className="font-mono text-xs tabular-nums text-ink3" data-tauri-drag-region>{clock}</span>}
          <span className="flex-1" data-tauri-drag-region />
          {v.threadId && (
            <Tooltip label="Open this call's chat" side="bottom">
              <Button size="sm" variant="ghost" onClick={() => { minimize(); openCallThread(v.threadId); }}><MessageSquareText size={14} /> Chat</Button>
            </Tooltip>
          )}
          <Tooltip label="Transcript" side="bottom">
            <Button size="sm" variant={transcript ? "outline" : "ghost"} icon onClick={() => setTranscript((x) => !x)} aria-label="Transcript" aria-pressed={transcript}><ScrollText size={15} /></Button>
          </Tooltip>
          <Tooltip label="Minimize (keeps the call going)" shortcut="esc" side="bottom">
            <Button size="sm" variant="ghost" icon onClick={minimize} aria-label="Minimize call"><ChevronDown size={17} /></Button>
          </Tooltip>
        </div>

        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 px-8">
          <VoiceOrb size={280} phase={phase} />
          <div className="flex min-h-[24px] items-center gap-2 text-base text-ink2" aria-live="polite">
            {label}
          </div>
          {call.error && !v.active ? (
            <div className="flex max-w-[480px] flex-col items-center gap-3 text-center">
              <p className="text-sm text-red">{call.error}</p>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => { useCall.setState({ error: null }); useUi.getState().openSettings("voice"); }}>Voice settings</Button>
                <Button size="sm" variant="ghost" onClick={() => useCall.setState({ error: null })}>Close</Button>
              </div>
            </div>
          ) : (
            <div className="flex w-full max-w-[640px] flex-col items-center gap-2 text-center">
              {lastOwner && <p className="line-clamp-2 text-sm text-ink3" key={`o${lastOwner.id}`}>{lastOwner.text}</p>}
              {lastMercury && <p className="line-clamp-3 text-lg leading-relaxed text-ink" key={`m${lastMercury.id}`}>{lastMercury.text}</p>}
              {!lastOwner && !lastMercury && v.active && <p className="text-sm text-ink4">Go ahead, I'm listening.</p>}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-center gap-4 pb-10 pt-4">
          {v.active && (
            <>
              <Tooltip label={v.muted ? "Unmute" : "Mute"} shortcut="M" side="top">
                <button onClick={() => void voiceControl(v.muted ? "unmute" : "mute").catch(() => {})} aria-label={v.muted ? "Unmute" : "Mute"} aria-pressed={v.muted}
                  className={cx("flex h-14 w-14 items-center justify-center rounded-full border transition-colors", v.muted ? "border-ink bg-ink text-bg" : "border-line bg-surface text-ink hover:bg-ink/[0.06]")}>
                  {v.muted ? <MicOff size={20} /> : <Mic size={20} />}
                </button>
              </Tooltip>
              {(v.speaking || v.working || v.thinking) && (
                <Tooltip label="Stop what it's saying or doing" side="top">
                  <button onClick={() => void voiceControl("interrupt").catch(() => {})} aria-label="Pause"
                    className="flex h-14 w-14 items-center justify-center rounded-full border border-line bg-surface text-ink hover:bg-ink/[0.06]"><Pause size={20} /></button>
                </Tooltip>
              )}
            </>
          )}
          <Tooltip label={v.active ? "End call" : "Close"} side="top">
            <button onClick={() => { if (v.active) void voiceControl("stop").catch(() => {}); useCall.setState({ starting: false, error: null, view: "mini" }); }}
              aria-label={v.active ? "End call" : "Close"} className="flex h-14 w-14 items-center justify-center rounded-full bg-red text-white hover:bg-red/90">
              {v.active || call.starting ? <PhoneOff size={20} /> : <X size={20} />}
            </button>
          </Tooltip>
        </div>
      </div>

      {transcript && <TranscriptPanel turns={v.turns} onClose={() => setTranscript(false)} />}
    </div>
  );
}

function TranscriptPanel({ turns, onClose }: { turns: VoiceTurn[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = ref.current; if (el) el.scrollTop = el.scrollHeight; }, [turns.length]);
  return (
    <aside className="flex w-[360px] shrink-0 flex-col border-l border-line bg-soft/80">
      <div className={cx("flex shrink-0 items-center justify-between px-4", IS_MAC ? "h-9" : "h-[52px]")} data-tauri-drag-region><span className="text-sm font-medium text-ink">Transcript</span>
        <button onClick={onClose} className="text-ink4 hover:text-ink" aria-label="Close transcript"><X size={15} /></button></div>
      <div ref={ref} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-6" data-selectable>
        {turns.length === 0 && <p className="text-sm text-ink4">Nothing said yet.</p>}
        {turns.map((t) => (
          <div key={t.id} className={cx("text-sm leading-relaxed",
            t.role === "owner" && "self-end rounded-2xl rounded-br-md bg-ink/[0.07] px-3 py-2 text-ink",
            t.role === "mercury" && "text-ink",
            t.role === "result" && "rounded-lg border border-line bg-surface px-3 py-2 text-xs text-ink2",
            (t.role === "activity" || t.role === "system") && "text-xs text-ink4",
            t.role === "approval" && "rounded-lg border border-amber/40 bg-amber/[0.06] px-3 py-2 text-xs text-ink2")}>
            {t.role === "result" && <span className="mb-1 block text-2xs uppercase tracking-wider text-ink4">Full answer</span>}
            {t.text}
          </div>
        ))}
      </div>
    </aside>
  );
}

function CallPill() {
  const v = useVoice();
  const phase = phaseOf(v);
  const clock = useClock(v.startedAt, v.active);
  const expand = () => useCall.setState({ view: "full" });
  return (
    <div className="fixed bottom-14 right-5 z-[65] flex items-center gap-2 rounded-full border border-line bg-surface/95 py-1.5 pl-1.5 pr-2 shadow-xl backdrop-blur animate-fade-in" role="region" aria-label="Voice call">
      <button onClick={expand} className="flex items-center gap-2 rounded-full pr-1" aria-label="Open the call">
        <VoiceOrb size={36} phase={phase} />
        <span className="flex flex-col text-left leading-tight">
          <span className="max-w-[160px] truncate text-xs font-medium text-ink">{v.activity && (phase === "working" || phase === "thinking") ? v.activity : PHASE_LABEL[phase]}</span>
          <span className="font-mono text-2xs tabular-nums text-ink3">{clock}</span>
        </span>
      </button>
      {v.threadId && (
        <Tooltip label="Open this call's chat" side="top">
          <Button size="sm" variant="ghost" icon onClick={() => openCallThread(v.threadId)} aria-label="Open the call's chat"><MessageSquareText size={14} /></Button>
        </Tooltip>
      )}
      <Tooltip label={v.muted ? "Unmute" : "Mute"} side="top">
        <Button size="sm" variant={v.muted ? "secondary" : "ghost"} icon onClick={() => void voiceControl(v.muted ? "unmute" : "mute").catch(() => {})} aria-label={v.muted ? "Unmute" : "Mute"}>
          {v.muted ? <MicOff size={14} /> : <Mic size={14} />}
        </Button>
      </Tooltip>
      <Tooltip label="Full screen" side="top">
        <Button size="sm" variant="ghost" icon onClick={expand} aria-label="Full screen"><Maximize2 size={13} /></Button>
      </Tooltip>
      <Tooltip label="End call" side="top">
        <button onClick={() => void voiceControl("stop").catch(() => {})} aria-label="End call" className="flex h-7 w-7 items-center justify-center rounded-full bg-red text-white hover:bg-red/90"><PhoneOff size={13} /></button>
      </Tooltip>
    </div>
  );
}
