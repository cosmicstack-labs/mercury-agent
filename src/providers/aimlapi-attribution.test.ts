import { describe, it, expect } from 'vitest';
import { aimlapiHeaders, isAimlapiBaseUrl, AIMLAPI_BASE_URL } from './aimlapi-attribution.js';

describe('AI/ML API attribution', () => {
  it('sends the four headers for the default base URL', () => {
    const headers = aimlapiHeaders(AIMLAPI_BASE_URL);
    expect(headers).toEqual({
      'X-AIMLAPI-Partner-ID': expect.stringMatching(/^part_[A-Za-z0-9]{1,64}$/),
      'X-AIMLAPI-Source': 'agent/mercury-agent',
      'HTTP-Referer': 'https://github.com/cosmicstack-labs/mercury-agent',
      'X-Title': 'Mercury Agent',
    });
  });

  it('keeps sending them when the user trims or extends the path', () => {
    for (const url of [
      'https://api.aimlapi.com',
      'https://api.aimlapi.com/',
      'https://api.aimlapi.com/v1/',
      'https://API.AIMLAPI.COM/v1',
    ]) {
      expect(aimlapiHeaders(url), url).toBeDefined();
    }
  });

  it('sends nothing to a lookalike host', () => {
    // The reason this is a test and not a comment: AI/ML API serves a request
    // with someone else's partner id normally, so leaking one is silent.
    for (const url of [
      'https://api.aimlapi.com.example.test/v1',
      'https://not-api.aimlapi.com/v1',
      'https://example.test/?next=https://api.aimlapi.com/v1',
      'https://example.test/api.aimlapi.com/v1',
    ]) {
      expect(aimlapiHeaders(url), url).toBeUndefined();
      expect(isAimlapiBaseUrl(url), url).toBe(false);
    }
  });

  it('sends nothing to the other providers this class serves', () => {
    for (const url of [
      'https://api.openai.com/v1',
      'https://api.deepseek.com/v1',
      'http://localhost:11434/v1',
      '',
      'not a url',
    ]) {
      expect(aimlapiHeaders(url), url).toBeUndefined();
    }
  });
});
