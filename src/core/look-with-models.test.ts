import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('ai', async (orig) => ({ ...(await orig<typeof import('ai')>()), generateText: vi.fn() }));
import { generateText } from 'ai';
import { lookWithOwnModels, setLookRegistry } from './look-with-models.js';

const mocked = vi.mocked(generateText);
const provider = (name: string, model: string, vision?: boolean) => ({ name, getModel: () => model, seesImages: vision, getModelInstance: () => ({ name }) });
const registryOf = (list: ReturnType<typeof provider>[], unusable: string[] = []) => ({
  hasProviders: () => list.length > 0,
  isUsable: (n: string) => !unusable.includes(n),
  getFallbackIterator: () => list[Symbol.iterator](),
}) as never;
const image = { data: new Uint8Array([1, 2, 3]), mimeType: 'image/png' };

afterEach(() => { setLookRegistry(null); mocked.mockReset(); });

describe('lookWithOwnModels: whatever providers the owner set up', () => {
  it('uses the default first and skips models that cannot see images', async () => {
    setLookRegistry(registryOf([provider('deepseek', 'deepseek-chat'), provider('ollamaLocal', 'qwen2.5-vl:7b'), provider('openrouter', 'anthropic/claude-sonnet-4.6')]));
    mocked.mockResolvedValueOnce({ text: ' xk2p9 ' } as never);
    const r = await lookWithOwnModels({ prompt: 'Read the CAPTCHA', image });
    expect(r).toEqual({ text: 'xk2p9', provider: 'ollamaLocal', model: 'qwen2.5-vl:7b' });
    expect(mocked).toHaveBeenCalledTimes(1);
  });

  it('falls through to the next provider when one fails, and honours a declared vision flag', async () => {
    setLookRegistry(registryOf([provider('litellm', 'my-private-model', true), provider('openai', 'gpt-5.6')]));
    mocked.mockRejectedValueOnce(new Error('500')).mockResolvedValueOnce({ text: 'ab12' } as never);
    expect(await lookWithOwnModels({ prompt: 'Read', image })).toMatchObject({ text: 'ab12', provider: 'openai' });
  });

  it('null when nothing can see images, or no providers', async () => {
    setLookRegistry(registryOf([provider('deepseek', 'deepseek-chat')]));
    expect(await lookWithOwnModels({ prompt: 'Read', image })).toBeNull();
    setLookRegistry(null);
    expect(await lookWithOwnModels({ prompt: 'Read', image })).toBeNull();
    expect(mocked).not.toHaveBeenCalled();
  });
});
