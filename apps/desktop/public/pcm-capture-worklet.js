// Live dictation's microphone tap (src/components/dictation/live/mic.ts): hands the
// main thread mono float samples about every 20 ms; the downsampling to 16 kHz PCM16
// happens there (pcm.ts, tested). A plain file from 'self', as the app's CSP needs.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(1024);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0];
    if (ch && ch.length) {
      const len = ch[0].length;
      for (let i = 0; i < len; i++) {
        let v = 0;
        for (let c = 0; c < ch.length; c++) v += ch[c][i];
        this.buf[this.n++] = v / ch.length;
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf, [this.buf.buffer]);
          this.buf = new Float32Array(1024);
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("pcm-capture", PcmCapture);
