/**
 * Microphone audio for live dictation: whatever rate the webview captures at
 * (44.1 or 48 kHz, usually) → 16 kHz mono PCM16 in 60 ms frames (960 samples),
 * what every engine takes (dictation.rs CALL_RATE; the phones send the same).
 */

export const TARGET_RATE = 16_000;
export const FRAME_SAMPLES = 960; // 60 ms at 16 kHz

/**
 * Downsamples by averaging the input samples that fall into each output
 * sample's span (a box filter, enough against aliasing for speech), keeping
 * the fractional position across chunks so the rate is exact over time.
 */
export class Pcm16Framer {
  private readonly step: number;
  private pos = 0; // where the next output sample starts, in input samples, relative to the current chunk
  private acc = 0;
  private accN = 0;
  private frame = new Int16Array(FRAME_SAMPLES);
  private fill = 0;

  constructor(readonly inputRate: number, private readonly onFrame: (frame: Int16Array) => void) {
    if (!(inputRate >= TARGET_RATE)) throw new Error(`can't capture at ${inputRate} Hz (need at least ${TARGET_RATE})`);
    this.step = inputRate / TARGET_RATE;
  }

  /** Float samples in -1…1, mono. */
  push(input: Float32Array): void {
    let next = this.pos + this.step; // end of the current output sample's span
    for (let i = 0; i < input.length; i++) {
      this.acc += input[i];
      this.accN++;
      if (i + 1 >= next) {
        this.emit(this.acc / this.accN);
        this.acc = 0;
        this.accN = 0;
        next += this.step;
      }
    }
    this.pos = next - this.step - input.length;
  }

  /** Whatever is left as a last (shorter) frame. */
  flush(): void {
    if (this.fill) this.onFrame(this.frame.slice(0, this.fill));
    this.fill = 0;
  }

  private emit(v: number): void {
    const s = Math.max(-1, Math.min(1, v));
    this.frame[this.fill++] = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
    if (this.fill === FRAME_SAMPLES) {
      this.onFrame(this.frame);
      this.frame = new Int16Array(FRAME_SAMPLES);
      this.fill = 0;
    }
  }
}

/** A frame's loudness for the meter, 0…1 (peak, shaped like the batch recorder's bars). */
export function frameLevel(frame: Int16Array): number {
  let peak = 0;
  for (let i = 0; i < frame.length; i++) { const a = Math.abs(frame[i]); if (a > peak) peak = a; }
  return Math.min(1, (peak / 32768) * 2.2);
}

/** Mixes channels down to one. */
export function toMono(channels: Float32Array[]): Float32Array {
  if (channels.length <= 1) return channels[0] ?? new Float32Array(0);
  const out = new Float32Array(channels[0].length);
  for (const c of channels) for (let i = 0; i < out.length; i++) out[i] += c[i] / channels.length;
  return out;
}

/** 16-bit PCM WAV → its mono samples and rate (the smoke test reads a `say` recording). */
export function readWav(bytes: Uint8Array): { rate: number; samples: Int16Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a WAV file");
  let rate = 0, channels = 1, bits = 16;
  let i = 12;
  while (i + 8 <= bytes.length) {
    const id = tag(i);
    const len = view.getUint32(i + 4, true);
    if (id === "fmt ") { channels = view.getUint16(i + 10, true); rate = view.getUint32(i + 12, true); bits = view.getUint16(i + 22, true); }
    if (id === "data") {
      if (bits !== 16) throw new Error(`need 16-bit PCM, got ${bits}-bit`);
      const n = Math.floor(Math.min(len, bytes.length - i - 8) / 2 / channels);
      const samples = new Int16Array(n);
      for (let k = 0; k < n; k++) samples[k] = view.getInt16(i + 8 + k * 2 * channels, true);
      return { rate, samples };
    }
    i += 8 + len + (len % 2);
  }
  throw new Error("WAV file has no audio");
}
