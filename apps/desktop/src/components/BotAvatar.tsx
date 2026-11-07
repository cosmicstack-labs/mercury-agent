import { useEffect, useState } from "react";
import { apiUrl, authHeaders } from "~/api/client";
import * as api from "~/api/mercury";
import { cx } from "~/lib/cx";

/**
 * A bot's face. Uses the avatar the runtime stores (ADR-028) when there is
 * one; otherwise draws a face from the id: a shape (circle, squircle,
 * shield, hexagon) in a two-tone gradient with two eyes and a smile — the
 * same friendly line as the Mercury mark, so a fleet reads as one family.
 * Same id, same face, on every device. Not an emoji, not a photo.
 */

const cache = new Map<string, Promise<string | null>>();

function fetchAvatar(id: string): Promise<string | null> {
  let hit = cache.get(id);
  if (!hit) {
    hit = fetch(apiUrl(api.bots.avatarUrl(id)), { headers: authHeaders() })
      .then(async (res) => (res.ok ? URL.createObjectURL(await res.blob()) : null))
      .catch(() => null);
    cache.set(id, hit);
  }
  return hit;
}

export function BotAvatar({ id, name, hasAvatar, size = 32, dimmed, className }: { id: string; name: string; hasAvatar?: boolean; size?: number; dimmed?: boolean; className?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    if (hasAvatar) void fetchAvatar(id).then((url) => { if (live) setSrc(url); });
    else setSrc(null);
    return () => { live = false; };
  }, [id, hasAvatar]);

  const style = { width: size, height: size };
  if (src) {
    return <img src={src} alt={name} style={style} className={cx("shrink-0 rounded-[28%] object-cover", dimmed && "opacity-90", className)} draggable={false} />;
  }
  return <GeneratedFace id={id} name={name} size={size} dimmed={dimmed} className={className} />;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const SHAPES = [
  // circle
  "M50 4a46 46 0 1 1 0 92a46 46 0 1 1 0-92z",
  // squircle
  "M50 4c36 0 46 10 46 46s-10 46-46 46S4 86 4 50 14 4 50 4z",
  // shield / rounded triangle pointing down
  "M14 10h72c6 0 10 5 8 11L60 88c-4 8-16 8-20 0L6 21c-2-6 2-11 8-11z",
  // hexagon
  "M50 3l41 23v48L50 97 9 74V26z",
];

function GeneratedFace({ id, name, size, dimmed, className }: { id: string; name: string; size: number; dimmed?: boolean; className?: string }) {
  const h = hash(id);
  const hue = h % 360;
  const hue2 = (hue + 28 + ((h >> 9) % 40)) % 360;
  const shape = SHAPES[(h >> 3) % SHAPES.length];
  const eyeGap = 9 + ((h >> 12) % 5);
  const mouth = (h >> 16) % 3; // smile, grin, small smile
  const tri = shape === SHAPES[2];
  const eyeY = tri ? 36 : 44;
  const mouthY = tri ? 52 : 60;
  const gid = `g-${id}`;
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} role="img" aria-label={name} className={cx("shrink-0", dimmed && "opacity-90", className)}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={`hsl(${hue} 70% 62%)`} />
          <stop offset="1" stopColor={`hsl(${hue2} 72% 44%)`} />
        </linearGradient>
      </defs>
      {/* The same path stroked wide with round joins softens every corner;
          drawn at 88% so the rounded edge stays inside the frame. */}
      <path d={shape} fill={`url(#${gid})`} stroke={`url(#${gid})`} strokeWidth={10} strokeLinejoin="round" transform="translate(6 6) scale(0.88)" />
      <circle cx={50 - eyeGap} cy={eyeY} r="5.2" fill="#fff" />
      <circle cx={50 + eyeGap} cy={eyeY} r="5.2" fill="#fff" />
      {mouth === 0 && <path d={`M${40} ${mouthY} q10 9 20 0`} stroke="#fff" strokeWidth="4.5" strokeLinecap="round" fill="none" />}
      {mouth === 1 && <path d={`M${38} ${mouthY - 1} q12 13 24 0z`} fill="#fff" />}
      {mouth === 2 && <path d={`M${44} ${mouthY} q6 5 12 0`} stroke="#fff" strokeWidth="4.5" strokeLinecap="round" fill="none" />}
    </svg>
  );
}
