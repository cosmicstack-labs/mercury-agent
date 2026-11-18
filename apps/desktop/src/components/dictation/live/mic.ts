import { Pcm16Framer, toMono } from "./pcm";

/**
 * The microphone for live dictation: echo-cancelled, noise-suppressed, gain
 * controlled (as the batch recorder and the phones), tapped with an
 * AudioWorklet (public/pcm-capture-worklet.js) and turned into 16 kHz mono
 * PCM16 frames of 60 ms. Where AudioWorklet isn't there (old WebKitGTK), a
 * ScriptProcessor does the same.
 *
 * getUserMedia throws a DOMException the caller turns into plain words
 * (micErrorText): NotAllowedError when the owner or the system said no.
 */

export interface MicCapture {
  stop(): void;
}

const WORKLET_URL = "/pcm-capture-worklet.js";

export async function startMic(onFrame: (frame: Int16Array) => void): Promise<MicCapture> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new DOMException("This window can't use the microphone.", "NotSupportedError");
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
  const ctx = new AudioContext();
  try {
    if (ctx.state === "suspended") await ctx.resume().catch(() => {});
    const source = ctx.createMediaStreamSource(stream);
    const framer = new Pcm16Framer(ctx.sampleRate, onFrame);
    // Nothing is heard: the tap goes to a muted gain so the graph runs.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    sink.connect(ctx.destination);
    let node: AudioNode;
    if (ctx.audioWorklet && typeof AudioWorkletNode !== "undefined") {
      await ctx.audioWorklet.addModule(WORKLET_URL);
      const w = new AudioWorkletNode(ctx, "pcm-capture", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: "explicit" });
      w.port.onmessage = (e: MessageEvent<Float32Array>) => framer.push(e.data);
      node = w;
    } else {
      const sp = ctx.createScriptProcessor(2048, 1, 1);
      sp.onaudioprocess = (e) => {
        const chans: Float32Array[] = [];
        for (let c = 0; c < e.inputBuffer.numberOfChannels; c++) chans.push(e.inputBuffer.getChannelData(c));
        framer.push(toMono(chans).slice());
      };
      node = sp;
    }
    source.connect(node);
    node.connect(sink);
    let stopped = false;
    return {
      stop() {
        if (stopped) return;
        stopped = true;
        try { source.disconnect(); node.disconnect(); } catch { /* gone */ }
        if ("port" in node) (node as AudioWorkletNode).port.onmessage = null;
        framer.flush();
        stream.getTracks().forEach((t) => t.stop());
        void ctx.close().catch(() => {});
      },
    };
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close().catch(() => {});
    throw err;
  }
}
