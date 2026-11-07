import { Mic, MicOff, Pause, Square } from "lucide-react";
import { useEffect, useState } from "react";
import { OptimusFace } from "~/components/OptimusFace";
import { VoiceBars } from "~/components/indicators/Thinking";
import { PHASE_LABEL, phaseOf, type VoiceAction, type VoiceState } from "~/app/voice";
import { cx } from "~/lib/cx";

/**
 * The capsule that drops from the notch while Optimus is in a voice session:
 * its face, what it's doing, and Mute / Pause / Stop. It holds no
 * credentials — state arrives from the main window and controls go back to
 * it as events.
 */
export function NotchApp() {
  const [state, setState] = useState<VoiceState | null>(null);
  const [shown, setShown] = useState(false);
  const [hover, setHover] = useState(false);

  useEffect(() => {
    document.documentElement.classList.add("dark");
    document.body.style.background = "transparent";
    let off: (() => void) | null = null;
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      off = await listen<VoiceState>("voice-state", (e) => setState(e.payload));
    });
    const t = setTimeout(() => setShown(true), 30);
    return () => { off?.(); clearTimeout(t); };
  }, []);

  async function send(action: VoiceAction) {
    const { emitTo } = await import("@tauri-apps/api/event");
    await emitTo("main", "voice-control", { action });
  }

  const phase = state ? phaseOf(state) : "listening";
  const lastOwner = [...(state?.turns ?? [])].reverse().find((t) => t.role === "owner");
  const detail = state?.activity ?? (phase === "thinking" && lastOwner ? `“${lastOwner.text}”` : null);

  return (
    <div className="flex h-screen w-screen justify-center overflow-hidden bg-transparent">
      <div
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        className={cx(
          "flex h-[52px] w-full items-center gap-3 rounded-b-[22px] bg-black pl-3 pr-2 text-white shadow-[0_10px_30px_rgba(0,0,0,0.45)] transition-transform duration-300 ease-out",
          shown ? "translate-y-0" : "-translate-y-full",
        )}
        style={{ fontFamily: '"Geist Variable", system-ui, sans-serif' }}
      >
        <OptimusFace size={30} phase={phase} />
        <div className="min-w-0 flex-1 leading-tight">
          <div className="flex items-center gap-2 text-[13px] font-semibold">
            <span className={cx(phase === "muted" ? "text-white/50" : "text-white")}>{PHASE_LABEL[phase]}</span>
            {(phase === "listening" || phase === "speaking") && <VoiceBars tone={phase === "speaking" ? "cyan" : "accent"} />}
          </div>
          {detail && <div className="truncate text-[11.5px] text-white/60">{detail}</div>}
        </div>
        <div className={cx("flex items-center gap-1 transition-opacity", hover || phase !== "listening" ? "opacity-100" : "opacity-70")}>
          <CapsuleButton label={state?.muted ? "Unmute" : "Mute"} onClick={() => void send(state?.muted ? "unmute" : "mute")} active={state?.muted}>
            {state?.muted ? <MicOff size={15} /> : <Mic size={15} />}
          </CapsuleButton>
          <CapsuleButton label="Pause: stop what it's saying or doing" onClick={() => void send("interrupt")}>
            <Pause size={15} />
          </CapsuleButton>
          <CapsuleButton label="End the session" onClick={() => void send("stop")} danger>
            <Square size={13} fill="currentColor" />
          </CapsuleButton>
        </div>
      </div>
    </div>
  );
}

function CapsuleButton({ children, label, onClick, active, danger }: { children: React.ReactNode; label: string; onClick: () => void; active?: boolean; danger?: boolean }) {
  return (
    <button onClick={onClick} title={label} aria-label={label}
      className={cx("flex h-8 w-8 items-center justify-center rounded-full transition-colors",
        danger ? "bg-[#FF6B6B]/20 text-[#FF8A8A] hover:bg-[#FF6B6B]/35" : active ? "bg-white text-black" : "bg-white/10 text-white hover:bg-white/20")}>
      {children}
    </button>
  );
}
