import { cx } from "~/lib/cx";
import type { VoicePhase } from "~/app/voice";

/**
 * Optimus's face — fixed, its own, never generated: a rounded hexagon in a
 * blue-to-violet gradient with a dark visor and two lit eyes, so it reads as
 * "the one that uses the computer" next to the round, friendly bot faces.
 * The face shows the phase: eyes pulse while listening, a mouth wave while
 * speaking, eyes sweep while thinking or working, eyes dim when muted.
 */
export function OptimusFace({ size = 28, phase = "off", className }: { size?: number; phase?: VoicePhase; className?: string }) {
  const eyes = phase === "muted" ? "#5b6b8c" : "#E6FCFF";
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} role="img" aria-label="Optimus" className={cx("shrink-0", className)}>
      <defs>
        <linearGradient id="optimus-shell" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#38BDF8" />
          <stop offset="1" stopColor="#7C3AED" />
        </linearGradient>
      </defs>
      {/* Rounded hexagon: a wide round-join stroke in the same gradient softens the corners. */}
      <path d="M50 10 84 29.5v41L50 90 16 70.5v-41z" fill="url(#optimus-shell)" stroke="url(#optimus-shell)" strokeWidth="12" strokeLinejoin="round" />
      <rect x="22" y="36" width="56" height="24" rx="12" fill="#0B1020" opacity="0.9" />
      <g className={cx(phase === "listening" && "optimus-eyes-pulse", (phase === "thinking" || phase === "working") && "optimus-eyes-scan")}>
        <circle cx="38" cy="48" r="5.5" fill={eyes} />
        <circle cx="62" cy="48" r="5.5" fill={eyes} />
      </g>
      {phase === "speaking" ? (
        <g fill="#E6FCFF">
          {[0, 1, 2, 3, 4].map((i) => (
            <rect key={i} x={36 + i * 6} y={68} width="3.5" height="12" rx="1.75" className="optimus-mouth" style={{ animationDelay: `${i * 0.11}s`, transformOrigin: `${37.75 + i * 6}px 74px` }} />
          ))}
        </g>
      ) : (
        <path d="M40 72 q10 6 20 0" stroke="#E6FCFF" strokeOpacity="0.85" strokeWidth="4" strokeLinecap="round" fill="none" />
      )}
    </svg>
  );
}
