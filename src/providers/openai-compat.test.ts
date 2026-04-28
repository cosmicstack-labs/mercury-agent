import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderConfig } from '../utils/config.js';

const {
  chatModel,
  responsesModel,
  chatMock,
  defaultModelMock,
  createOpenAIMock,
} = vi.hoisted(() => {
  const chatModel = { transport: 'chat' };
  const responsesModel = { transport: 'responses' };
  const chatMock = vi.fn(() => chatModel);
  const defaultModelMock = vi.fn(() => responsesModel);
  const createOpenAIMock = vi.fn(() =>
    Object.assign(defaultModelMock, {
      chat: chatMock,
    }),
  );

  return {
    chatModel,
    responsesModel,
    chatMock,
    defaultModelMock,
    createOpenAIMock,
  };
});

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: createOpenAIMock,
}));

import { OpenAICompatProvider } from './openai-compat.js';

const config: ProviderConfig = {
  name: 'openai',
  apiKey: 'test-key',
  baseUrl: 'https://example.com/v1',
  model: 'test-model',
  enabled: true,
};

describe('OpenAICompatProvider', () => {
  beforeEach(() => {
    createOpenAIMock.mockClear();
    defaultModelMock.mockClear();
    chatMock.mockClear();
  });

  it('builds a chat completions model instead of the default responses model', () => {
    const provider = new OpenAICompatProvider(config);

    expect(createOpenAIMock).toHaveBeenCalledWith({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    });
    expect(chatMock).toHaveBeenCalledWith(config.model);
    expect(defaultModelMock).not.toHaveBeenCalled();
    expect(provider.getModelInstance()).toBe(chatModel);
  });
});
