import { Mic, MicOff, Pause, Square, Wrench, ShieldAlert } from "lucide-react";
import { useEffect, useRef } from "react";
import { useVoice, phaseOf, PHASE_LABEL, voiceControl } from "~/app/voice";
import { OptimusFace } from "~/components/OptimusFace";
import { Markdown } from "~/components/Markdown";
import { Button } from "~/components/ui/Button";
import { ThinkingDots, VoiceBars } from "~/components/indicators/Thinking";
import { cx } from "~/lib/cx";

/**
 * The live Optimus session, as a conversation: what you said, what it is
 * doing on the screen, approvals it asked for, what it answered — streaming
 * in as it happens. Controls in the header mirror the notch capsule.
 */
export function VoiceConversation() {
  const v = useVoice();
  const phase = phaseOf(v);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [v.turns.length, v.thinking, v.activity]);

  const duration = v.startedAt ? Math.max(0, Math.round(((v.endedAt ?? Date.now()) - v.startedAt) / 1000)) : 0;

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-[52px] shrink-0 items-center gap-3 border-b border-line px-4" data-tauri-drag-region>
        <OptimusFace size={28} phase={phase} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-base font-medium text-ink">
            Optimus
            <span className={cx("text-sm font-normal", v.active ? "text-accent" : "text-ink3")}>{v.active ? PHASE_LABEL[phase] : "Session ended"}</span>
            {(phase === "listening" || phase === "speaking") && <VoiceBars tone={phase === "speaking" ? "cyan" : "accent"} />}
          </div>
          <div className="text-xs text-ink4">{v.active ? "Voice session on this computer" : v.outcome ? `Ended · ${v.outcome}` : "Ended"} · {fmt(duration)}</div>
        </div>
        {v.active && (
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant={v.muted ? "primary" : "outline"} onClick={() => void voiceControl(v.muted ? "unmute" : "mute")}>{v.muted ? <MicOff size={14} /> : <Mic size={14} />}{v.muted ? "Unmute" : "Mute"}</Button>
            <Button size="sm" variant="outline" onClick={() => void voiceControl("interrupt")} title="Stop what it's saying or doing; keep listening"><Pause size={14} />Pause</Button>
            <Button size="sm" variant="danger" onClick={() => void voiceControl("stop")}><Square size={12} fill="currentColor" />End</Button>
          </div>
        )}
      </header>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[780px] flex-col gap-6 px-8 py-8">
          {v.turns.length === 0 && (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <OptimusFace size={72} phase={phase} />
              <p className="text-lg font-medium text-ink">{v.active ? "Listening. Just talk." : "No voice session yet."}</p>
              <p className="max-w-[420px] text-sm text-ink3">What you say and everything Optimus does on your screen appears here as it happens.</p>
            </div>
          )}
          {v.turns.map((t) => {
            if (t.role === "owner") return <div key={t.id} className="pl-10 pt-1"><p className="text-lg font-medium leading-[1.55] text-ink" data-selectable>{t.text}</p><span className="text-xs text-ink4">You, out loud · {time(t.at)}</span></div>;
            if (t.role === "activity") return <div key={t.id} className="flex items-center gap-2 pl-10 text-sm text-ink3"><Wrench size={13} aria-hidden="true" />{t.text}</div>;
            if (t.role === "approval") return <div key={t.id} className="ml-10 flex items-start gap-2 rounded-lg border border-amber/40 bg-amber/[0.06] px-3 py-2 text-sm text-ink"><ShieldAlert size={15} className="mt-0.5 shrink-0 text-amber" />Asked you: {t.text}</div>;
            if (t.role === "system") return <p key={t.id} className="pl-10 text-sm text-ink3">{t.text}</p>;
            return (
              <div key={t.id} className="flex gap-4">
                <OptimusFace size={24} className="mt-1" />
                <div className="min-w-0 flex-1"><Markdown text={t.text} /><span className="text-xs text-ink4">Said out loud · {time(t.at)}</span></div>
              </div>
            );
          })}
          {v.active && v.thinking && <ThinkingDots className="pl-10" label={v.activity ?? "Working on it"} />}
        </div>
      </div>
    </section>
  );
}

function fmt(s: number): string {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function time(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
