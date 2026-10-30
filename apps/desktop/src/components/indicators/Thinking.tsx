import { cx } from "~/lib/cx";

/** Three dots that pulse in sequence: "thinking" in a message row. */
export function ThinkingDots({ className, label = "Thinking" }: { className?: string; label?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-2 text-sm text-ink3", className)} role="status" aria-label={label}>
      <span className="inline-flex items-center gap-[3px]" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <span key={i} className="block h-1.5 w-1.5 rounded-full bg-cyan animate-dot-pulse" style={{ animationDelay: `${i * 0.16}s` }} />
        ))}
      </span>
      {label}
    </span>
  );
}

/** Blinking caret at the end of streaming text. */
export function StreamCaret() {
  return <span className="ml-0.5 inline-block h-[1.1em] w-[2px] translate-y-[3px] bg-accent animate-caret-blink" aria-hidden="true" />;
}

/** Audio bars for listening / speaking (voice, later). */
export function VoiceBars({ active = true, tone = "accent" }: { active?: boolean; tone?: "accent" | "cyan" }) {
  return (
    <span className="inline-flex h-3.5 items-end gap-[2px]" aria-hidden="true">
      {[0.5, 0.9, 1, 0.7, 0.4].map((h, i) => (
        <span
          key={i}
          className={cx("block w-[3px] origin-bottom rounded-sm", tone === "accent" ? "bg-accent" : "bg-cyan", active && "animate-bars")}
          style={{ height: `${h * 14}px`, animationDelay: `${i * 0.12}s` }}
        />
      ))}
    </span>
  );
}
