import stringWidth from 'string-width';

/**
 * A minimal VT100-style screen for tests: replays what the TUI writes and
 * returns the visible text, including scrollback. It understands exactly
 * the sequences Ink, log-update and the cursor-parking patch emit — cursor
 * moves, line/screen erases, save/restore, cursor show/hide — and ignores
 * colour. Wide (CJK) characters take two cells: the second holds '' so a
 * cell index is always a terminal column.
 * Used to assert that transient live-region rows (spinners, "Processing")
 * never survive into the transcript, and where the real cursor ends up.
 */
export class VtScreen {
  /** Every line ever written (scrollback + viewport). */
  lines: string[][] = [[]];
  row = 0;
  col = 0;
  private saved: { row: number; col: number } | null = null;
  /** DECTCEM: `ESC[?25h` shows the cursor, `ESC[?25l` hides it. */
  cursorVisible = true;

  constructor(public columns = 100, public rows = 40) {}

  /** Index of the first viewport row inside `lines`. */
  private get top(): number {
    return Math.max(0, this.lines.length - this.rows);
  }

  private ensureRow(r: number): void {
    while (this.lines.length <= r) this.lines.push([]);
  }

  private put(ch: string): void {
    const width = stringWidth(ch);
    if (width === 0) return;
    if (this.col + width > this.columns) {
      this.row += 1;
      this.col = 0;
    }
    this.ensureRow(this.row);
    const line = this.lines[this.row];
    while (line.length < this.col) line.push(' ');
    line[this.col] = ch;
    if (width === 2) line[this.col + 1] = '';
    this.col += width;
  }

  write(data: string): void {
    const chars = [...data];
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i];
      if (c === '\x1b') {
        const next = chars[i + 1];
        if (next === '[') {
          let j = i + 2;
          let params = '';
          while (j < chars.length && /[0-9;?<>=]/.test(chars[j])) params += chars[j++];
          const final = chars[j];
          this.csi(params, final);
          i = j;
          continue;
        }
        if (next === ']') {
          // OSC: skip to BEL or ST
          let j = i + 2;
          while (j < chars.length && chars[j] !== '\x07' && !(chars[j] === '\x1b' && chars[j + 1] === '\\')) j++;
          i = chars[j] === '\x07' ? j : j + 1;
          continue;
        }
        if (next === '7') { this.saved = { row: this.row, col: this.col }; i += 1; continue; }
        if (next === '8') { if (this.saved) ({ row: this.row, col: this.col } = this.saved); i += 1; continue; }
        i += 1;
        continue;
      }
      if (c === '\r') { this.col = 0; continue; }
      // A real tty (ONLCR) turns \n into \r\n.
      if (c === '\n') { this.row += 1; this.col = 0; this.ensureRow(this.row); continue; }
      if (c === '\b') { this.col = Math.max(0, this.col - 1); continue; }
      if (c < ' ') continue;
      this.put(c);
    }
  }

  private csi(params: string, final: string): void {
    if (params === '?25' && (final === 'h' || final === 'l')) {
      this.cursorVisible = final === 'h';
      return;
    }
    if (params.startsWith('?')) return; // other modes: bracketed paste, mouse, sync output
    const nums = params.split(';').map((p) => (p === '' ? NaN : Number(p)));
    const n = Number.isNaN(nums[0]) ? 1 : nums[0];
    switch (final) {
      case 'A': this.row = Math.max(this.top, this.row - n); break;
      case 'B': this.row += n; this.ensureRow(this.row); break;
      case 'C': this.col += n; break;
      case 'D': this.col = Math.max(0, this.col - n); break;
      case 'E': this.row += n; this.col = 0; this.ensureRow(this.row); break;
      case 'F': this.row = Math.max(this.top, this.row - n); this.col = 0; break;
      case 'G': this.col = Math.max(0, n - 1); break;
      case 'H': case 'f': {
        const r = Number.isNaN(nums[0]) ? 1 : nums[0];
        const cc = Number.isNaN(nums[1]) ? 1 : nums[1];
        this.row = this.top + r - 1; this.col = cc - 1; this.ensureRow(this.row);
        break;
      }
      case 'K': {
        this.ensureRow(this.row);
        const line = this.lines[this.row];
        const mode = Number.isNaN(nums[0]) ? 0 : nums[0];
        if (mode === 0) line.length = Math.min(line.length, this.col);
        else if (mode === 1) for (let k = 0; k <= this.col && k < line.length; k++) line[k] = ' ';
        else this.lines[this.row] = [];
        break;
      }
      case 'J': {
        const mode = Number.isNaN(nums[0]) ? 0 : nums[0];
        if (mode === 0) {
          this.ensureRow(this.row);
          this.lines[this.row].length = Math.min(this.lines[this.row].length, this.col);
          this.lines.length = this.row + 1;
        } else if (mode === 2 || mode === 3) {
          for (let r = this.top; r < this.lines.length; r++) this.lines[r] = [];
        }
        break;
      }
      case 's': this.saved = { row: this.row, col: this.col }; break;
      case 'u': if (this.saved) ({ row: this.row, col: this.col } = this.saved); break;
      default: break; // SGR (m) and anything else: no layout effect
    }
  }

  /** All lines, right-trimmed, without trailing blank lines. */
  text(): string[] {
    const out = this.lines.map((l) => l.join('').replace(/\s+$/, ''));
    while (out.length > 0 && out[out.length - 1] === '') out.pop();
    return out;
  }
}
