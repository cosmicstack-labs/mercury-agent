import { Clapperboard, Image as ImageIcon, Music, AudioLines } from "lucide-react";
import { cx } from "~/lib/cx";
import { formatDuration } from "~/app/trace";

/* ═══════════════════════════════════════════════════════════════
   Media on its way (ADR-042): a placeholder in the shape of what is
   coming, so nothing jumps when it lands — a soft colour field drifting
   under a light sweep for pictures and video, moving bars for sound —
   with what it is doing now and for how long. Still under reduced motion.
   ═══════════════════════════════════════════════════════════════ */

export type MediaKind = "image" | "video" | "music" | "speech";

export interface MediaShape {
  kind: MediaKind;
  aspect?: string;
  count?: number;
  prompt?: string;
}

/** What it says while working: changes every few seconds so a long wait never reads as stuck. */
const PHASES: Record<MediaKind, string[]> = {
  image: ["Composing", "Sketching shapes", "Adding light and colour", "Adding detail", "Refining"],
  video: ["Setting up the shot", "Blocking the scene", "Animating", "Adding sound", "Rendering frames", "Finishing"],
  music: ["Finding the groove", "Writing the melody", "Arranging", "Mixing", "Mastering"],
  speech: ["Warming up the voice", "Speaking", "Polishing"],
};

const KIND_WORD: Record<MediaKind, string> = { image: "image", video: "video", music: "music", speech: "voice" };

/** The status line for a wait of `ms`. */
export function mediaPhase(kind: MediaKind, ms: number): string {
  const list = PHASES[kind];
  const step = kind === "video" || kind === "music" ? 12_000 : 5_000;
  return list[Math.min(Math.floor(ms / step), list.length - 1)];
}

function ratioOf(kind: MediaKind, aspect?: string): string {
  if (kind === "video") return aspect === "portrait" ? "9 / 16" : "16 / 9";
  if (aspect === "landscape") return "3 / 2";
  if (aspect === "portrait") return "2 / 3";
  return "1 / 1";
}

export function MediaSkeleton({ shape, startedAt, now, note, className }: { shape: MediaShape; startedAt: number; now: number; note?: string; className?: string }) {
  const elapsed = Math.max(0, now - startedAt);
  const status = `${mediaPhase(shape.kind, elapsed)}…`;
  const Icon = shape.kind === "video" ? Clapperboard : shape.kind === "music" ? Music : shape.kind === "speech" ? AudioLines : ImageIcon;
  const label = `Creating ${KIND_WORD[shape.kind]}`;

  if (shape.kind === "music" || shape.kind === "speech") {
    return (
      <div className={cx("media-skeleton flex w-full max-w-[420px] items-center gap-3 rounded-xl border border-line px-3.5 py-3", className)} role="status" aria-label={`${label}: ${status}`}>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent/12 text-accent"><Icon size={16} /></span>
        <div className="min-w-0 flex-1">
          <div className="flex h-7 items-end gap-[3px]" aria-hidden="true">
            {Array.from({ length: 32 }, (_, i) => (
              <span key={i} className="media-bar block w-[3px] rounded-full bg-ink/25" style={{ height: `${30 + ((i * 37) % 70)}%`, animationDelay: `${(i % 8) * 0.11}s` }} />
            ))}
          </div>
          <div className="mt-1.5 flex items-center gap-2 text-xs text-ink3">
            <span className="shimmer-text truncate">{note ?? status}</span>
            <span className="ml-auto shrink-0 font-mono text-2xs text-ink4">{formatDuration(elapsed)}</span>
          </div>
        </div>
      </div>
    );
  }

  const tiles = Math.min(Math.max(shape.count ?? 1, 1), 4);
  return (
    <div className={cx("flex w-full flex-col gap-2", className)} role="status" aria-label={`${label}: ${status}`}>
      <div className={cx("grid gap-2", tiles > 1 ? "grid-cols-2" : "grid-cols-1")} style={{ maxWidth: tiles > 1 ? 520 : shape.kind === "video" && shape.aspect !== "portrait" ? 520 : 380 }}>
        {Array.from({ length: tiles }, (_, i) => (
          <div key={i} className="media-skeleton relative overflow-hidden rounded-xl border border-line" style={{ aspectRatio: ratioOf(shape.kind, shape.aspect) }}>
            <div className="media-aurora absolute inset-0" style={{ animationDelay: `${i * -2.3}s` }} aria-hidden="true" />
            <div className="media-sweep absolute inset-0" aria-hidden="true" />
            <div className="absolute inset-0 flex items-center justify-center" aria-hidden="true">
              <Icon size={28} className="media-icon text-ink/30" strokeWidth={1.5} />
            </div>
          </div>
        ))}
      </div>
      <div className="flex max-w-[520px] items-center gap-2 text-xs text-ink3">
        <span className="shimmer-text">{label} · {note ?? status}</span>
        <span className="ml-auto shrink-0 font-mono text-2xs text-ink4">{formatDuration(elapsed)}</span>
      </div>
      {shape.prompt && <p className="line-clamp-1 max-w-[520px] text-2xs text-ink4" title={shape.prompt}>{shape.prompt}</p>}
    </div>
  );
}
