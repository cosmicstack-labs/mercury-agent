import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGenerateImageTool } from './generate-image.js';
import type { MediaService } from '../../media/service.js';

/** generate_image: real files from an image model, delivered, and an honest error when none is set up. */
const dir = mkdtempSync(join(tmpdir(), 'mercury-genimg-'));
afterEach(() => vi.restoreAllMocks());

function make(generate: MediaService['generateImage']) {
  const deliver = vi.fn(async () => 'Sent to this chat.');
  const permissions = { checkFsAccess: async (p: string) => ({ allowed: true, canonical: p }) };
  const t = createGenerateImageTool({
    media: { generateImage: generate } as unknown as MediaService,
    permissions: permissions as never,
    getCwd: () => dir,
    outputDir: () => join(dir, 'out'),
    deliver,
  });
  const run = (input: Record<string, unknown>) => (t as unknown as { execute: (i: unknown, o: unknown) => Promise<string> }).execute(input, { abortSignal: undefined, toolCallId: 't', messages: [] });
  return { run, deliver };
}

describe('generate_image', () => {
  it('generates, delivers, and tells the model the path for edits', async () => {
    const gen = vi.fn(async () => ({ files: [join(dir, 'out', 'fox.png')], model: { ref: 'openai::gpt-image-1', label: 'GPT Image 1', group: 'OpenAI API' }, failed: [], ms: 2100 }));
    const { run, deliver } = make(gen as never);
    const out = await run({ prompt: 'a fox', aspect: 'landscape' });
    expect(gen).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'a fox', aspect: 'landscape', references: [] }), join(dir, 'out'));
    expect(deliver).toHaveBeenCalledWith([join(dir, 'out', 'fox.png')], 'a fox');
    expect(out).toContain('Generated 1 image with GPT Image 1 (OpenAI API) in 2.1s');
    expect(out).toContain(`- ${join(dir, 'out', 'fox.png')}`);
    expect(out).toContain('Sent to this chat.');
    expect(out).toContain('reference_images');
  });

  it('passes reference images as resolved paths, and refuses missing ones', async () => {
    writeFileSync(join(dir, 'in.png'), 'x');
    const gen = vi.fn(async () => ({ files: [join(dir, 'b.png')], model: { label: 'M', group: 'G' }, failed: [], ms: 1 }));
    const { run } = make(gen as never);
    await run({ prompt: 'make it blue', reference_images: ['in.png'] });
    expect((gen.mock.calls as unknown as Array<[unknown]>)[0][0]).toMatchObject({ references: [join(dir, 'in.png')] });
    expect(await run({ prompt: 'x', reference_images: ['missing.png'] })).toContain('reference image not found');
  });

  it('no image model: says so instead of failing the turn', async () => {
    const { run } = make((async () => { throw new Error('No image model is set up. Add a provider…'); }) as never);
    expect(await run({ prompt: 'a fox' })).toBe('Error: No image model is set up. Add a provider…');
  });
});
