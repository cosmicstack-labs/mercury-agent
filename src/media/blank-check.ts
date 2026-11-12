/**
 * Is this video actually a video? A render that failed quietly still makes
 * an MP4: all black frames with the soundtrack, or one still frame for its
 * whole length (HTML whose animation never ran). Sent as is, the owner gets
 * "Video created!" and a black screen. This looks before it goes out, with
 * ffmpeg's own detectors (blackdetect, freezedetect), in one pass.
 *
 * Fails open: no ffmpeg, an unreadable file, or a probe that takes too long
 * says nothing, and the file is sent as before.
 */
import { execFile } from 'node:child_process';

export interface BlankVerdict {
  /** Why it isn't a real video, in words for the model and the owner. */
  problem: string;
}

const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi)$/i;

function run(file: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string } | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !stderr) return resolve(null);
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** Seconds covered by detector lines like "black_duration:1.5" / "freeze_duration: 3.2". */
export function coveredSeconds(log: string, key: 'black_duration' | 'freeze_duration'): number {
  let total = 0;
  for (const m of log.matchAll(new RegExp(`${key}:\\s*([\\d.]+)`, 'g'))) total += Number(m[1]) || 0;
  return total;
}

/** A video's length from ffmpeg's banner ("Duration: 00:00:15.04"). */
export function durationOf(log: string): number {
  const m = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(log);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
}

/** The verdict from ffmpeg's log: black ≥ 90% of the length, or no motion for ≥ 95% of it. */
export function judgeBlank(log: string): BlankVerdict | null {
  const length = durationOf(log);
  if (length < 1) return null;
  const black = coveredSeconds(log, 'black_duration');
  if (black >= length * 0.9) return { problem: `it is black for ${Math.round((black / length) * 100)}% of its ${length.toFixed(1)}s: the picture never rendered (only the sound did)` };
  let frozen = coveredSeconds(log, 'freeze_duration');
  // A freeze that lasts to the end is reported with a start and no end.
  const starts = [...log.matchAll(/freeze_start:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  const ends = [...log.matchAll(/freeze_end:\s*([\d.]+)/g)].length;
  if (starts.length > ends) frozen += Math.max(0, length - starts[starts.length - 1]);
  if (length >= 3 && frozen >= length * 0.95) return { problem: `nothing moves in it: the same frame for ${frozen.toFixed(1)} of its ${length.toFixed(1)}s, so the animation never ran` };
  return null;
}

export async function checkVideo(path: string, opts: { ffmpeg?: string; timeoutMs?: number } = {}): Promise<BlankVerdict | null> {
  if (!VIDEO_EXT.test(path)) return null;
  const out = await run(opts.ffmpeg ?? 'ffmpeg', [
    '-hide_banner', '-nostdin', '-i', path, '-t', '120', '-an',
    '-vf', 'blackdetect=d=0.2:pix_th=0.08,freezedetect=n=0.003:d=1',
    '-f', 'null', '-',
  ], opts.timeoutMs ?? 30_000);
  if (!out) return null;
  // The banner (with Duration) comes without -hide_banner's input section suppressed: ask once more if missing.
  let log = out.stderr;
  if (!durationOf(log)) {
    const probe = await run(opts.ffmpeg ?? 'ffmpeg', ['-nostdin', '-i', path], 10_000);
    log = `${probe?.stderr ?? ''}\n${log}`;
  }
  return judgeBlank(log);
}
