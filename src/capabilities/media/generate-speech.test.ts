import { describe, expect, it, vi } from 'vitest';
import { createGenerateSpeechTool } from './generate-speech.js';
import type { SpeechService } from '../../media/speech.js';

/** generate_speech: a voice note in chat apps, mp3 elsewhere, delivered, errors told plainly. */
function make(inChatApp: boolean, speakToFile: SpeechService['speakToFile']) {
  const deliver = vi.fn(async () => 'Sent to this chat.');
  const t = createGenerateSpeechTool({ speech: { speakToFile } as unknown as SpeechService, outputDir: () => '/out', inChatApp: () => inChatApp, deliver });
  const run = (input: Record<string, unknown>) => (t as unknown as { execute: (i: unknown, o: unknown) => Promise<string> }).execute(input, { abortSignal: undefined, toolCallId: 't', messages: [] });
  return { run, deliver };
}

describe('generate_speech', () => {
  it('a voice note (ogg) in a chat app, with the style and voice asked for', async () => {
    const speak = vi.fn(async () => ({ file: '/out/hello.ogg', label: 'OpenAI', ms: 900 }));
    const { run, deliver } = make(true, speak as never);
    const out = await run({ text: 'Hello Sam', voice: 'nova', style: 'warm' });
    expect(speak).toHaveBeenCalledWith('Hello Sam', '/out', expect.objectContaining({ format: 'ogg', voice: 'nova', instructions: 'warm' }));
    expect(deliver).toHaveBeenCalledWith(['/out/hello.ogg'], 'Hello Sam');
    expect(out).toContain('Spoke it with OpenAI in 0.9s');
    expect(out).toContain('- /out/hello.ogg');
  });

  it('mp3 in the apps and the terminal', async () => {
    const speak = vi.fn(async () => ({ file: '/out/a.mp3', label: 'Gemini', ms: 1 }));
    await make(false, speak as never).run({ text: 'x' });
    expect(speak).toHaveBeenCalledWith('x', '/out', expect.objectContaining({ format: 'mp3' }));
  });

  it('no speech service: an error the model can pass on', async () => {
    const { run } = make(true, (async () => { throw new Error('No speech service is set up: add an OpenAI key'); }) as never);
    expect(await run({ text: 'x' })).toBe('Error: No speech service is set up: add an OpenAI key');
  });
});
