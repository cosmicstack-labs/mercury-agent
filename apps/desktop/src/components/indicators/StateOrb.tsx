import { cx } from "~/lib/cx";
import type { AgentState } from "~/app/store";

/**
 * The one indicator of what the agent is doing. Same component in the
 * rail, the thread header, the bot roster and the tray tooltip text.
 *
 *  idle      quiet dot
 *  thinking  cyan dot with a slow ring
 *  streaming accent dot, steady
 *  working   accent ring, spinning (a tool is running)
 *  needs-you amber dot, pulsing
 *  offline   hollow grey dot
 */
export function StateOrb({ state, size = 10, className }: { state: AgentState; size?: number; className?: string }) {
  const px = `${size}px`;
  return (
    <span className={cx("relative inline-flex shrink-0 items-center justify-center", className)} style={{ width: px, height: px }} role="img" aria-label={LABELS[state]}>
      {state === "thinking" && <span className="absolute inset-[-3px] rounded-full border border-cyan/50 animate-breathe" />}
      {state === "working" && <span className="absolute inset-[-2px] rounded-full border-[1.5px] border-accent border-r-transparent animate-ring-spin" />}
      {state === "needs-you" && <span className="absolute inset-[-3px] rounded-full bg-amber/30 animate-dot-pulse" />}
      <span
        className={cx(
          "block rounded-full",
          state === "idle" && "bg-ink4",
          state === "thinking" && "bg-cyan",
          state === "streaming" && "bg-accent shadow-[0_0_8px_rgb(var(--glow)/0.6)]",
          state === "working" && "bg-accent",
          state === "needs-you" && "bg-amber",
          state === "offline" && "border border-ink4 bg-transparent",
        )}
        style={{ width: Math.round(size * 0.6), height: Math.round(size * 0.6) }}
      />
    </span>
  );
}

export const LABELS: Record<AgentState, string> = {
  idle: "Idle",
  thinking: "Thinking",
  streaming: "Answering",
  working: "Working",
  "needs-you": "Needs you",
  offline: "Offline",
};

export function StateLabel({ state, detail }: { state: AgentState; detail?: string }) {
  return (
    <span className="inline-flex items-center gap-2 font-mono text-2xs uppercase tracking-wider text-ink3">
      <StateOrb state={state} size={9} />
      <span className={cx(state === "needs-you" && "text-amber", state === "thinking" && "text-cyan", (state === "streaming" || state === "working") && "text-accent")}>{LABELS[state]}</span>
      {detail && <span className="normal-case tracking-normal text-ink4">· {detail}</span>}
    </span>
  );
}
