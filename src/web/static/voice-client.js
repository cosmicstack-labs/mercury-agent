/*!
 * Mercury Voice Client — vanilla JS helper that lets any web frontend
 * (the React SPA, a custom page, an embedded chat widget) talk to the
 * /api/voice/* endpoints and decode incoming `audio_chunk` SSE events.
 *
 * Drop into a page:
 *   <script type="module" src="/voice-client.js"></script>
 *
 * Then in your own code:
 *   import { MercuryVoice } from '/voice-client.js';
 *   const voice = new MercuryVoice({
 *     onPartial: (t) => updateMicCaption(t),
 *     onFinal:   (t) => sendToChat(t),
 *   });
 *   await voice.connect();              // hooks SSE for audio playback
 *   micButton.onpointerdown = () => voice.startRecording();
 *   micButton.onpointerup   = () => voice.stopRecording();
 *
 * Audio playback model:
 *   The SSE event stream emits `audio_chunk` events whose `data.pcm` is
 *   base64-encoded raw s16le PCM at `data.sampleRate` Hz. We decode each
 *   chunk into a Float32Array and schedule it via Web Audio API
 *   AudioBufferSourceNodes, queued so playback is continuous. `audio_end`
 *   clears the queue once the in-flight buffers finish.
 *
 * STT model:
 *   The browser captures via MediaRecorder (webm/opus is universal in
 *   modern browsers) and POSTs the blob to /api/voice/transcribe. The
 *   server transcodes via ffmpeg and runs whichever STT provider is
 *   currently selected. For true streaming STT, we'd want a per-session
 *   WebSocket — that lands in a later phase.
 *
 * No dependencies — uses Web Audio + MediaRecorder + EventSource only.
 * Designed to be small enough to inline if needed.
 */

export class MercuryVoice {
  /**
   * @param {object} [opts]
   * @param {(text: string) => void} [opts.onPartial]  called with partial transcripts
   * @param {(text: string) => void} [opts.onFinal]    called with the final transcript
   * @param {(state: string) => void} [opts.onState]   called on lifecycle changes
   * @param {string} [opts.eventsUrl]                  defaults to /api/chat/events
   * @param {string} [opts.transcribeUrl]              defaults to /api/voice/transcribe
   */
  constructor(opts = {}) {
    this.onPartial = opts.onPartial || (() => {});
    this.onFinal   = opts.onFinal   || (() => {});
    this.onState   = opts.onState   || (() => {});
    this.eventsUrl     = opts.eventsUrl     || '/api/chat/events';
    this.transcribeUrl = opts.transcribeUrl || '/api/voice/transcribe';

    // Web Audio playback state
    this._ctx = null;
    this._nextStartAt = 0;
    this._active = new Set(); // currently-playing AudioBufferSourceNodes

    // Recorder state
    this._mediaRecorder = null;
    this._mediaStream = null;
    this._recChunks = [];

    // SSE state
    this._es = null;
  }

  /** Subscribe to the SSE event stream for incoming audio playback. */
  async connect() {
    if (this._es) return;
    this._ensureCtx();
    const es = new EventSource(this.eventsUrl);
    this._es = es;
    es.addEventListener('audio_chunk', (e) => this._onAudioChunk(e));
    es.addEventListener('audio_end',   ()  => this._onAudioEnd());
    es.addEventListener('transcript_partial', (e) => this._dispatchTranscript(e, false));
    es.addEventListener('transcript_final',   (e) => this._dispatchTranscript(e, true));
    return new Promise((resolve) => {
      const onOpen = () => { es.removeEventListener('open', onOpen); resolve(); };
      es.addEventListener('open', onOpen);
    });
  }

  /** Detach the SSE listener and stop any in-flight playback. */
  disconnect() {
    if (this._es) { this._es.close(); this._es = null; }
    this._cancelPlayback();
  }

  /** Start microphone capture. Resolves once recording begins. */
  async startRecording() {
    if (this._mediaRecorder) return;
    this.onState('starting');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this._mediaStream = stream;
    // Pick a mime type the browser definitely supports.
    const mime = pickRecorderMime();
    const rec  = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    this._mediaRecorder = rec;
    this._recChunks = [];
    rec.addEventListener('dataavailable', (e) => {
      if (e.data && e.data.size > 0) this._recChunks.push(e.data);
    });
    rec.start(250); // emit chunks every 250ms (we still POST as one blob)
    this.onState('recording');
  }

