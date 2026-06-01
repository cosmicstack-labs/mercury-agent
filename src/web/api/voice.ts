/**
 * Voice HTTP API for the web channel.
 *
 * Endpoints:
 *   GET  /api/voice/status      → snapshot of VoiceManager + providers.
 *   POST /api/voice/enable      → flips config + enables the subsystem.
 *   POST /api/voice/disable     → disables and tears down providers.
 *   POST /api/voice/grant       → triggers per-platform permission prompt.
 *   POST /api/voice/speak       → manual TTS trigger (body: { text }).
 *                                 Audio frames stream as SSE audio_chunk
 *                                 events on /api/chat/events.
 *   POST /api/voice/transcribe  → multipart audio → text. Accepts any
 *                                 ffmpeg-decodable container; transcodes
 *                                 to 16kHz s16le mono internally before
 *                                 handing to the STT provider. Returns
 *                                 { text, durationMs, provider }.
 *
 * The web channel does NOT do hold-to-talk streaming STT in Phase 3 —
 * browsers ship MediaRecorder (opus/webm), and forwarding those frames
 * to Cartesia's WebSocket would require client-side PCM resampling.
 * Instead the browser records a full utterance and POSTs it; we transcode
 * once via ffmpeg and run STT in one shot. Streaming STT lands when we
 * add a dedicated /api/voice/stream WebSocket in a later phase.
 */
import { Hono } from 'hono';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebChannel } from '../../channels/web.js';
import { getVoiceManager } from '../../voice/index.js';
import { knownTTSProviders } from '../../voice/tts/registry.js';
import { knownSTTProviders } from '../../voice/stt/registry.js';
import { pickReadySTT } from '../../voice/stt/registry.js';
import { findBinary } from '../../voice/audio/system.js';
import { loadConfig, saveConfig } from '../../utils/config.js';
import { logger } from '../../utils/logger.js';
import type { AudioChunk } from '../../voice/types.js';

let webChannel: WebChannel | null = null;

export function setWebChannelForVoice(ch: WebChannel): void {
  webChannel = ch;
}

const voice = new Hono();

/* ── Status ──────────────────────────────────────────────────────────── */

voice.get('/api/voice/status', (c) => {
  const mgr = getVoiceManager();
  const snapshot = mgr.getStatus();
  const cfg = loadConfig().voice ?? null;
  return c.json({
    status: snapshot,
    config: cfg,
    knownProviders: {
      tts: knownTTSProviders(),
      stt: knownSTTProviders(),
    },
  });
});

/* ── Enable / Disable / Grant ────────────────────────────────────────── */

voice.post('/api/voice/enable', async (c) => {
  const cfg = loadConfig();
  cfg.voice = cfg.voice ?? ({} as any);
  (cfg.voice as any).enabled = true;
  saveConfig(cfg);
  await getVoiceManager().enable();
  return c.json({ status: getVoiceManager().getStatus() });
});

voice.post('/api/voice/disable', async (c) => {
  const cfg = loadConfig();
  if (cfg.voice) (cfg.voice as any).enabled = false;
  saveConfig(cfg);
  await getVoiceManager().disable();
  return c.json({ status: getVoiceManager().getStatus() });
});

voice.post('/api/voice/grant', async (c) => {
  const status = await getVoiceManager().requestMicPermission();
  return c.json({ permission: status });
});

/* ── Manual TTS ──────────────────────────────────────────────────────── */

voice.post('/api/voice/speak', async (c) => {
  if (!webChannel) return c.json({ error: 'Web channel not initialized' }, 503);
  const body = await c.req.json<{ text?: string; targetId?: string }>();
  const text = (body.text ?? '').trim();
  if (!text) return c.json({ error: 'text is required' }, 400);

  const mgr = getVoiceManager();
  if (mgr.getStatus().state === 'disabled') {
    return c.json({ error: 'Voice subsystem disabled. POST /api/voice/enable first.' }, 409);
  }

  // Feed text as a single delta into the SSE pipeline.
  const iter: AsyncIterable<string> = (async function* () { yield text; })();
  void webChannel.pipeTTSToSSE(mgr, iter, body.targetId).catch((err) => {
    logger.warn({ err }, '/api/voice/speak pipe error');
  });

  return c.json({ ok: true });
});

/* ── Transcribe (one-shot, multipart) ────────────────────────────────── */

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // OpenAI's hard limit; we mirror it
const STT_SAMPLE_RATE = 16000;

