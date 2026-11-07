import { useId } from "react";
import { useProfile } from "~/app/profile";
import { usePulse } from "~/app/pulse";
import { cx } from "~/lib/cx";

/**
 * Your face in the app: the photo you chose, or a soft "marble" drawn from
 * your profile seed: three blurred colour shapes on a bright base. Same
 * seed, same avatar. Different in kind from bot faces (no eyes, no smile),
 * so you never read as one of the bots.
 */
export function UserAvatar({ size = 28, className }: { size?: number; className?: string }) {
  const image = useProfile((s) => s.image);
  const seed = useProfile((s) => s.seed);
  const name = useDisplayName();
  if (image) {
    return <img src={image} alt={name} style={{ width: size, height: size }} className={cx("shrink-0 rounded-full object-cover", className)} draggable={false} />;
  }
  return <Marble seed={seed} size={size} label={name} className={className} />;
}

/** The name to show for you: your own override, else the runtime's owner name, else "You". */
export function useDisplayName(): string {
  const override = useProfile((s) => s.name);
  const owner = usePulse((s) => s.owner);
  return override || owner || "You";
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Palettes of three or four colours that sit well together, bright in light and dark. */
const PALETTES = [
  ["#FF6B6B", "#FFD166", "#06D6A0", "#118AB2"],
  ["#7F5AF0", "#2CB67D", "#FFB86B", "#F25F4C"],
  ["#F72585", "#7209B7", "#4CC9F0", "#FFBE0B"],
  ["#00BBF9", "#00F5D4", "#FEE440", "#F15BB5"],
  ["#FB5607", "#FFBE0B", "#3A86FF", "#8338EC"],
  ["#43AA8B", "#F9C74F", "#F3722C", "#577590"],
  ["#EF476F", "#FFD6A5", "#9BF6FF", "#5E60CE"],
  ["#2EC4B6", "#FF9F1C", "#E71D36", "#CBF3F0"],
];

export function Marble({ seed, size = 28, label, className }: { seed: string; size?: number; label?: string; className?: string }) {
  const uid = useId().replace(/:/g, "");
  const h = hash(seed);
  const palette = PALETTES[h % PALETTES.length];
  // Three different colours from the palette, in an order set by the seed.
  const i = (h >>> 3) % 4;
  const j = (i + 1 + ((h >>> 6) % 3)) % 4;
  const k = [0, 1, 2, 3].filter((x) => x !== i && x !== j)[(h >>> 10) % 2];
  const base = palette[i];
  const a = palette[j];
  const b = palette[k];
  const rot = (k: number) => ((h >>> k) % 360);
  const off = (k: number) => (((h >>> k) % 40) - 20);
  return (
    <svg width={size} height={size} viewBox="0 0 80 80" role="img" aria-label={label} className={cx("shrink-0 rounded-full", className)}>
      <defs>
        <mask id={`m-${uid}`} maskUnits="userSpaceOnUse" x="0" y="0" width="80" height="80"><circle cx="40" cy="40" r="40" fill="#fff" /></mask>
        <filter id={`f-${uid}`} x="-50%" y="-50%" width="200%" height="200%" filterUnits="userSpaceOnUse"><feGaussianBlur stdDeviation="7" /></filter>
      </defs>
      <g mask={`url(#m-${uid})`}>
        <rect width="80" height="80" fill={base} />
        <path filter={`url(#f-${uid})`} d="M32.4 -7.4L58.7 45.2 -4.8 64.3z" fill={a} transform={`translate(${off(2)} ${off(5)}) rotate(${rot(9)} 40 40) scale(1.2)`} />
        <path filter={`url(#f-${uid})`} style={{ mixBlendMode: "overlay" }} d="M22.2 0c4.4 15.6 12.8 26.2 25.2 31.9 12.4 5.7 26.3 4.6 41.7-3.2L80 80H0z" fill={b} transform={`translate(${off(4)} ${off(8)}) rotate(${rot(14)} 40 40) scale(1.2)`} />
      </g>
    </svg>
  );
}
