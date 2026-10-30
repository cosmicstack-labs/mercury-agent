import { ArrowUp, Check, Mic, X } from "lucide-react";
import { useUi } from "~/app/store";
import { Button } from "~/components/ui/Button";
import { Spinner } from "~/components/ui/bits";
import { Tooltip } from "~/components/ui/Tooltip";
import { cx } from "~/lib/cx";
import { formatClock, useDictation, type FinishMode } from "./useDictation";

/**
 * Voice typing, ChatGPT-style. Click the mic and talk: the box shows your
 * voice as a moving wave with a timer. ✓ puts the words in the box, ↑ sends
 * them straight away (where the box can send), × throws the take away.
 * With no speech service set up, the mic says how to add one.
 */

export type Dictation = ReturnType<typeof useDictation>;

export function Waveform({ levels, className }: { levels: number[]; className?: string }) {
  return (
    <div className={cx("flex h-7 min-w-0 flex-1 items-center gap-[3px] overflow-hidden", className)} aria-hidden="true">
      {levels.map((l, i) => (
        <span key={i} className="w-[3px] shrink-0 rounded-full bg-ink/70 transition-[height] duration-75" style={{ height: `${Math.max(3, Math.round(l * 26))}px`, opacity: 0.35 + l * 0.65 }} />
      ))}
    </div>
  );
}

/** The mic button in its idle / starting / transcribing states. */
export function MicButton({ d, disabled, size = "md" }: { d: Dictation; disabled?: boolean; size?: "sm" | "md" }) {
  const busy = d.phase === "starting" || d.phase === "transcribing";
  return (
    <Tooltip label={d.phase === "transcribing" ? "Turning speech into text…" : "Dictate"} side="top">
      <Button type="button" variant="ghost" size={size} icon disabled={disabled || busy} onClick={() => void d.start()} aria-label="Dictate" className="!rounded-full">
        {busy ? <Spinner size={size === "sm" ? 12 : 15} /> : <Mic size={size === "sm" ? 14 : 17} />}
      </Button>
    </Tooltip>
  );
}

/** While recording: wave, timer, and what to do with the take. */
export function RecordingBar({ d, canSend, className }: { d: Dictation; canSend: boolean; className?: string }) {
  return (
    <div className={cx("flex min-w-0 items-center gap-2", className)} role="group" aria-label="Recording">
      <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-red" aria-hidden="true" />
      <Waveform levels={d.levels} />
      <span className="shrink-0 font-mono text-xs tabular-nums text-ink3" aria-live="off">{formatClock(d.seconds)}</span>
      <Tooltip label="Discard" shortcut="esc" side="top">
        <Button type="button" variant="ghost" size="md" icon onClick={() => d.finish("cancel")} aria-label="Discard recording" className="!rounded-full"><X size={16} /></Button>
      </Tooltip>
      <Tooltip label="Stop and put the words in the box" side="top">
        <Button type="button" variant={canSend ? "outline" : "primary"} size="md" icon onClick={() => d.finish("insert")} aria-label="Stop and insert text" className="!rounded-full"><Check size={16} strokeWidth={2.4} /></Button>
      </Tooltip>
      {canSend && (
        <Tooltip label="Stop and send" shortcut="↵" side="top">
          <Button type="button" variant="primary" size="md" icon onClick={() => d.finish("send")} aria-label="Stop and send" className="!rounded-full"><ArrowUp size={17} strokeWidth={2.4} /></Button>
        </Tooltip>
      )}
    </div>
  );
}

/** No speech service, a denied mic, or a failed transcription: one line and a way forward. */
export function DictationNotice({ d, className }: { d: Dictation; className?: string }) {
  const openSettings = useUi((s) => s.openSettings);
  if (d.phase !== "needs-setup" && d.phase !== "error") return null;
  return (
    <div className={cx("flex flex-wrap items-center gap-2 rounded-lg border border-amber/40 bg-amber/[0.06] px-3 py-2 text-xs text-ink2", className)} role="alert">
      <Mic size={13} className="shrink-0 text-amber" />
      <span className="min-w-0 flex-1">
        {d.phase === "needs-setup"
          ? "Voice typing needs a speech service. Add an OpenAI key under Models, or a Deepgram or ElevenLabs key under Voice."
          : d.error}
      </span>
      {d.phase === "needs-setup" && (
        <>
          <Button type="button" size="sm" variant="primary" onClick={() => { d.dismiss(); openSettings("models"); }}>Add OpenAI key</Button>
          <Button type="button" size="sm" variant="outline" onClick={() => { d.dismiss(); openSettings("voice"); }}>Voice settings</Button>
        </>
      )}
      <button type="button" onClick={d.dismiss} className="text-ink4 hover:text-ink" aria-label="Dismiss"><X size={13} /></button>
    </div>
  );
}

/**
 * For any text field: a small mic in its corner. Words are added at the end
 * of what's there. Put it inside a `relative` wrapper around the field.
 */
export function FieldMic({ value, onChange, disabled, className }: { value: string; onChange: (next: string) => void; disabled?: boolean; className?: string }) {
  const d = useDictation((text) => onChange(joinText(value, text)));
  if (d.phase === "recording") {
    return (
      <div className={cx("absolute inset-x-1 bottom-1 z-10 rounded-full border border-line bg-surface px-2 py-0.5 shadow-md", className)}>
        <RecordingBar d={d} canSend={false} />
      </div>
    );
  }
  return (
    <>
      <div className={cx("absolute bottom-1 right-1", className)}><MicButton d={d} disabled={disabled} size="sm" /></div>
      {(d.phase === "needs-setup" || d.phase === "error") && <DictationNotice d={d} className="absolute inset-x-0 top-full z-20 mt-1" />}
    </>
  );
}

/** Append dictated words to existing text with sensible spacing. */
export function joinText(existing: string, added: string): string {
  if (!existing.trim()) return added;
  return /\s$/.test(existing) ? existing + added : `${existing} ${added}`;
}

export type { FinishMode };
export { useDictation };