  /**
   * Stop the recorder, POST the audio to /api/voice/transcribe, and
   * resolve with `{ text }`. Also fires onFinal / onPartial along the way
   * via the SSE stream when connected.
   */
  async stopRecording() {
    const rec = this._mediaRecorder;
    if (!rec) return null;
    this.onState('stopping');

    const done = new Promise((resolve) => {
      rec.addEventListener('stop', () => resolve(), { once: true });
    });
    rec.stop();
    await done;

    // Release the mic.
    if (this._mediaStream) {
      for (const t of this._mediaStream.getTracks()) try { t.stop(); } catch {}
      this._mediaStream = null;
    }
    const blob = new Blob(this._recChunks, { type: rec.mimeType || 'audio/webm' });
    this._mediaRecorder = null;
    this._recChunks = [];

    if (blob.size === 0) {
      this.onState('idle');
      return { text: '' };
    }

    this.onState('transcribing');
    const fd = new FormData();
    fd.append('audio', blob, 'utterance.webm');
    try {
      const res = await fetch(this.transcribeUrl, { method: 'POST', body: fd });
      if (!res.ok) {
        const err = await safeJson(res);
        throw new Error(err?.error || `HTTP ${res.status}`);
      }
      const json = await res.json();
      this.onState('idle');
      if (json.text) this.onFinal(json.text);
      return json;
    } catch (err) {
      this.onState('error');
      throw err;
    }
  }

  /* ── Internal: audio playback ──────────────────────────────────────── */

  _ensureCtx() {
    if (this._ctx) return this._ctx;
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) throw new Error('Web Audio API not available');
    this._ctx = new C();
    this._nextStartAt = this._ctx.currentTime;
    return this._ctx;
  }

  _onAudioChunk(evt) {
    let data;
    try { data = JSON.parse(evt.data); } catch { return; }
    if (!data.pcm) return;
    const ctx = this._ensureCtx();
    const sampleRate = data.sampleRate || 22050;
    const channels   = data.channels   || 1;

    // Resume the context lazily — modern browsers require a user gesture.
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});

    const float32 = pcm16ToFloat32(base64ToUint8(data.pcm));
    const frames  = Math.floor(float32.length / channels);
    if (frames === 0) return;

    const buffer = ctx.createBuffer(channels, frames, sampleRate);
    if (channels === 1) {
      buffer.getChannelData(0).set(float32);
    } else {
      // De-interleave for multi-channel; we only ship mono in Phase 3
      // but handle it gracefully if the provider ever sends stereo.
      for (let ch = 0; ch < channels; ch++) {
        const out = buffer.getChannelData(ch);
        for (let i = 0; i < frames; i++) out[i] = float32[i * channels + ch];
      }
    }

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime, this._nextStartAt);
    src.start(startAt);
    this._nextStartAt = startAt + buffer.duration;
    this._active.add(src);
    src.onended = () => this._active.delete(src);
  }

  _onAudioEnd() {
    // Let queued buffers finish naturally; nothing to do here unless we
    // want to gap-fill. Caller can observe via onState if desired.
    this.onState('played');
  }

  _cancelPlayback() {
    for (const src of this._active) {
      try { src.stop(0); } catch {}
    }
    this._active.clear();
    if (this._ctx) this._nextStartAt = this._ctx.currentTime;
  }

  _dispatchTranscript(evt, isFinal) {
    let data;
    try { data = JSON.parse(evt.data); } catch { return; }
    if (typeof data.text !== 'string') return;
    if (isFinal) this.onFinal(data.text);
    else this.onPartial(data.text);
  }
}

/* ── Module helpers ─────────────────────────────────────────────────── */

function pickRecorderMime() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/ogg',
    'audio/mp4',
  ];
  for (const c of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c)) {
      return c;
    }
  }
  return '';
}

function base64ToUint8(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function pcm16ToFloat32(u8) {
  // Interpret the byte view as little-endian Int16; convert to [-1, 1] f32.
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const len = Math.floor(u8.byteLength / 2);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const s = view.getInt16(i * 2, true);
    out[i] = s / 0x8000;
  }
  return out;
}

async function safeJson(res) {
  try { return await res.json(); } catch { return null; }
}
