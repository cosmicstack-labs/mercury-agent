import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkVideo, judgeBlank } from './blank-check.js';

const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const dir = mkdtempSync(join(tmpdir(), 'mercury-blank-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const make = (name: string, src: string) => {
  const file = join(dir, name);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', src, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', '-t', '5', '-pix_fmt', 'yuv420p', '-shortest', file]);
  return file;
};

describe('a video that never rendered is caught', () => {
  it('judges from the detector log', () => {
    expect(judgeBlank('Duration: 00:00:15.00, start\nblack_start:0 black_end:15 black_duration:15')?.problem).toMatch(/black for 100%/);
    expect(judgeBlank('Duration: 00:00:10.00, start\nfreeze_start: 0\nlavfi.freezedetect.freeze_duration: 9.9')?.problem).toMatch(/nothing moves/);
    expect(judgeBlank('Duration: 00:00:10.00, start\nblack_duration:2')).toBeNull();
  });

  it.skipIf(!hasFfmpeg)('black with sound, and one still colour, are refused; a moving picture passes', async () => {
    expect((await checkVideo(make('black.mp4', 'color=c=black:s=320x240:d=5')))?.problem).toMatch(/black/);
    expect((await checkVideo(make('still.mp4', 'color=c=0x1a2b4c:s=320x240:d=5')))?.problem).toMatch(/nothing moves/);
    expect(await checkVideo(make('moving.mp4', 'testsrc=s=320x240:d=5'))).toBeNull();
  }, 60_000);
});
