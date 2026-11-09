/**
 * The face of a bot, when there is no photo: a monogram on a colour derived from the id.
 *
 * These three rules are the ones the Android client already draws (`BotJson.monogram`,
 * `BotJson.hue` and `BotFace` in `BotsScreen.kt`), copied rather than reinvented so the
 * same bot looks the same on the phone and in the dashboard — same letters, same colour,
 * same lightness. Change one and change the other.
 */

/** Letters a bot shows when it has no photo: initials for a multi-word name, else its first two characters. */
export function botMonogram(name: string | null | undefined, id: string): string {
  const source = (name ?? "").trim() || id.trim();
  const words = source.split(/[ _-]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  if (source.length > 0) return source.slice(0, 2).toUpperCase();
  return "?";
}

/** Stable hue (0–359) derived from the id, so a bot keeps its colour across sessions. */
export function botHue(id: string, name?: string | null): number {
  const source = id.trim() || (name ?? "").trim();
  if (source.length === 0) return 210;
  let hash = 0;
  // Code units, not code points: `hash * 31 + char.code` and the `&` that follows are the
  // Kotlin side's 32-bit arithmetic, and JS `&` is ToInt32 — identical wrapping, identical hue.
  for (let i = 0; i < source.length; i++) hash = (hash * 31 + source.charCodeAt(i)) & 0x7fffffff;
  return hash % 360;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/**
 * `hsv(h, 45%, 75%)` as an `rgb(…)` string — CSS has no HSV, and converting here keeps the
 * colour equal to the phone's instead of merely close.
 */
export function botFaceColor(hue: number): string {
  const h = ((hue % 360) + 360) % 360;
  const s = clamp01(0.45);
  const v = clamp01(0.75);
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r1, g1, b1] =
    h < 60 ? [c, x, 0] :
    h < 120 ? [x, c, 0] :
    h < 180 ? [0, c, x] :
    h < 240 ? [0, x, c] :
    h < 300 ? [x, 0, c] :
    [c, 0, x];
  const to255 = (n: number) => Math.round((n + m) * 255);
  return `rgb(${to255(r1)}, ${to255(g1)}, ${to255(b1)})`;
}

/** Everything a client needs to draw a bot without a photo. */
export function botFace(id: string, name?: string | null): { monogram: string; background: string } {
  return { monogram: botMonogram(name, id), background: botFaceColor(botHue(id, name)) };
}
