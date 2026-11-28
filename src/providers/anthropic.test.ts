import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from './anthropic.js';
import type { ProviderConfig } from '../utils/config.js';
import { fetchProviderModelCatalog } from '../utils/provider-models.js';

const model = 'claude-sonnet-4-20250514';
const config: ProviderConfig = {
  name: 'anthropic',
  apiKey: 'fixture-key',
  baseUrl: '',
  model,
  enabled: true,
};

afterEach(() => vi.unstubAllGlobals());

describe('Anthropic base URL', () => {
  it.each([
    ['https://gateway.example.test/anthropic/', 'https://gateway.example.test/anthropic/v1'],
    ['https://gateway.example.test/v1/', 'https://gateway.example.test/v1'],
    ['', 'https://api.anthropic.com/v1'],
  ])('routes messages and model discovery through the same API root (%s)', async (baseUrl, apiRoot) => {
    const fetchMock = vi.fn(async (...[input]: Parameters<typeof fetch>) => {
      if (String(input).endsWith('/models')) {
        return Response.json({ data: [{ id: model }] });
      }
      return Response.json({
        id: 'msg_fixture',
        type: 'message',
        role: 'assistant',
        model,
        content: [{ type: 'text', text: 'fixture response' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 2, output_tokens: 2 },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const providerConfig = { ...config, baseUrl };
    const provider = new AnthropicProvider(providerConfig);
    await expect(provider.generateText('Reply', 'Be brief.')).resolves.toMatchObject({ text: 'fixture response' });
    await expect(fetchProviderModelCatalog('anthropic', providerConfig)).resolves.toMatchObject({ recommendedModel: model });
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      `${apiRoot}/messages`,
      `${apiRoot}/models`,
    ]);
    expect(fetchMock.mock.calls.map(([, init]) => init?.redirect)).toEqual(['error', 'error']);
  });
});
