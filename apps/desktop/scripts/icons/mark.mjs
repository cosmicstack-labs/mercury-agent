/**
 * The Mercury mark (a cat whose head is the ☿ symbol) drawn as vectors, and
 * the app icons built from it. Coordinates are the original 1024px
 * artwork's, so the mark lines up with the logo used everywhere else.
 *
 * Small sizes get their own drawing, not a shrunk big one: strokes thicken
 * as the icon shrinks, and at 20px and below (and in the menu bar) the head
 * turns solid with the face cut out, because outlines fall apart there.
 */

/** The mark's bounding box in artwork units. */
export const BOX = { x: 362, y: 312, w: 298, h: 403, cx: 511, cy: 513.5 };

const EAR = "M 393 414 C 378 372, 376 334, 396 325 C 413 318, 434 338, 452 363";
const MIRROR = "translate(1022 0) scale(-1 1)";

/** The outline mark: ears, head ring, ☿ cross, eyes, smile. */
export function markOutline({ s = 20, eye = 18.5, smile = true, color = "#fff" } = {}) {
  const st = `fill="none" stroke="${color}" stroke-width="${s}" stroke-linecap="round" stroke-linejoin="round"`;
  return [
    `<path d="${EAR}" ${st}/>`,
    `<path d="${EAR}" ${st} transform="${MIRROR}"/>`,
    `<circle cx="511" cy="495" r="${149 - s / 2}" ${st}/>`,
    `<path d="M 511 ${644 - s / 2} V ${712 - s / 2}" ${st}/>`,
    `<path d="M ${468 + s / 2} 677 H ${555 - s / 2}" ${st}/>`,
    `<circle cx="451" cy="497" r="${eye}" fill="${color}"/>`,
    `<circle cx="571" cy="497" r="${eye}" fill="${color}"/>`,
    smile ? `<path d="M 492 540 Q 511.5 561 531 540" fill="none" stroke="${color}" stroke-width="${smile === true ? Math.min(s, 19) : smile}" stroke-linecap="round"/>` : "",
  ].join("");
}

/** The solid mark: a filled head with the face cut out. `long` stretches the cross for the menu bar. */
export function markSolid({ color = "#000", id = "face", eye = 30, cross = 44, long = false } = {}) {
  const ear = (t = "") => `<path d="${EAR} L 511 400 Z" stroke="${color}" stroke-width="40" stroke-linejoin="round"${t}/>`;
  const bar = (d) => `<path d="${d}" stroke="${color}" stroke-width="${cross}" stroke-linecap="round"/>`;
  const c = cross / 2;
  return `<mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024"><rect width="1024" height="1024" fill="#fff"/>
<circle cx="451" cy="497" r="${eye}" fill="#000"/><circle cx="571" cy="497" r="${eye}" fill="#000"/>
<path d="M 488 544 Q 511.5 568 535 544" fill="none" stroke="#000" stroke-width="26" stroke-linecap="round"/></mask>
<g mask="url(#${id})" fill="${color}">${ear()}${ear(` transform="${MIRROR}"`)}<circle cx="511" cy="495" r="149"/></g>
${long ? bar(`M 511 630 V ${752 - c}`) + bar(`M ${452 + c} 706 H ${570 - c}`) : bar(`M 511 630 V ${712 - c}`) + bar(`M ${468 + c} 677 H ${555 - c}`)}`;
}

/** Line weight for the pixel size the icon is drawn at. */
export function detailFor(px) {
  if (px <= 20) return { solid: true };
  if (px <= 40) return { s: 32, eye: 24, smile: 26 };
  if (px <= 80) return { s: 28, eye: 22, smile: 22 };
  return { s: 25, eye: 21, smile: 20 };
}

/** Apple's continuous-corner plate, approximated by a superellipse (n = 5). */
export function squircle(x, y, w, h, n = 5, steps = 360) {
  const cx = x + w / 2, cy = y + h / 2, a = w / 2, b = h / 2, pts = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * 2 * Math.PI, c = Math.cos(t), s = Math.sin(t);
    pts.push(`${(cx + a * Math.sign(c) * Math.abs(c) ** (2 / n)).toFixed(2)} ${(cy + b * Math.sign(s) * Math.abs(s) ** (2 / n)).toFixed(2)}`);
  }
  return `M ${pts.join(" L ")} Z`;
}

