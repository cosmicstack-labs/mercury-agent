import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchProviderModelCatalog } from './provider-models.js';
import type { ProviderConfig } from './config.js';

const config: ProviderConfig = {
  name: 'aimlapi',
  apiKey: 'k',
  baseUrl: 'https://api.aimlapi.com/v1',
  model: 'anthropic/claude-sonnet-4.6',
  enabled: true,
};

// Shaped like the real listing: one row per surface, ids repeated across them,
// and not a single id that looks like an OpenAI model name.
const payload = {
  data: [
    { id: 'anthropic/claude-sonnet-4.6', type: 'openai/chat-completions' },
    { id: 'anthropic/claude-sonnet-4.6', type: 'anthropic/batches' },
    { id: 'anthropic/claude-sonnet-4.6', type: 'anthropic/messages' },
    { id: 'deepseek/deepseek-chat', type: 'openai/chat-completions' },
    { id: 'google/veo-3', type: 'internal/video-generations/submit' },
    { id: 'openai/dall-e-3', type: 'openai/image-generations' },
    { id: 'elevenlabs/tts', type: 'internal/text-to-speech' },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe('AI/ML API model discovery', () => {
  it('keeps the chat surface, collapses the repeats, drops the rest', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), {
      status: 200, headers: { 'content-type': 'application/json' },
    })));

    const catalog = await fetchProviderModelCatalog('aimlapi', config);
    const all = [catalog.recommendedModel, ...catalog.models];

    expect(all).toContain('anthropic/claude-sonnet-4.6');
    expect(all).toContain('deepseek/deepseek-chat');
    expect(all).toHaveLength(2);
    expect(all).not.toContain('google/veo-3');
    expect(all).not.toContain('openai/dall-e-3');
  });

  it('does not fall back to the id-text rule, which empties this catalogue', async () => {
    // The bug this replaces: the default filter accepts `gpt-*` and `o<digit>`
    // only, so every namespaced id was dropped and the UI reported "could not
    // find any supported chat models" against a listing that had 353 of them.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'alibaba/qwen3.8-max', type: 'openai/chat-completions' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    const catalog = await fetchProviderModelCatalog('aimlapi', config);
    expect([catalog.recommendedModel, ...catalog.models]).toContain('alibaba/qwen3.8-max');
  });
});
