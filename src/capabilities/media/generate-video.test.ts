import { describe, expect, it, vi } from 'vitest';
import { createGenerateMusicTool, createGenerateVideoTool } from './generate-video.js';
import type { MediaService } from '../../media/service.js';
import type { MediaJobs } from '../../media/jobs.js';

/** generate_video / generate_music start a background job and end the turn; no model, no job. */
function deps(models: number, channelType = 'telegram') {
  const start = vi.fn<(...args: unknown[]) => { id: string }>(() => ({ id: 'job1' }));
  const media = { chain: async () => Array.from({ length: models }, () => ({})) } as unknown as MediaService;
  const d = {
    media, jobs: { start } as unknown as MediaJobs,
    permissions: { checkFsAccess: async (p: string) => ({ allowed: true, canonical: p }) } as never,
    getCwd: () => '/tmp', outputDir: () => '/out', chat: () => ({ channelType, channelId: `${channelType}:1` }),
  };
  return { d, start };
}
const run = (t: unknown, input: Record<string, unknown>) => (t as { execute: (i: unknown, o: unknown) => Promise<string> }).execute(input, { toolCallId: 't', messages: [] });

describe('generate_video and generate_music', () => {
  it('start a job for this chat and tell the model not to wait', async () => {
    const { d, start } = deps(1);
    const out = await run(createGenerateVideoTool(d), { prompt: 'a cat surfing', aspect: 'portrait' });
    expect(start).toHaveBeenCalledWith('video', 'a cat surfing', { channelType: 'telegram', channelId: 'telegram:1' }, expect.any(Function), { aspect: 'portrait' });
    expect(out).toContain('job job1');
    expect(out).toContain('sent to this chat');
    expect(out).toContain('do not wait');
  });

  it('in the apps the result appears in the conversation', async () => {
    const { d } = deps(1, 'web');
    expect(await run(createGenerateMusicTool(d), { prompt: 'lo-fi' })).toContain('appear in this conversation');
  });

  it('no model: an error now, no job', async () => {
    const { d, start } = deps(0);
    expect(await run(createGenerateVideoTool(d), { prompt: 'x' })).toContain('no video model is set up');
    expect(await run(createGenerateMusicTool(d), { prompt: 'x' })).toContain('no music model is set up');
    expect(start).not.toHaveBeenCalled();
  });
});
