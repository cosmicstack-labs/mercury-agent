import { describe, expect, it } from 'vitest';
import {
  LEGACY_SEED_API_URL,
  LEGACY_SEED_WS_URL,
  MERCURY_CLOUD_API_URL,
  MERCURY_CLOUD_WS_URL,
} from '../cloud/endpoints.js';
import { getDefaultConfig, normalizeCloudConfig } from './config.js';

describe('Mercury Cloud endpoint defaults', () => {
  it('seeds the production backend API and WebSocket endpoints', () => {
    const previousApiUrl = process.env.MERCURY_CLOUD_API_URL;
    const previousWsUrl = process.env.MERCURY_CLOUD_WS_URL;
    delete process.env.MERCURY_CLOUD_API_URL;
    delete process.env.MERCURY_CLOUD_WS_URL;
    const config = getDefaultConfig();
    if (previousApiUrl === undefined) delete process.env.MERCURY_CLOUD_API_URL;
    else process.env.MERCURY_CLOUD_API_URL = previousApiUrl;
    if (previousWsUrl === undefined) delete process.env.MERCURY_CLOUD_WS_URL;
    else process.env.MERCURY_CLOUD_WS_URL = previousWsUrl;

    expect(config.cloud.apiUrl).toBe(MERCURY_CLOUD_API_URL);
    expect(config.cloud.wsUrl).toBe(MERCURY_CLOUD_WS_URL);
  });

  it('migrates only the obsolete seeded endpoints', () => {
    const config = getDefaultConfig();
    config.cloud.apiUrl = LEGACY_SEED_API_URL;
    config.cloud.wsUrl = LEGACY_SEED_WS_URL;

    normalizeCloudConfig(config);

    expect(config.cloud.apiUrl).toBe(MERCURY_CLOUD_API_URL);
    expect(config.cloud.wsUrl).toBe(MERCURY_CLOUD_WS_URL);
    expect(config.providers.mercuryCloud.baseUrl).toBe(MERCURY_CLOUD_API_URL);
  });

  it('preserves custom self-hosted endpoints', () => {
    const config = getDefaultConfig();
    config.cloud.apiUrl = 'https://mercury.example.com';
    config.cloud.wsUrl = 'wss://mercury.example.com/custom-ws';

    normalizeCloudConfig(config);

    expect(config.cloud.apiUrl).toBe('https://mercury.example.com');
    expect(config.cloud.wsUrl).toBe('wss://mercury.example.com/custom-ws');
  });
});
