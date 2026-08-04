import { describe, expect, it, vi } from 'vitest';
import type { CloudTokenStore } from '../cloud/token-store.js';

const { createOpenAIMock } = vi.hoisted(() => ({ createOpenAIMock: vi.fn() }));
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: createOpenAIMock }));

import { MercuryCloudProvider } from './mercury-cloud.js';

describe('MercuryCloudProvider authentication', () => {
  it('uses the shared agent credentials and releases its token listener', () => {
    const removeListener = vi.fn();
    const store = {
      getJwt: vi.fn(() => 'jwt-1'),
      getAgentId: vi.fn(() => 'agent-1'),
      getAgentApiKey: vi.fn(() => 'mcapk_1'),
      addListener: vi.fn(() => removeListener),
    } as unknown as CloudTokenStore;
    const languageModel = vi.fn(() => ({ modelId: 'mercury-flash' }));
    createOpenAIMock.mockReturnValue({ chat: languageModel });

    const provider = new MercuryCloudProvider({
      name: 'mercuryCloud',
      apiKey: 'stale-jwt',
      baseUrl: 'https://api.example.com',
      model: 'mercury-flash',
      enabled: true,
    }, store);

    expect(createOpenAIMock).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: 'jwt-1',
      headers: {
        'X-Agent-Id': 'agent-1',
      },
    }));

    provider.destroy();
    expect(removeListener).toHaveBeenCalledOnce();
  });
});