voice.post('/api/voice/transcribe', async (c) => {
  const mgr = getVoiceManager();
  if (mgr.getStatus().state === 'disabled') {
    return c.json({ error: 'Voice subsystem disabled.' }, 409);
  }

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: 'Expected multipart/form-data with an "audio" file' }, 400);
  }
  const file = form.get('audio');
  if (!(file instanceof File)) {
    return c.json({ error: 'Field "audio" must be a file' }, 400);
  }
  if (file.size === 0) {
    return c.json({ error: 'Empty audio upload' }, 400);
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return c.json({ error: `Audio exceeds ${MAX_UPLOAD_BYTES} byte limit` }, 413);
  }

  const ffmpeg = findBinary('ffmpeg');
  if (!ffmpeg.path) {
    return c.json({ error: `ffmpeg not found. ${ffmpeg.installHint}` }, 500);
  }

  // Persist upload to disk so ffmpeg can read it without a complex
  // stdin handshake (browsers send webm/opus which ffmpeg autodetects).
  const tmpDir = mkdtempSync(join(tmpdir(), 'mercury-stt-'));
  const inputPath = join(tmpDir, `upload.${guessExtension(file)}`);
  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    writeFileSync(inputPath, bytes);

    const startedAt = Date.now();
    const pcm = await transcodeToPCM(ffmpeg.path!, inputPath);

    // Hand the PCM to the STT provider as a single-frame iterator.
    const stt = await pickReadySTT();
    if (!stt) {
      return c.json({ error: 'No STT provider available' }, 503);
    }
    const frame: AudioChunk = {
      pcm,
      sampleRate: STT_SAMPLE_RATE,
      channels: 1,
      timestamp: performance.now(),
    };
    const frames: AsyncIterable<AudioChunk> = (async function* () { yield frame; })();

    let finalText = '';
    for await (const delta of stt.transcribe(frames, { language: 'auto' })) {
      if (delta.isFinal && delta.text) {
        finalText = finalText
          ? `${finalText} ${delta.text}`.trim()
          : delta.text.trim();
      }
      // Surface live partials to SSE clients so connected UIs can echo them.
      if (webChannel) webChannel.broadcastTranscript(delta.text, delta.isFinal);
    }

    return c.json({
      text: finalText,
      durationMs: Date.now() - startedAt,
      provider: stt.name,
      bytes: pcm.byteLength,
    });
  } catch (err: any) {
    logger.warn({ err }, '/api/voice/transcribe failed');
    return c.json({ error: err?.message ?? 'transcription failed' }, 500);
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

/* ── Helpers ─────────────────────────────────────────────────────────── */

function guessExtension(file: File): string {
  const name = file.name || '';
  const ext = name.includes('.') ? name.split('.').pop()! : '';
  if (ext) return ext.toLowerCase().slice(0, 8);
  const type = file.type || '';
  if (type.includes('webm')) return 'webm';
  if (type.includes('ogg'))  return 'ogg';
  if (type.includes('mp4'))  return 'm4a';
  if (type.includes('wav'))  return 'wav';
  if (type.includes('mpeg')) return 'mp3';
  return 'bin';
}

/**
 * Run ffmpeg to transcode whatever the browser uploaded into raw 16kHz
 * mono s16le PCM that the STT providers can consume directly. Returns
 * the full PCM buffer in memory; bounded by MAX_UPLOAD_BYTES upstream.
 */
function transcodeToPCM(ffmpegPath: string, inputPath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-i', inputPath,
      '-ac', '1',
      '-ar', String(STT_SAMPLE_RATE),
      '-f', 's16le',
      'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    const chunks: Buffer[] = [];
    let total = 0;
    let stderr = '';
    let settled = false;

    proc.stdout.on('data', (d: Buffer) => {
      chunks.push(d);
      total += d.byteLength;
      // Defensive cap: 30 minutes @ 16kHz mono s16le ≈ 57.6 MB.
      if (total > 80 * 1024 * 1024) {
        if (settled) return;
        settled = true;
        try { proc.kill('SIGKILL'); } catch { /* ignore */ }
        reject(new Error('Decoded PCM exceeds 80MB cap'));
      }
    });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    proc.on('exit', (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolve(Buffer.concat(chunks, total));
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.trim().slice(0, 300)}`));
    });
  });
}

export default voice;
