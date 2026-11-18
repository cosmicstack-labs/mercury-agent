#!/usr/bin/env node
/**
 * REAL smoke test for Mercury Desktop's live dictation (not run in CI; tiny paid usage).
 *
 * Asks the running Mercury on this computer (http://127.0.0.1:6174, signed in with
 * the attach token, as Mercury Desktop and the CLI are) for a dictation token, then
 * streams a spoken WAV through the SAME TypeScript client the composer uses
 * (src/components/dictation/live: stream.ts, protocol.ts, pcm.ts, text.ts), at real
 * time in 60 ms frames, printing partials and the final transcript.
 *
 *   cd apps/desktop
 *   node scripts/smoke-live-dictation.mjs                 # engine Mercury picks; a `say` recording
 *   node scripts/smoke-live-dictation.mjs --engine deepgram --wav speech.wav
 *
 * Without --wav it makes one with macOS `say` + `afconvert` (16 kHz mono PCM16).
 * Secrets are never printed: not the attach token, not the minted token.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const base = (arg("url") ?? process.env.MERCURY_URL ?? "http://127.0.0.1:6174").replace(/\/+$/, "");
const phrase = arg("say") ?? "testing live dictation on the desktop";

if (typeof WebSocket === "undefined") { console.error("Needs Node 22+ (global WebSocket)."); process.exit(1); }

const work = mkdtempSync(join(tmpdir(), "mercury-live-dictation-"));
try {
  // The client, bundled from source exactly as the app imports it.
  const out = join(work, "live.mjs");
  await build({
    stdin: {
      contents: 'export { LiveDictation } from "./stream"; export { Pcm16Framer, readWav, FRAME_SAMPLES } from "./pcm"; export { DictationText } from "./text";',
      resolveDir: join(here, "../src/components/dictation/live"),
      loader: "ts",
    },
    bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "error",
  });
  const { LiveDictation, Pcm16Framer, readWav, FRAME_SAMPLES, DictationText } = await import(pathToFileURL(out).href);

  // Audio: 16 kHz mono PCM16 frames of 60 ms.
  let wav = arg("wav");
  if (!wav) {
    const aiff = join(work, "speech.aiff");
    wav = join(work, "speech.wav");
    execFileSync("say", ["-o", aiff, phrase]);
    execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav]);
    console.log(`audio: macOS say "${phrase}"`);
  }
  const { rate, samples } = readWav(new Uint8Array(readFileSync(wav)));
  const frames = [];
  const framer = new Pcm16Framer(rate, (f) => frames.push(f.slice()));
  const floats = Float32Array.from(samples, (s) => s / 32768);
  framer.push(floats);
  framer.flush();
  // Half a second of quiet after the words, as a person pausing before stopping.
  for (let i = 0; i < 8; i++) frames.push(new Int16Array(FRAME_SAMPLES));
  console.log(`audio: ${(samples.length / rate).toFixed(2)} s at ${rate} Hz → ${frames.length} frames of 60 ms`);

  // Sign in as this computer (the attach token), never printed.
  const home = process.env.MERCURY_HOME ?? join(homedir(), ".mercury");
  const attach = readFileSync(join(home, "attach-token"), "utf8").trim();
  const headers = { Authorization: `Bearer ${attach}`, "Content-Type": "application/json", Accept: "application/json" };
  const caps = await (await fetch(`${base}/api/mobile/voice/capabilities`, { headers })).json();
  console.log(`capabilities: dictation=${caps.dictation} engine=${caps.dictationEngine ?? "-"} (${caps.dictationEngineName ?? caps.dictationSetup ?? ""})`);
  const asked = arg("engine");
  const res = await fetch(`${base}/api/mobile/voice/dictation`, { method: "POST", headers, body: JSON.stringify(asked ? { engine: asked } : {}) });
  const tok = await res.json();
  if (!res.ok) { console.error(`token refused (${res.status}): ${tok.error}`); process.exit(2); }
  console.log(`token: engine=${tok.engine} model=${tok.model} ephemeral=${tok.ephemeral} expires=${tok.expiresAt} (${tok.token.length} chars, not shown)`);
  if (asked && tok.engine !== asked) console.log(`note: asked for ${asked}, Mercury has no key for it and gave ${tok.engine}`);

  // Stream it, as the composer does: words go into a box that already says "Note:".
  const box = { text: "Note:" };
  const text = new DictationText(box.text);
  const t0 = Date.now();
  const ms = () => `${String(Date.now() - t0).padStart(5)} ms`;
  const closed = new Promise((resolve) => {
    const s = new LiveDictation(tok, (e) => {
      if (e.type === "partial") { box.text = text.partial(e.text, box.text); console.log(`${ms()}  partial  "${e.text}"`); }
      else if (e.type === "final") { box.text = text.final(e.text, box.text); console.log(`${ms()}  FINAL    "${e.text}"`); }
      else { console.log(`${ms()}  closed   ${e.reason}`); resolve(e.reason); }
    });
    let i = 0;
    const tick = setInterval(() => {
      if (i < frames.length) { s.pushAudio(frames[i++]); return; }
      clearInterval(tick);
      console.log(`${ms()}  (stop pressed)`);
      s.finish();
    }, 60);
  });
  const reason = await closed;
  console.log(`\nmessage box: "${box.text}"`);
  process.exit(reason === "stopped" && box.text.length > "Note:".length ? 0 : 3);
} finally {
  rmSync(work, { recursive: true, force: true });
}