function roundRect(x, y, w, h, r) {
  return `M ${x + r} ${y} H ${x + w - r} A ${r} ${r} 0 0 1 ${x + w} ${y + r} V ${y + h - r} A ${r} ${r} 0 0 1 ${x + w - r} ${y + h} H ${x + r} A ${r} ${r} 0 0 1 ${x} ${y + h - r} V ${y + r} A ${r} ${r} 0 0 1 ${x + r} ${y} Z`;
}

/**
 * The app icon on a 1024 canvas, for drawing at `px` pixels.
 *  - "mac": an 824px squircle on Apple's grid (100px margin, no baked shadow:
 *    macOS 26 adds its own, and anything outside the shape gets the icon
 *    shrunk onto a grey plate).
 *  - "square": a rounded square for Windows and Linux, nearly full-bleed.
 * Brand green mark on a near-black plate, lit softly from above.
 */
export function appIcon({ shape = "mac", px = 1024 } = {}) {
  const plate = shape === "mac" ? { x: 100, w: 824 } : { x: 40, w: 944 };
  const d = shape === "mac" ? squircle(plate.x, plate.x, plate.w, plate.w) : roundRect(plate.x, plate.x, plate.w, plate.w, plate.w * 0.225);
  const det = detailFor(px);
  const small = px <= 40;
  const k = (plate.w * (small ? 0.7 : 0.6)) / BOX.h;
  const tx = 512 - BOX.cx * k, ty = 512 - BOX.cy * k + plate.w * 0.005;
  const mark = det.solid ? markSolid({ color: "url(#mark)", eye: 34 }) : markOutline({ ...det, color: "url(#mark)" });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="${px}" height="${px}">
<defs>
  <linearGradient id="plate" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1A2924"/><stop offset="1" stop-color="#090D0C"/></linearGradient>
  <radialGradient id="glow" cx="0.5" cy="0.42" r="0.55"><stop offset="0" stop-color="#34E1A1" stop-opacity="${small ? 0 : 0.16}"/><stop offset="1" stop-color="#34E1A1" stop-opacity="0"/></radialGradient>
  <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.10"/><stop offset="0.5" stop-color="#fff" stop-opacity="0"/></linearGradient>
  <linearGradient id="mark" gradientUnits="userSpaceOnUse" x1="0" y1="312" x2="0" y2="715"><stop offset="0" stop-color="#7DF5C8"/><stop offset="1" stop-color="#22C98B"/></linearGradient>
  <clipPath id="clip"><path d="${d}"/></clipPath>
</defs>
<path d="${d}" fill="url(#plate)"/>
<g clip-path="url(#clip)"><rect width="1024" height="1024" fill="url(#glow)"/><rect width="1024" height="1024" fill="url(#sheen)"/></g>
<g transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${k.toFixed(4)})">${mark}</g>
</svg>`;
}

/**
 * The macOS menu bar icon: a black solid mark on transparent, used as a
 * template image (macOS keeps only the alpha and tints it for the menu bar,
 * light or dark). The tray library sets it to 18pt tall, so it's drawn 36px
 * tall: exactly 2x, sharp on Retina.
 */
export function menuBarIcon(heightPx = 36) {
  const box = { cx: 511, cy: 532, w: 298, h: 440 };
  const pad = 1.5 / 36;
  const k = (heightPx * (1 - 2 * pad)) / box.h;
  const w = Math.ceil(box.w * k + heightPx * pad * 2);
  const tx = w / 2 - box.cx * k, ty = heightPx / 2 - box.cy * k;
  return { w, svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${heightPx}" width="${w}" height="${heightPx}"><g transform="translate(${tx.toFixed(3)} ${ty.toFixed(3)}) scale(${k.toFixed(5)})">${markSolid({ color: "#000", eye: 31, cross: 40, long: true })}</g></svg>` };
}

/** The mark alone, white, for anywhere a plain vector is wanted. */
export function markSVG() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${BOX.x - 20} ${BOX.y - 20} ${BOX.w + 40} ${BOX.h + 40}">${markOutline({ s: 25, eye: 21, smile: 20, color: "#fff" })}</svg>`;
}
