import { Loader2, Square, Volume2, X } from "lucide-react";
import { useUi } from "~/app/store";
import { Button } from "~/components/ui/Button";
import { cx } from "~/lib/cx";
import { useReadAloud } from "./speech";

/** The speaker beside Copy: read this reply aloud, or stop. */
export function ReadAloudButton({ id, text }: { id: string; text: string }) {
  const mine = useReadAloud((s) => s.id === id);
  const phase = useReadAloud((s) => (s.id === id ? s.phase : null));
  const play = useReadAloud((s) => s.play);
  const stop = useReadAloud((s) => s.stop);
  const active = mine && (phase === "loading" || phase === "playing");
  return (
    <button
      onClick={() => (active ? stop() : play(id, text))}
      className={cx("flex h-6 items-center gap-1 rounded-md px-1.5 text-xs hover:bg-ink/[0.06] hover:text-ink", active ? "text-accent" : "text-ink4")}
      aria-label={active ? "Stop reading aloud" : "Read aloud"}
      aria-pressed={active}
    >
      {phase === "loading" ? <Loader2 size={13} className="animate-spin" /> : active ? <Square size={11} className="fill-current" /> : <Volume2 size={13} />}
      {active ? "Stop" : "Listen"}
    </button>
  );
}

/** Is this reply being read (keeps its actions visible while it plays)? */
export function useReadingThis(id: string): boolean {
  return useReadAloud((s) => s.id === id && s.phase !== null);
}

/** No speech service, or a failure: one line and a way forward, under the reply. */
export function ReadAloudNotice({ id }: { id: string }) {
  const phase = useReadAloud((s) => (s.id === id ? s.phase : null));
  const error = useReadAloud((s) => s.error);
  const dismiss = useReadAloud((s) => s.dismiss);
  const openSettings = useUi((s) => s.openSettings);
  if (phase !== "needs-setup" && phase !== "error") return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-amber/40 bg-amber/[0.06] px-3 py-2 text-xs text-ink2" role="alert">
      <Volume2 size={13} className="shrink-0 text-amber" />
      <span className="min-w-0 flex-1">
        {phase === "needs-setup" ? "Reading aloud needs a speech service. Add an OpenAI key under Models, or a Deepgram or ElevenLabs key under Voice." : error}
      </span>
      {phase === "needs-setup" && (
        <>
          <Button type="button" size="sm" variant="primary" onClick={() => { dismiss(); openSettings("models"); }}>Add OpenAI key</Button>
          <Button type="button" size="sm" variant="outline" onClick={() => { dismiss(); openSettings("voice"); }}>Voice settings</Button>
        </>
      )}
      <button type="button" onClick={dismiss} className="text-ink4 hover:text-ink" aria-label="Dismiss"><X size={13} /></button>
    </div>
  );
}
