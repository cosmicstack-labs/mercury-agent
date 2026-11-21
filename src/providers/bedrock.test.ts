import { afterEach, describe, expect, it, vi } from 'vitest';

const { createAmazonBedrockMock, defaultProviderMock } = vi.hoisted(() => ({
  createAmazonBedrockMock: vi.fn(),
  defaultProviderMock: vi.fn(),
}));
vi.mock('@ai-sdk/amazon-bedrock', () => ({ createAmazonBedrock: createAmazonBedrockMock }));
vi.mock('@aws-sdk/credential-provider-node', () => ({ defaultProvider: defaultProviderMock }));

import { BedrockProvider } from './bedrock.js';
import { createProvider } from './registry.js';
import { bedrockCredentialProvider } from './bedrock-auth.js';
import { isProviderConfigured, type ProviderConfig } from '../utils/config.js';
import { fetchProviderModelCatalog } from '../utils/provider-models.js';

const base: ProviderConfig = {
  name: 'bedrock',
  apiKey: '',
  baseUrl: '',
  region: 'us-west-2',
  awsProfile: 'work-sso',
  model: 'us.anthropic.claude-sonnet-4-6',
  enabled: true,
};

const creds = { accessKeyId: 'ASIAEXAMPLE', secretAccessKey: 'secret', sessionToken: 'session' };

afterEach(() => {
  vi.unstubAllGlobals();
  createAmazonBedrockMock.mockReset();
  defaultProviderMock.mockReset();
});

describe('Bedrock provider config', () => {
  it('is configured with a model and no API key, because AWS credentials come from the chain', () => {
    expect(isProviderConfigured(base)).toBe(true);
    expect(isProviderConfigured({ ...base, model: '' })).toBe(false);
    expect(isProviderConfigured({ ...base, enabled: false })).toBe(false);
  });
});

describe('BedrockProvider', () => {
  it('signs with the AWS credential chain when no Bedrock API key is set', () => {
    createAmazonBedrockMock.mockReturnValue(vi.fn(() => ({ modelId: base.model })));
    new BedrockProvider(base);

    const settings = createAmazonBedrockMock.mock.calls[0][0];
    expect(settings.region).toBe('us-west-2');
    expect(typeof settings.credentialProvider).toBe('function');
    expect(settings.apiKey).toBeUndefined();
    expect(settings.baseURL).toBeUndefined();
  });

  it('uses a Bedrock API key instead of SigV4 when one is set', () => {
    createAmazonBedrockMock.mockReturnValue(vi.fn(() => ({ modelId: base.model })));
    new BedrockProvider({ ...base, apiKey: 'bedrock-api-key', baseUrl: 'https://vpce.example.com' });

    const settings = createAmazonBedrockMock.mock.calls[0][0];
    expect(settings.apiKey).toBe('bedrock-api-key');
    expect(settings.credentialProvider).toBeUndefined();
    expect(settings.baseURL).toBe('https://vpce.example.com');
  });
});

describe('provider registry', () => {
  it('builds a BedrockProvider for providers.bedrock', async () => {
    createAmazonBedrockMock.mockReturnValue(vi.fn(() => ({ modelId: base.model })));
    const provider = await createProvider(base);
    expect(provider).toBeInstanceOf(BedrockProvider);
    expect(provider.isAvailable()).toBe(true);
  });
});

describe('bedrockCredentialProvider', () => {
  it('loads the named profile once and reuses the chain, which refreshes on its own', async () => {
    const chain = vi.fn(async () => ({ ...creds, expiration: new Date() }));
    defaultProviderMock.mockReturnValue(chain);

    const resolve = bedrockCredentialProvider(base);
    await expect(resolve()).resolves.toEqual(creds);
    await resolve();

    expect(defaultProviderMock).toHaveBeenCalledOnce();
    expect(defaultProviderMock).toHaveBeenCalledWith({ profile: 'work-sso' });
    expect(chain).toHaveBeenCalledTimes(2);
  });

  it('leaves the profile to the chain (AWS_PROFILE) when none is configured', async () => {
    defaultProviderMock.mockReturnValue(vi.fn(async () => creds));
    await bedrockCredentialProvider({ ...base, awsProfile: '' })();
    expect(defaultProviderMock).toHaveBeenCalledWith({});
  });
});

describe('Bedrock model discovery', () => {
  it('lists active inference profiles first, then on-demand models, with SigV4-signed requests', async () => {
    defaultProviderMock.mockReturnValue(vi.fn(async () => creds));
    const fetchMock = vi.fn(async (url: string) => {
      const body = url.includes('/inference-profiles')
        ? { inferenceProfileSummaries: [
          { inferenceProfileId: 'us.anthropic.claude-sonnet-4-6', status: 'ACTIVE' },
          { inferenceProfileId: 'us.anthropic.claude-retired', status: 'INACTIVE' },
        ] }
        : { modelSummaries: [
          { modelId: 'amazon.nova-pro-v1:0', modelLifecycle: { status: 'ACTIVE' } },
          { modelId: 'anthropic.claude-legacy', modelLifecycle: { status: 'LEGACY' } },
        ] };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const catalog = await fetchProviderModelCatalog('bedrock', base);

    // The catalog lists the recommended model separately from the rest.
    expect(catalog.recommendedModel).toBe('us.anthropic.claude-sonnet-4-6');
    expect(catalog.models).toEqual(['amazon.nova-pro-v1:0']);
    for (const [url, init] of fetchMock.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect(url.startsWith('https://bedrock.us-west-2.amazonaws.com/')).toBe(true);
      const auth = new Headers(init.headers).get('authorization') ?? '';
      expect(auth).toMatch(/^AWS4-HMAC-SHA256 Credential=ASIAEXAMPLE\/\d{8}\/us-west-2\/bedrock\/aws4_request/);
      expect(new Headers(init.headers).get('x-amz-security-token')).toBe('session');
    }
  });

  it('explains a credential failure instead of reporting an empty list', async () => {
    defaultProviderMock.mockReturnValue(vi.fn(async () => {
      throw new Error('The SSO session associated with this profile has expired');
    }));
    vi.stubGlobal('fetch', vi.fn());

    await expect(fetchProviderModelCatalog('bedrock', base)).rejects.toThrow(/aws sso login.*SSO session .* expired/);
  });
});
