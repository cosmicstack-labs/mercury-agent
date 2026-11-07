/**
 * Notification sounds: twelve short ones made with Web Audio (no files to
 * ship, crisp at any volume), or the owner's own clip. Each is under a
 * second and quiet by design: a nudge, not an alarm.
 */

export type SoundId = "pop" | "chime" | "ding" | "glass" | "bubble" | "tick" | "marimba" | "bell" | "blip" | "drop" | "pluck" | "twinkle" | "custom";

export const SOUNDS: Array<{ id: Exclude<SoundId, "custom">; label: string }> = [
  { id: "pop", label: "Pop" },
  { id: "chime", label: "Chime" },
  { id: "ding", label: "Ding" },
  { id: "glass", label: "Glass" },
  { id: "bubble", label: "Bubble" },
  { id: "tick", label: "Tick" },
  { id: "marimba", label: "Marimba" },
  { id: "bell", label: "Bell" },
  { id: "blip", label: "Blip" },
  { id: "drop", label: "Drop" },
  { id: "pluck", label: "Pluck" },
  { id: "twinkle", label: "Twinkle" },
];

/** Own sounds are kept on this device; a short clip is plenty. */
export const CUSTOM_MAX_BYTES = 1024 * 1024;

let ctx: AudioContext | null = null;
function audio(): AudioContext | null {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

interface Tone {
  type?: OscillatorType;
  freq: number;
  /** Glide to this frequency. */
  to?: number;
  at?: number;
  dur: number;
  gain?: number;
  attack?: number;
}

function tones(list: Tone[], volume: number): void {
  const a = audio();
  if (!a) return;
  const out = a.createGain();
  out.gain.value = Math.max(0, Math.min(1, volume));
  out.connect(a.destination);
  const t0 = a.currentTime + 0.01;
  for (const t of list) {
    const o = a.createOscillator();
    const g = a.createGain();
    o.type = t.type ?? "sine";
    const start = t0 + (t.at ?? 0);
    const end = start + t.dur;
    o.frequency.setValueAtTime(t.freq, start);
    if (t.to) o.frequency.exponentialRampToValueAtTime(t.to, end);
    const peak = t.gain ?? 0.35;
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(peak, start + (t.attack ?? 0.006));
    g.gain.exponentialRampToValueAtTime(0.0001, end);
    o.connect(g).connect(out);
    o.start(start);
    o.stop(end + 0.02);
  }
}

function noiseTick(volume: number): void {
  const a = audio();
  if (!a) return;
  const len = Math.floor(a.sampleRate * 0.03);
  const buf = a.createBuffer(1, len, a.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
  const src = a.createBufferSource();
  src.buffer = buf;
  const band = a.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = 3200;
  band.Q.value = 1.2;
  const g = a.createGain();
  g.gain.value = Math.max(0, Math.min(1, volume)) * 0.9;
  src.connect(band).connect(g).connect(a.destination);
  src.start();
}

const RECIPES: Record<Exclude<SoundId, "custom">, (v: number) => void> = {
  pop: (v) => tones([{ freq: 620, to: 190, dur: 0.09, gain: 0.5, attack: 0.003 }], v),
  chime: (v) => tones([{ freq: 880, dur: 0.6, gain: 0.25 }, { freq: 1320, dur: 0.55, gain: 0.14, at: 0.01 }], v),
  ding: (v) => tones([{ freq: 1046.5, dur: 0.5, gain: 0.3 }, { freq: 2093, dur: 0.3, gain: 0.08 }], v),
  glass: (v) => tones([{ freq: 1567.98, dur: 0.38, gain: 0.2 }, { freq: 2349.3, dur: 0.3, gain: 0.12, at: 0.005 }, { freq: 1575, dur: 0.38, gain: 0.08 }], v),
  bubble: (v) => tones([{ freq: 320, to: 940, dur: 0.12, gain: 0.4, attack: 0.004 }], v),
  tick: (v) => noiseTick(v),
  marimba: (v) => tones([{ freq: 523.25, dur: 0.32, gain: 0.4, attack: 0.002 }, { freq: 2093, dur: 0.06, gain: 0.12, attack: 0.001 }], v),
  bell: (v) => tones([{ type: "triangle", freq: 660, dur: 0.9, gain: 0.3 }, { freq: 1650, dur: 0.5, gain: 0.1 }, { freq: 2475, dur: 0.25, gain: 0.05 }], v),
  blip: (v) => tones([{ type: "square", freq: 880, dur: 0.06, gain: 0.08, attack: 0.002 }, { type: "square", freq: 1320, dur: 0.06, gain: 0.07, at: 0.07, attack: 0.002 }], v),
  drop: (v) => tones([{ freq: 1250, to: 310, dur: 0.18, gain: 0.4, attack: 0.003 }], v),
  pluck: (v) => tones([{ type: "triangle", freq: 392, dur: 0.3, gain: 0.45, attack: 0.002 }, { freq: 784, dur: 0.12, gain: 0.1, attack: 0.002 }], v),
  twinkle: (v) => tones([{ freq: 1046.5, dur: 0.14, gain: 0.22 }, { freq: 1318.5, dur: 0.14, gain: 0.22, at: 0.08 }, { freq: 1568, dur: 0.3, gain: 0.22, at: 0.16 }], v),
};

/** Play a sound; a custom one plays from its data URL. Fails quietly (no audio device, autoplay rules). */
export function playSound(id: SoundId, volume: number, customUrl?: string | null): void {
  try {
    if (id === "custom") {
      if (!customUrl) return RECIPES.pop(volume);
      const el = new Audio(customUrl);
      el.volume = Math.max(0, Math.min(1, volume));
      void el.play().catch(() => {});
      return;
    }
    (RECIPES[id] ?? RECIPES.pop)(volume);
  } catch {
    /* sound is a nicety */
  }
}
