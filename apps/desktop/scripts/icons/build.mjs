/**
 * Builds every app icon from the vector mark (npm run icons):
 *   macOS    icon.icns: Apple's grid, a drawing per size (iconutil, macOS only)
 *   Windows  icon.ico: 16 to 256px, small sizes drawn heavier; Store logos
 *   Linux    32/64/128/256/512 PNGs (the bundle installs them into hicolor)
 *   Tray     macOS menu bar template (monochrome); a colour tile elsewhere
 * Masters are written as SVG next to them.
 */
import { Resvg } from "@resvg/resvg-js";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appIcon, markSVG, menuBarIcon } from "./mark.mjs";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "../../src-tauri/icons");
const png = (svg, px) => new Resvg(svg, { fitTo: { mode: "width", value: px } }).render().asPng();
const square = (px) => png(appIcon({ shape: "square", px }), px);

mkdirSync(join(OUT, "tray"), { recursive: true });

// Masters.
writeFileSync(join(OUT, "mark.svg"), markSVG());
writeFileSync(join(OUT, "icon-macos.svg"), appIcon({ shape: "mac" }));
writeFileSync(join(OUT, "icon-square.svg"), appIcon({ shape: "square" }));

// Linux, the window icon, and the sizes Tauri's config lists.
for (const [name, px] of [["32x32.png", 32], ["64x64.png", 64], ["128x128.png", 128], ["128x128@2x.png", 256], ["icon.png", 512]]) {
  writeFileSync(join(OUT, name), square(px));
}
// A browser notification's image (the desktop app bundles 128x128@2x for Linux).
writeFileSync(join(OUT, "..", "..", "public", "notification-icon.png"), square(256));

// Windows Store / MSIX tiles.
for (const px of [30, 44, 71, 89, 107, 142, 150, 284, 310]) writeFileSync(join(OUT, `Square${px}x${px}Logo.png`), square(px));
writeFileSync(join(OUT, "StoreLogo.png"), square(50));

// Windows .ico: PNG entries, each size drawn for itself.
const icoSizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
const images = icoSizes.map((px) => square(px));
const header = Buffer.alloc(6 + 16 * images.length);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
let offset = header.length;
images.forEach((img, i) => {
  const e = 6 + 16 * i, px = icoSizes[i];
  header.writeUInt8(px >= 256 ? 0 : px, e); header.writeUInt8(px >= 256 ? 0 : px, e + 1);
  header.writeUInt16LE(1, e + 4); header.writeUInt16LE(32, e + 6);
  header.writeUInt32LE(img.length, e + 8); header.writeUInt32LE(offset, e + 12);
  offset += img.length;
});
writeFileSync(join(OUT, "icon.ico"), Buffer.concat([header, ...images]));

// Tray: the menu bar template on macOS, a small colour tile on Windows and Linux.
const bar = menuBarIcon(36);
writeFileSync(join(OUT, "tray", "macos-template.png"), png(bar.svg, bar.w));
writeFileSync(join(OUT, "tray", "tray.png"), square(32));

// macOS .icns.
if (process.platform === "darwin") {
  const set = join(OUT, "icon.iconset");
  rmSync(set, { recursive: true, force: true });
  mkdirSync(set);
  for (const [pt, scale] of [[16, 1], [16, 2], [32, 1], [32, 2], [128, 1], [128, 2], [256, 1], [256, 2], [512, 1], [512, 2]]) {
    const px = pt * scale;
    writeFileSync(join(set, `icon_${pt}x${pt}${scale === 2 ? "@2x" : ""}.png`), png(appIcon({ shape: "mac", px }), px));
  }
  execFileSync("iconutil", ["-c", "icns", set, "-o", join(OUT, "icon.icns")]);
  rmSync(set, { recursive: true, force: true });
} else {
  console.warn("icon.icns needs macOS (iconutil); left as is.");
}
console.log(`Icons written to ${OUT}`);
