/**
 * Render a QR code as SVG for the dashboard (WhatsApp linking). Uses the
 * encoder bundled in qrcode-terminal, which Mercury already ships, so the
 * dashboard needs no QR library of its own.
 */
// @ts-expect-error: CommonJS module without types
import QRCode from 'qrcode-terminal/vendor/QRCode/index.js';
// @ts-expect-error: CommonJS module without types
import QRErrorCorrectLevel from 'qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js';

interface QRCodeInstance {
  addData(data: string): void;
  make(): void;
  getModuleCount(): number;
  isDark(row: number, col: number): boolean;
}

export function qrSvg(text: string, scale = 6): string {
  const Ctor = QRCode as unknown as new (type: number, level: number) => QRCodeInstance;
  const qr = new Ctor(-1, (QRErrorCorrectLevel as { L: number }).L);
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4;
  const size = (n + quiet * 2) * scale;
  let path = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) path += `M${(c + quiet) * scale} ${(r + quiet) * scale}h${scale}v${scale}h-${scale}z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
