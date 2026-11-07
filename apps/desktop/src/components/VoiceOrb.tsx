import { useEffect, useRef } from "react";
import { useVoiceLevels, type VoicePhase } from "~/app/voice";

/**
 * The call's living circles. Three soft, overlapping discs drift around a
 * centre and swell with the voice: yours while you talk (greens), Mercury's
 * while it answers (blues and violets). Thinking and working breathe slowly
 * with a turning ring; muted goes grey and still. Levels are read straight
 * from the store each frame, so the rest of the app never re-renders for it.
 */

type OrbPhase = VoicePhase | "starting";

const PALETTES: Record<OrbPhase, [string, string, string]> = {
  listening: ["#34E1A1", "#2BB5C9", "#7FD8E8"],
  speaking: ["#5B8DEF", "#9B7BD8", "#2BB5C9"],
  thinking: ["#9B7BD8", "#5B8DEF", "#E0739B"],
  working: ["#D4A72C", "#E8894A", "#5B8DEF"],
  muted: ["#8A97A3", "#6B7680", "#A9B3BB"],
  starting: ["#7FD8E8", "#5B8DEF", "#34E1A1"],
  off: ["#8A97A3", "#6B7680", "#A9B3BB"],
};

function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export function VoiceOrb({ size, phase, className }: { size: number; phase: OrbPhase; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    let level = 0;
    let colors = PALETTES[phaseRef.current].map((c) => c);
    let raf = 0;
    const start = performance.now();

    const frame = (now: number) => {
      const t = (now - start) / 1000;
      const p = phaseRef.current;
      const lv = useVoiceLevels.getState();
      const fresh = Date.now() - lv.at < 450;
      const target = !fresh ? 0 : p === "speaking" ? lv.out : p === "listening" ? lv.mic : p === "muted" || p === "off" ? 0 : Math.max(lv.mic, lv.out) * 0.4;
      // Rise fast, fall gently: reads like a voice, not a meter.
      level += (target - level) * (target > level ? 0.35 : 0.08);
      colors = PALETTES[p];

      const c = size / 2;
      const r = size * 0.3;
      ctx.clearRect(0, 0, size, size);

      // Soft halo.
      const haloR = r * (1.35 + level * 0.45 + (p === "thinking" || p === "working" || p === "starting" ? Math.sin(t * 1.6) * 0.05 : 0));
      const halo = ctx.createRadialGradient(c, c, r * 0.4, c, c, haloR);
      halo.addColorStop(0, rgba(colors[0], 0.18));
      halo.addColorStop(1, rgba(colors[0], 0));
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(c, c, haloR, 0, Math.PI * 2);
      ctx.fill();

      ctx.globalCompositeOperation = "lighter";
      const calm = p === "muted" || p === "off";
      for (let i = 0; i < 3; i++) {
        const speed = calm || still ? 0 : 0.35 + i * 0.18 + level * 0.9;
        const angle = t * speed + i * 2.09;
        const drift = r * (0.1 + level * 0.18);
        const x = c + Math.cos(angle) * drift;
        const y = c + Math.sin(angle * 1.1) * drift;
        const breathe = still ? 0 : Math.sin(t * (1.1 + i * 0.3) + i) * 0.05;
        const rr = r * (0.78 + breathe + level * (0.42 - i * 0.08));
        const g = ctx.createRadialGradient(x - rr * 0.3, y - rr * 0.3, rr * 0.1, x, y, rr);
        g.addColorStop(0, rgba(colors[i], calm ? 0.5 : 0.85));
        g.addColorStop(0.7, rgba(colors[i], calm ? 0.25 : 0.45));
        g.addColorStop(1, rgba(colors[i], 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, rr, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalCompositeOperation = "source-over";

      // Thinking / working / starting: a slow turning ring of dashes.
      if ((p === "thinking" || p === "working" || p === "starting") && !still) {
        ctx.save();
        ctx.translate(c, c);
        ctx.rotate(t * 0.9);
        ctx.strokeStyle = rgba(colors[1], 0.55);
        ctx.lineWidth = Math.max(1.5, size * 0.008);
        ctx.lineCap = "round";
        const ringR = r * 1.18;
        for (let k = 0; k < 3; k++) {
          ctx.beginPath();
          ctx.arc(0, 0, ringR, k * (Math.PI * 2 / 3), k * (Math.PI * 2 / 3) + 0.9);
          ctx.stroke();
        }
        ctx.restore();
      }

      if (!document.hidden) raf = requestAnimationFrame(frame);
      else raf = window.setTimeout(() => { raf = requestAnimationFrame(frame); }, 250) as unknown as number;
    };
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); clearTimeout(raf); };
  }, [size]);

  return <canvas ref={ref} style={{ width: size, height: size }} className={className} aria-hidden="true" />;
}
