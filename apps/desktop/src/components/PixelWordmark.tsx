/**
 * The Mercury Code wordmark in the same 5-row pixel font as the terminal
 * splash (src/ui/pixel-logo.ts in the runtime): one brand, two screens.
 * Drawn as SVG squares; rows shade top→bottom like the terminal's
 * `████▓`, and the fill runs the accent → cyan so it reads as one mark.
 */

const GLYPHS: Record<string, string[]> = {
  M: ["10001", "11011", "10101", "10001", "10001"],
  E: ["1111", "1000", "1110", "1000", "1111"],
  R: ["1110", "1001", "1110", "1010", "1001"],
  C: ["0111", "1000", "1000", "1000", "0111"],
  U: ["1001", "1001", "1001", "1001", "0110"],
  Y: ["1001", "1001", "0110", "0110", "0110"],
  O: ["0110", "1001", "1001", "1001", "0110"],
  D: ["1110", "1001", "1001", "1001", "1110"],
  " ": ["00", "00", "00", "00", "00"],
};

const ROW_SHADE = [1, 1, 1, 0.82, 0.62];

export function PixelWordmark({ text = "MERCURY CODE", cell = 9, gap = 1.5, className }: { text?: string; cell?: number; gap?: number; className?: string }) {
  const cells: Array<{ x: number; y: number; row: number }> = [];
  let cursor = 0;
  for (const ch of text.toUpperCase()) {
    const glyph = GLYPHS[ch] ?? GLYPHS[" "];
    glyph.forEach((row, y) => {
      [...row].forEach((bit, x) => { if (bit === "1") cells.push({ x: cursor + x, y, row: y }); });
    });
    cursor += glyph[0].length + 1;
  }
  const cols = cursor - 1;
  const pitch = cell + gap;
  const width = cols * pitch - gap;
  const height = 5 * pitch - gap;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label={text} className={className}>
      <defs>
        <linearGradient id="pixel-wordmark" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="rgb(var(--accent))" />
          <stop offset="1" stopColor="rgb(var(--cyan))" />
        </linearGradient>
      </defs>
      {cells.map((c, i) => (
        <rect key={i} x={c.x * pitch} y={c.y * pitch} width={cell} height={cell} rx={1.5} fill="url(#pixel-wordmark)" opacity={ROW_SHADE[c.row]} />
      ))}
    </svg>
  );
}
