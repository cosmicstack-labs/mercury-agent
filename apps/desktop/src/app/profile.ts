/* Your profile on this device: a display name, an optional photo, and the
   seed your generated avatar is drawn from. The seed is random the first
   time and then kept, so your face stays the same until you shuffle it. */

import { create } from "zustand";

interface ProfileState {
  /** Overrides the owner name from the runtime config; "" means use that. */
  name: string;
  /** A small square photo as a data URL, or null for the generated avatar. */
  image: string | null;
  seed: string;
  setName(name: string): void;
  setImage(image: string | null): void;
  shuffle(): void;
  setSeed(seed: string): void;
}

const KEY = "mercury.profile.v1";

export function randomSeed(): string {
  try { return crypto.randomUUID(); } catch { return `${Date.now()}-${Math.random()}`; }
}

function read(): Pick<ProfileState, "name" | "image" | "seed"> {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const v = JSON.parse(raw) as Partial<ProfileState>;
      if (typeof v.seed === "string" && v.seed) return { name: typeof v.name === "string" ? v.name : "", image: typeof v.image === "string" ? v.image : null, seed: v.seed };
    }
  } catch { /* fall through to a new profile */ }
  return { name: "", image: null, seed: randomSeed() };
}

function write(s: Pick<ProfileState, "name" | "image" | "seed">) {
  try { localStorage.setItem(KEY, JSON.stringify({ name: s.name, image: s.image, seed: s.seed })); } catch { /* storage full or blocked: keep it in memory */ }
}

export const useProfile = create<ProfileState>((set, get) => {
  const initial = read();
  write(initial);
  const update = (patch: Partial<Pick<ProfileState, "name" | "image" | "seed">>) => {
    set(patch);
    const s = get();
    write({ name: s.name, image: s.image, seed: s.seed });
  };
  return {
    ...initial,
    setName: (name) => update({ name: name.trim() }),
    setImage: (image) => update({ image }),
    shuffle: () => update({ seed: randomSeed() }),
    setSeed: (seed) => update({ seed }),
  };
});

/** Shrink a picked photo to a 192px centre-cropped square JPEG data URL. */
export async function photoToDataUrl(file: File, size = 192): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("That file isn't an image Mercury can read."));
      i.src = url;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Couldn't process the photo.");
    ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
    return canvas.toDataURL("image/jpeg", 0.88);
  } finally {
    URL.revokeObjectURL(url);
  }
}
